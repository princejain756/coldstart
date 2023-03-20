#!/usr/bin/env node
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { readReadme, extractSteps } from "../src/readme.js";
import { staticChecks } from "../src/checks.js";
import { stageClone, replay } from "../src/replay.js";

const HELP = `coldstart - does your repo pass a fresh clone?

usage:
  coldstart [path-or-git-url]     replay the README in a clean checkout
  coldstart --help

options:
  --only-static   run the checks, skip executing anything
  --keep-going    don't stop at the first failure
  -h, --help
`;

const args = { target: null, onlyStatic: false, keepGoing: false };
const argv = process.argv.slice(2);
for (const a of argv) {
  if (a === "--help" || a === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "--only-static") args.onlyStatic = true;
  else if (a === "--keep-going") args.keepGoing = true;
  else if (!a.startsWith("-") && !args.target) args.target = a;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

const target = args.target ?? process.cwd();
let staged;
try {
  staged = stageClone(target);
} catch (e) {
  console.error(`coldstart: ${e.message}`);
  process.exit(2);
}

const { dir: cloneDir, tmp, how } = staged;
try {
  const readme = readReadme(cloneDir);
  if (!readme) {
    console.error(`coldstart: no README found in ${target} - nothing to replay`);
    process.exit(2);
  }
  const { steps } = extractSteps(readme.text);
  if (!steps.length) {
    console.error(
      `coldstart: ${readme.name} has no shell code blocks - nothing to replay`
    );
    process.exit(2);
  }

  const findings = staticChecks(cloneDir, steps);
  let results = [];
  if (!args.onlyStatic) {
    ({ results } = await replay(steps, { cloneDir, keepGoing: args.keepGoing }));
  }

  console.log("");
  console.log("coldstart - fresh-clone replay");
  console.log(`repo: ${resolve(target)}   readme: ${readme.name}   staged: ${how}`);
  if (staged.uncommitted) {
    console.log(
      `note: replayed committed state; ${staged.uncommitted} uncommitted file(s) not included`
    );
  }
  console.log("");

  console.log("static checks (against the clean clone)");
  for (const f of findings) {
    const where = f.line ? `  [line ${f.line}]` : "";
    console.log(`  ${f.level.padEnd(5)} ${f.msg}${where}`);
  }
  console.log("");

  if (results.length) {
    console.log(`replay (${results.length} steps)`);
    results.forEach((r, i) => {
      const ms = r.ms != null ? `${r.ms}ms` : "";
      const why = r.why ? `  (${r.why})` : "";
      console.log(
        `  ${String(i + 1).padStart(2)} ${r.status.padEnd(4)} ${ms.padStart(7)} ${r.cmd}${why}`
      );
    });
  }

  const firstFail = results.find((r) => r.status === "fail" || r.status === "timeout");
  if (firstFail?.tail) {
    console.log("");
    console.log("  last output lines:");
    for (const l of firstFail.tail.split("\n")) console.log(`    ${l}`);
  }
  console.log("");
  const flags = findings.filter((f) => f.level === "flag").length;
  if (!results.length) {
    console.log(
      flags
        ? `verdict: STATIC ONLY - ${flags} flag(s) found, nothing executed.`
        : "verdict: STATIC ONLY - clean, nothing executed."
    );
  } else if (firstFail) {
    const idx = results.indexOf(firstFail) + 1;
    console.log(
      `verdict: BROKEN at step ${idx} - a new user following your README hits a wall there.`
    );
  } else if (flags) {
    console.log(
      `verdict: RUNS, but ${flags} static flag(s) - the steps ran on this machine yet may still trip a stranger.`
    );
  } else {
    console.log(
      `verdict: PASSES - ${results.length}/${results.length} steps ran clean in a fresh clone.`
    );
  }
  console.log("");
  // static-only mode fails on flags too - that's the whole point of the gate
  process.exit(firstFail || (args.onlyStatic && flags) ? 1 : 0);
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
