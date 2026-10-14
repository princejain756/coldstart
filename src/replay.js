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

  // not a git repo: copy the working tree minus ignored dirs (the root
  // itself always copies - a repo literally named `build` still works)
  cpSync(abs, dest, {
    recursive: true,
    filter: (src) => src === abs || !ignored(src.split("/").pop()),
  });
  return { dir: dest, tmp, how: "copy of working dir (not a git repo)", uncommitted: 0 };
}

const ASSIGN_RE =
  /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(("([^"]*)")|('([^']*)')|[^\s]+)\s*$/;
const CD_RE = /^cd\s+([^\s;&|]+)\s*$/;
const CD_THEN_RE = /^cd\s+([^\s;&|]+)\s*(?:&&|;)\s*(.+)$/;
// KEY=VAL prefixes and sudo before the real command
const LEAD_PREFIX_RE = /^(?:sudo\s+|[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/;

function expandVars(val, env) {
  return val.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) =>
    env[name] ?? process.env[name] ?? ""
  );
}

function parseAssignment(cmd) {
  const clean = cmd.replace(/\s+#.*$/, ""); // trailing comment
  if (/\$\(|`/.test(clean)) return null; // command substitution: run in shell
  const m = clean.match(ASSIGN_RE);
  if (!m) return null;
  const raw = m[3] ?? m[5] ?? m[2];
  return { name: m[1], value: raw, singleQuoted: m[5] != null };
}

// 127 means "command not found" - but WHICH command matters. `npm run build`
// propagating a missing vite is a broken README, `nix run` with no nix
// installed is an environment gap. Path-like tokens (./scripts/x.sh) missing
// are always repo failures, never env gaps.
function missingBinary(cmd, output, exists) {
  const rawFirst = cmd
    .replace(LEAD_PREFIX_RE, "")
    .match(/^(\S+)/)?.[1];
  if (!rawFirst) return { first: "", firstMissing: false };
  if (rawFirst.includes("/")) return { first: rawFirst, firstMissing: false };
  const hits = [
    ...output.matchAll(/([\w./~+-]+):\s*(?:command\s+)?not found/gi),
  ];
  const rawMissing = hits.at(-1)?.[1];
  if (rawMissing && rawMissing.includes("/"))
    return { first: rawFirst, missing: rawMissing, firstMissing: false };
  const missing = rawMissing?.split("/").pop();
  const firstMissing = missing ? missing === rawFirst : !exists(rawFirst);
  return { first: rawFirst, missing, firstMissing };
}

function hostExists(bin) {
  const r = spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin], {
    stdio: "pipe",
  });
  return r.status === 0;
}

function runOnce(cmd, { cwd, env, timeoutMs, keepAlive, onOrphan }) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    // detached: own process group, so a timeout can kill the server the
    // command spawned, not just the sh wrapper
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    // answer "y" once so npx-style install prompts behave like a real user
    // pressing enter; stdin then closes so nothing blocks on it
    proc.stdin.write("y\n");
    proc.stdin.end();
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ ...r, out, err, ms: Date.now() - t0 });
    };
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      if (keepAlive) {
        // servers stay up so later steps (curl localhost:...) can hit them;
        // the process group is reaped when the replay ends
        try { proc.unref(); } catch {}
        onOrphan?.(proc.pid);
        finish({ code: null, timedOut: true });
        return;
      }
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try { proc.kill("SIGKILL"); } catch {}
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    proc.on("close", (code) => finish({ code, timedOut: false }));
    proc.on("error", () => finish({ code: 127, timedOut: false }));
  });
}

// one long-lived container per replay so installs in earlier steps survive
// into later ones - docker run --rm per step loses pip/apt installs between
// commands
export function dockerSession(image, cloneDir) {
  const name = `coldstart-${process.pid}-${Date.now().toString(36)}`;
  const r = spawnSync(
    "docker",
    [
      "run", "-d", "--init", "--rm", "--network", "bridge",
      "--name", name, "-v", `${cloneDir}:/repo`, "-w", "/repo",
      image, "sleep", "infinity",
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`docker run failed: ${(r.stderr || r.stdout || "").slice(-300)}`);
  }
  const cleanup = () => {
    // root-owned files in /repo would break rmSync(tmp) on Linux - wipe first
    spawnSync("docker", ["exec", name, "sh", "-c", "rm -rf /repo/* /repo/.[!.]* 2>/dev/null || true"], { stdio: "ignore" });
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  };
  const onSig = () => { cleanup(); process.exit(130); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  return {
    name,
    dispose() {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
      cleanup();
    },
  };
}

function dockerExecArgs(cmd, { cwd, env, cloneDir, name }) {
  const rel = cwd.startsWith(cloneDir) ? cwd.slice(cloneDir.length) : "";
  const workdir = "/repo" + rel;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["exec", "-w", workdir, ...envArgs, name, "sh", "-lc", cmd];
}

function runDocker(cmd, opts) {
  const args = dockerExecArgs(cmd, opts);
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ ...r, out, err, ms: Date.now() - t0 });
    };
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      // killing the client detaches but the container keeps running - which
      // for server steps is exactly right (later steps can still curl it)
      proc.kill("SIGKILL");
      finish({ code: null, timedOut: true });
    }, opts.timeoutMs);
    proc.on("close", (code) => finish({ code, timedOut: false }));
    proc.on("error", () => finish({ code: 127, timedOut: false }));
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
// package, but a real user runs it from their own project - force registry.
// Private/unpublished packages can't resolve @latest: run the local bin so
// the README's intent is still exercised against the checked-out source.
function selfPackageMap(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const map = new Map();
    const bins =
      typeof pkg.bin === "string" ? [pkg.name] : Object.keys(pkg.bin ?? {});
    const binFile =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[bins[0]];
    const local = binFile
      ? `"${join(dir, binFile).replace(/"/g, "")}"`
      : null;
    if (pkg.name) map.set(pkg.name, { pkg: pkg.name, local });
    bins.forEach((b) => pkg.name && map.set(b, { pkg: pkg.name, local }));
    return { map, private: !!pkg.private };
  } catch {
    return { map: new Map(), private: false };
  }
}

