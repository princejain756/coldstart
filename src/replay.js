import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const STEP_TIMEOUT = 240_000;

// Run one shell command in the staged clone and report what happened.
function runOnce(cmd, { cwd, env, timeoutMs }) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    proc.on("close", (code) => finish({ code, timedOut: false }));
    proc.on("error", () => finish({ code: 127, timedOut: false }));
  });
}

export async function replay(steps, opts) {
  const { cloneDir, classifyStep, keepGoing = false } = opts;

  // `export KEY=value` steps build a session env that later steps inherit,
  // which is how a README's "set this, then run that" sequence is meant to go
  const env = {};
  let cwd = cloneDir;
  const results = [];
  let stopped = false;

  const doCd = (target) => {
    const clean = target.replace(/^["']|["']$/g, "");
    const next = resolve(cwd, clean);
    const inside = next === cloneDir || next.startsWith(cloneDir + "/");
    const finalDir = inside ? next : cloneDir;
    const ok = existsSync(finalDir);
    if (ok) cwd = finalDir;
    return { ok, at: cwd.slice(cloneDir.length) || "/" };
  };

  for (const step of steps) {
    let { cmd } = step;
    if (stopped) {
      results.push({ ...step, status: "skip", why: "after failure" });
      continue;
    }

    const assign = parseAssignment(cmd);
    if (assign) {
      env[assign.name] = assign.singleQuoted
        ? assign.value
        : expandVars(assign.value, env);
      results.push({ ...step, status: "env", value: assign.name });
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
        stopped = !keepGoing;
        cmd = null;
        break;
      }
      results.push({ ...step, cmd: `cd ${(cdThen || cdOnly)[1]}`, status: "cd", why: at });
      if (cdOnly) {
        cmd = null;
        break;
      }
      cmd = cdThen[2];
    }
    if (cmd === null) continue;