#!/usr/bin/env node
import { resolve } from "node:path";
import { readReadme, extractSteps } from "../src/readme.js";

const HELP = `coldstart - what does a fresh clone actually have to run?

usage:
  coldstart [path]     list the commands your README asks a new user to run
  coldstart --help
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const target = resolve(args[0] ?? process.cwd());
const readme = readReadme(target);
if (!readme) {
  console.error(`coldstart: no README found in ${target}`);
  process.exit(2);
}

const { steps } = extractSteps(readme.text);
if (!steps.length) {
  console.error(`coldstart: ${readme.name} has no shell code blocks`);
  process.exit(2);
}

console.log("");
console.log(`coldstart - ${readme.name} in ${target}`);
console.log("");
for (const [i, step] of steps.entries()) {
  const where = step.heading ? `  (${step.heading})` : "";
  console.log(`  ${String(i + 1).padStart(2)}  ${step.cmd}${where}`);
}
console.log("");
console.log(`${steps.length} step(s) to run`);
console.log("");
