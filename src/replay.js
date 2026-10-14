import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "venv",
  "__pycache__", ".turbo", ".cache", "target", "coverage", ".idea", ".vscode",
]);

function ignored(dir) {
  // respect .gitignore patterns loosely: always skip heavy dirs, plus
  // dotenv-style files a clone would never contain
  return IGNORED_DIRS.has(dir) || /^\.env($|\.)/.test(dir);
}

export function stageClone(target) {
  const tmp = mkdtempSync(join(tmpdir(), "coldstart-"));
  const dest = join(tmp, "repo");
  const isUrl = /^(https?:\/\/|git@)/.test(target);

  if (isUrl) {
    const r = spawnSync("git", ["clone", "--depth", "1", target, dest], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`git clone failed: ${(r.stderr || r.stdout).slice(-400)}`);
    }
    return { dir: dest, tmp, how: "git clone (depth 1)", uncommitted: 0 };
  }

  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`no such path: ${abs}`);

  if (existsSync(join(abs, ".git"))) {
    // clone the committed state: exactly what a new user gets
    const r = spawnSync("git", ["clone", "--depth", "1", `file://${abs}`, dest], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`git clone failed: ${(r.stderr || r.stdout).slice(-400)}`);
    }
    let uncommitted = 0;
    try {
      const status = execFileSync("git", ["-C", abs, "status", "--porcelain"], {
        encoding: "utf8",
      });
      uncommitted = status.split("\n").filter(Boolean).length;
    } catch {}
    return { dir: dest, tmp, how: "git clone of committed state", uncommitted };
  }

  // not a git repo: copy the working tree minus ignored dirs
  cpSync(abs, dest, {
    recursive: true,
    filter: (src) => !ignored(src.split("/").pop()),
  });
  return { dir: dest, tmp, how: "copy of working dir (not a git repo)", uncommitted: 0 };
}

const ASSIGN_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const CD_RE = /^cd\s+(.+)$/;

function parseAssignment(cmd) {
  const m = cmd.match(ASSIGN_RE);
  if (!m) return null;
  const val = m[2].trim().replace(/^["']|["']$/g, "");
  return { name: m[1], value: val };
}

function runOnce(cmd, { cwd, env, timeoutMs }) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // answer "y" once so npx-style install prompts behave like a real user
    // pressing enter; stdin then closes so nothing blocks on it
    proc.stdin.write("y\n");
    proc.stdin.end();
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolveP({ code: null, timedOut: true, out, err, ms: Date.now() - t0 });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, timedOut: false, out, err, ms: Date.now() - t0 });
    });
  });
}

function dockerWrap(cmd, { cwd, env, image, cloneDir }) {
  const rel = cwd.startsWith(cloneDir) ? cwd.slice(cloneDir.length) : "";
  const workdir = "/repo" + rel;
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
    .join(" ");
  return [
    "docker",
    [
      "run", "--rm", "--network", "bridge",
      "-v", `${cloneDir}:/repo`, "-w", workdir,
      image, "sh", "-lc", `${exports} ${cmd}`,
    ],
  ];
}

function runDocker(cmd, opts) {
  const [bin, args] = dockerWrap(cmd, opts);
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolveP({ code: null, timedOut: true, out, err, ms: Date.now() - t0 });
    }, opts.timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, timedOut: false, out, err, ms: Date.now() - t0 });
    });
  });
}

export function defaultDockerImage(dir) {
  if (existsSync(join(dir, "package.json"))) return "node:22-bookworm-slim";
  if (
    existsSync(join(dir, "requirements.txt")) ||
    existsSync(join(dir, "pyproject.toml"))
  )
    return "python:3.12-slim";
  if (existsSync(join(dir, "go.mod"))) return "golang:1.23-bookworm";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust:1-slim-bookworm";
  return null;
}

const SERVER_TIMEOUT = 15_000;
const STEP_TIMEOUT = 240_000;

