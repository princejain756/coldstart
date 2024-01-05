#!/usr/bin/env node
import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  readReadme,
  extractSteps,
  classifyStep,
  isServerish,
} from "../src/readme.js";
import { staticChecks } from "../src/checks.js";
import { stageClone, replay } from "../src/replay.js";

const HELP = `coldstart - does your repo pass a fresh clone?

usage:
  coldstart [path-or-git-url]     replay the README in a clean checkout
  coldstart --help

options:
  --only-static   run the checks, skip executing anything
  --keep-going    don't stop at the first failure
  --json          machine-readable report
  --quiet         only the verdict line
  -h, --help
`;

function parseArgs(argv) {
  const o = { target: null, onlyStatic: false, keepGoing: false, json: false, quiet: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--only-static") o.onlyStatic = true;
    else if (a === "--keep-going") o.keepGoing = true;
    else if (a === "--json") o.json = true;
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (!a.startsWith("-") && !o.target) o.target = a;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const target = args.target ?? process.cwd();
// resolve local paths first: basename(".") is "" and would break both the
// `cd <repo>` shorthand and self-clone detection
const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(target);
const repoName = basename(
  (isUrl ? target : resolve(target)).replace(/\/+$/, "")
).replace(/\.git$/, "");
let staged;
try {
  staged = stageClone(target);
} catch (e) {
  console.error(`coldstart: ${e.message}`);
  process.exit(2);
}

const { dir: cloneDir, tmp, how } = staged;
// exit handler covers every path, including the process.exit calls below
// that would skip the finally block
process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});
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
    ({ results } = await replay(steps, {
      cloneDir,
      isServerish,
      classifyStep,
      keepGoing: args.keepGoing,
      repoName,
    }));
  }

  const broken = results.some((r) => r.status === "fail" || r.status === "timeout");
  const flags = findings.filter((f) => f.level === "flag").length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          target,
          readme: readme.name,
          staged: how,
          findings,
          results: results.map(({ tail, ...r }) => r),
          verdict: broken ? "broken" : flags ? "runs-with-flags" : "passes",
        },
        null,
        2
      )
    );
  } else if (args.quiet) {
    console.log(
      broken
        ? `BROKEN at step ${results.findIndex((r) => r.status === "fail" || r.status === "timeout") + 1}`
        : flags
          ? `RUNS, ${flags} flags`
          : "PASSES"
    );
  } else {
    console.log("");
    console.log("coldstart - fresh-clone replay");
    console.log(
      `repo: ${repoName || target}   readme: ${readme.name}   staged: ${how}   env: host shell`
    );
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