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

const STEP_TIMEOUT = 240_000;

// Run one shell command in the staged clone and report what happened.
function runOnce(cmd, { cwd, timeoutMs }) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
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
  const { cloneDir, keepGoing = false } = opts;

  let cwd = cloneDir;
  const results = [];
  let stopped = false;

  for (const step of steps) {
    if (stopped) {
      results.push({ ...step, status: "skip", why: "after failure" });
      continue;
    }

    // `cd` steps move the session for everything that follows
    const cdTo = step.cmd.match(/^cd\s+([^\s;&|]+)$/)?.[1];
    if (cdTo) {
      const next = resolve(cwd, cdTo);
      if (next.startsWith(cloneDir) && existsSync(next)) {
        cwd = next;
        results.push({ ...step, status: "cd", why: cwd.slice(cloneDir.length) || "/" });
      } else {
        results.push({ ...step, status: "fail", why: "no such dir" });
        stopped = !keepGoing;
      }
      continue;
    }

    const r = await runOnce(step.cmd, { cwd, timeoutMs: STEP_TIMEOUT });
    let status;
    if (r.timedOut) status = "timeout";
    else if (r.code === 0) status = "ok";
    else status = "fail";

    results.push({
      ...step,
      status,
      ms: r.ms,
      code: r.code,
      tail: (r.err || r.out || "").trim().split("\n").slice(-4).join("\n"),
    });
    if (status === "fail" || status === "timeout") stopped = !keepGoing;
  }

  return { results };
}
