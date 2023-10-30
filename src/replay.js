import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
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

// live host processes, reaped on SIGINT/SIGTERM. detached children get
// their own process group (-pid); plain children are killed directly.
const liveProcs = new Set();

function reapLive() {
  for (const proc of liveProcs) {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }
  liveProcs.clear();
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
    liveProcs.add(proc);
    const drop = () => liveProcs.delete(proc);
    // answer "y" once so npx-style install prompts behave like a real user
    // pressing enter; stdin then closes so nothing blocks on it.
    // a step that exits before we write raises EPIPE on the socket -
    // unhandled, that kills the whole run
    proc.stdin.on("error", () => {});
    proc.stdin.write("y\n");
    proc.stdin.end();
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      drop();
      clearTimeout(timer);
      resolveP({ ...r, out, err, ms: Date.now() - t0 });
    };
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      if (keepAlive) {
        // servers stay up so later steps (curl localhost:...) can hit them;
        // the process group is reaped on transition or when the replay ends
        try { proc.unref(); } catch {}
        drop();
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

const SERVER_TIMEOUT = 15_000;
const STEP_TIMEOUT = 240_000;

export async function replay(steps, opts) {
  const {
    cloneDir,
    isServerish,
    classifyStep,
    keepGoing = false,
    repoName = null,
  } = opts;

  // `export KEY=value` steps build a session env that later steps inherit,
  // which is how a README's "set this, then run that" sequence is meant to go
  const env = {};
  let cwd = cloneDir;
  const results = [];
  let stopped = false;

  // backgrounded servers get reaped so a second server can't EADDRINUSE on
  // the first one's port
  const daemons = [];
  const reapDaemons = () => {
    for (let i = daemons.length - 1; i >= 0; i--) {
      const d = daemons[i];
      try {
        if (d.pid) process.kill(-d.pid, "SIGKILL");
      } catch {}
      daemons.splice(i, 1);
    }
  };

  const onSig = () => {
    reapLive();
    reapDaemons();
    process.exit(130);
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

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
      if (stopped) {
        results.push({ ...step, status: "skip", why: "after failure" });
        continue;
      }