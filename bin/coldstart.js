#!/usr/bin/env node
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { readReadme, extractSteps } from "../src/readme.js";
import { stageClone, replay } from "../src/replay.js";

const HELP = `coldstart - does your repo pass a fresh clone?

usage:
  coldstart [path-or-git-url]     replay the README in a clean checkout
  coldstart --help

options:
  --keep-going   don't stop at the first failure
  -h, --help
`;

const args = { target: null, keepGoing: false };
const argv = process.argv.slice(2);
for (const a of argv) {
  if (a === "--help" || a === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "--keep-going") args.keepGoing = true;
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

  const { results } = await replay(steps, {
    cloneDir,
    keepGoing: args.keepGoing,
  });

  console.log("");
  console.log("coldstart - fresh-clone replay");
  console.log(`repo: ${resolve(target)}   readme: ${readme.name}   staged: ${how}`);
  console.log("");
  results.forEach((r, i) => {
    const ms = r.ms != null ? `${r.ms}ms` : "";
    const why = r.why ? `  (${r.why})` : "";
    console.log(`  ${String(i + 1).padStart(2)} ${r.status.padEnd(4)} ${ms.padStart(7)} ${r.cmd}${why}`);
  });

  const firstFail = results.find((r) => r.status === "fail" || r.status === "timeout");
  if (firstFail?.tail) {
    console.log("");
    console.log("  last output lines:");
    for (const l of firstFail.tail.split("\n")) console.log(`    ${l}`);
  }
  console.log("");
  const idx = results.indexOf(firstFail) + 1;
  console.log(
    firstFail
      ? `verdict: BROKEN at step ${idx} - a new user following your README hits a wall there.`
      : `verdict: PASSES - ${results.length}/${results.length} steps ran clean in a fresh clone.`
  );
  console.log("");
  process.exit(firstFail ? 1 : 0);