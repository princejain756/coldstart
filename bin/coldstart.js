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