// `npx <this-repo's-own-package>` inside the clone resolves the unbuilt local
// package, but a real user runs it from their own project - force registry
function selfPackageNames(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const names = new Set([pkg.name].filter(Boolean));
    const bins =
      typeof pkg.bin === "string" ? [pkg.name] : Object.keys(pkg.bin ?? {});
    bins.forEach((b) => names.add(b));
    return names;
  } catch {
    return new Set();
  }
}

function rewriteSelfNpx(cmd, selfNames) {
  return cmd.replace(
    /\bnpx\s+(-[a-zA-Z-]+\s+)*(@?[\w./~-][\w./-]*)/g,
    (full, flags, spec) => {
      const bare = spec.replace(/^@/, "").split("/")[0];
      const base = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : bare;
      if (selfNames.has(base) && !spec.includes("@", spec.startsWith("@") ? 1 : 0)) {
        return `npx ${flags ?? ""}${base}@latest`;
      }
      return full;
    }
  );
}

export async function replay(steps, opts) {
  const {
    cloneDir,
    isServerish,
    classifyStep,
    docker = null,
    keepGoing = false,
    onStep = () => {},
  } = opts;

  const env = {};
  const selfNames = selfPackageNames(cloneDir);
  let cwd = cloneDir;
  const results = [];
  let stopped = false;

  for (const step of steps) {
    let { cmd } = step;
    const rewritten = rewriteSelfNpx(cmd, selfNames);
    const note = rewritten !== cmd ? "runs as registry package (what a user gets)" : null;
    cmd = rewritten;
    if (stopped) {
      results.push({ ...step, status: "skip", why: "after failure" });
      onStep(results.at(-1));
      continue;
    }

    const assign = parseAssignment(cmd);
    if (assign && !/\s/.test(cmd.replace(/^export\s+/, ""))) {
      env[assign.name] = assign.value;
      results.push({ ...step, status: "env", value: assign.name });
      onStep(results.at(-1));
      continue;
    }

    const cd = cmd.match(CD_RE);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, "");
      const next = isAbsolute(target)
        ? target
        : resolve(cwd, target);
      const inside = next.startsWith(cloneDir);
      cwd = inside ? next : cloneDir;
      results.push({
        ...step,
        status: existsSync(cwd) ? "cd" : "fail",
        why: existsSync(cwd) ? cwd.slice(cloneDir.length) || "/" : `no such dir`,
      });
      onStep(results.at(-1));
      if (!existsSync(cwd)) stopped = !keepGoing;
      continue;
    }

    const cls = step.skipWhy ? { run: false, why: step.skipWhy } : classifyStep(cmd);
    if (!cls.run) {
      results.push({ ...step, status: "skip", why: cls.why });
      onStep(results.at(-1));
      continue;
    }

    const serverish = isServerish(cmd);
    const timeoutMs = serverish ? SERVER_TIMEOUT : STEP_TIMEOUT;
    const r = docker
      ? await runDocker(cmd, { cwd, env, image: docker, cloneDir, timeoutMs })
      : await runOnce(cmd, { cwd, env, timeoutMs });

    let status;
    let why = null;
    if (r.timedOut && serverish) status = "started";
    else if (r.timedOut) status = "timeout";
    else if (r.code === 0) status = "ok";
    else if (r.code === 127) {
      status = "skip";
      const bin = cmd.match(/^\s*(\S+)/)?.[1];
      why = `\`${bin}\` not installed on this machine`;
    } else status = "fail";

    results.push({
      ...step,
      cmd,
      origCmd: note ? step.cmd : undefined,
      status,
      ms: r.ms,
      code: r.code,
      tail: (r.err || r.out || "").trim().split("\n").slice(-4).join("\n"),
      serverish,
      note,
      why,
    });
    onStep(results.at(-1));
    if (status === "fail" || status === "timeout") stopped = !keepGoing;
  }
  return { results, env };
}