function rewriteSelfNpx(cmd, selfMap, isPrivate) {
  return cmd.replace(
    /\bnpx\s+(-[a-zA-Z-]+\s+)*(@?[\w./~-][\w./-]*)/g,
    (full, flags, spec) => {
      const bare = spec.replace(/^@/, "").split("/")[0];
      const base = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : bare;
      const hit = selfMap.get(base);
      if (!hit || spec.includes("@", spec.startsWith("@") ? 1 : 0)) return full;
      if (isPrivate && hit.local) return hit.local;
      return `npx ${flags ?? ""}${hit.pkg}@latest`;
    }
  );
}

export async function replay(steps, opts) {
  const {
    cloneDir,
    isServerish,
    classifyStep,
    blocker = null,
    docker = null,
    keepGoing = false,
    repoName = null,
    onStep = () => {},
  } = opts;

  const env = {};
  const { map: selfMap, private: selfPrivate } = selfPackageMap(cloneDir);
  let cwd = cloneDir;
  const results = [];
  let stopped = false;
  const dockerSess = docker ? dockerSession(docker, cloneDir) : null;

  const daemonPids = []; // servers kept alive for later steps, reaped at end

  const doCd = (target) => {
    const clean = target.replace(/^["']|["']$/g, "");
    let next = isAbsolute(clean) ? clean : resolve(cwd, clean);
    // `cd <repo>` at the top of a README means "into the repo you cloned" -
    // our staged clone already IS that directory
    if (!existsSync(next) && clean === repoName) next = cloneDir;
    const inside = next === cloneDir || next.startsWith(cloneDir + "/");
    const finalDir = inside ? next : cloneDir;
    const ok = existsSync(finalDir);
    if (ok) cwd = finalDir;
    return { ok, at: cwd.slice(cloneDir.length) || "/" };
  };

  try {
    for (const step of steps) {
      let { cmd } = step;
      const rewritten = rewriteSelfNpx(cmd, selfMap, selfPrivate);
      const note =
        rewritten !== cmd
          ? selfPrivate
            ? "runs local bin (private package, registry version impossible)"
            : "runs as registry package (what a user gets)"
          : null;
      cmd = rewritten;
      if (stopped) {
        results.push({ ...step, status: "skip", why: "after failure" });
        onStep(results.at(-1));
        continue;
      }

      if (step.directive?.ignore) {
        results.push({ ...step, status: "skip", why: "coldstart:ignore" });
        onStep(results.at(-1));
        continue;
      }
      if (step.directive?.env) Object.assign(env, step.directive.env);

      const assign = parseAssignment(cmd);
      if (assign) {
        env[assign.name] = assign.singleQuoted
          ? assign.value
          : expandVars(assign.value, env);
        results.push({ ...step, status: "env", value: assign.name });
        onStep(results.at(-1));
        continue;
      }

      // peel every leading `cd x &&` - `cd a && cd b && cmd` chains work
      for (;;) {
        const cdThen = cmd.match(CD_THEN_RE);
        const cdOnly = cmd.match(CD_RE);
        if (!cdThen && !cdOnly) break;
        const { ok, at } = doCd((cdThen || cdOnly)[1]);
        if (!ok) {
          results.push({ ...step, status: "fail", why: "no such dir" });
          onStep(results.at(-1));
          stopped = !keepGoing;
          cmd = null;
          break;
        }
        results.push({ ...step, cmd: `cd ${(cdThen || cdOnly)[1]}`, status: "cd", why: at });
        onStep(results.at(-1));
        if (cdOnly) { cmd = null; break; }
        cmd = cdThen[2];
      }
      if (cmd === null) continue;

      const whyBlock = blocker ? blocker(cwd, cmd) : step.skipWhy;
      const cls = whyBlock ? { run: false, why: whyBlock } : classifyStep(cmd);
      if (!cls.run) {
        results.push({ ...step, status: "skip", why: cls.why });
        onStep(results.at(-1));
        continue;
      }

      const serverish = isServerish(cmd) || !!step.directive?.daemon;
      const timeoutMs = serverish ? SERVER_TIMEOUT : STEP_TIMEOUT;
      const r = dockerSess
        ? await runDocker(cmd, { cwd, env, cloneDir, name: dockerSess.name, timeoutMs })
        : await runOnce(cmd, {
            cwd,
            env,
            timeoutMs,
            keepAlive: serverish,
            onOrphan: (pid) => daemonPids.push(pid),
          });

      let status;
      let why = null;
      if (r.timedOut && serverish) status = "started";
      else if (r.timedOut) status = "timeout";
      else if (r.code === 0) status = "ok";
      else if (r.code === 127) {
        const exists = (bin) =>
          dockerSess
            ? spawnSync("docker", ["exec", dockerSess.name, "sh", "-lc", 'command -v "$1"', "sh", bin], { stdio: "pipe" }).status === 0
            : hostExists(bin);
        const { first, missing, firstMissing } = missingBinary(cmd, r.err + r.out, exists);
        if (!firstMissing) {
          status = "fail"; // the README's own command chain broke inside
        } else {
          status = "skip";
          why = `\`${first}\` not installed on this machine`;
        }
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
  } finally {
    // daemon servers kept alive for later steps get reaped now
    for (const pid of daemonPids) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    dockerSess?.dispose();
  }
  return { results, env };
}
