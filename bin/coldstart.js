#!/usr/bin/env node
import { rmSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  readReadme,
  extractSteps,
  classifyStep,
  isServerish,
} from "../src/readme.js";
import { staticChecks, stepBlocker } from "../src/checks.js";
import { stageClone, replay, defaultDockerImage } from "../src/replay.js";
import { render } from "../src/report.js";

const HELP = `coldstart - does your repo pass a fresh clone?

usage:
  coldstart [path-or-git-url]     replay the README in a clean checkout
  coldstart --help

options:
  --docker [image]   replay inside a clean container instead of the host shell
  --only-static      run the checks, skip executing anything
  --keep-going       don't stop at the first failure
  --json             machine-readable report
  --github           emit GitHub Actions ::error/::warning annotations (auto in CI)
  --quiet            only the verdict line
  -h, --help
`;

function parseArgs(argv) {
  const o = { target: null, docker: undefined, onlyStatic: false, keepGoing: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--only-static") o.onlyStatic = true;
    else if (a === "--keep-going") o.keepGoing = true;
    else if (a === "--json") o.json = true;
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "--docker") {
      const next = argv[i + 1];
      // an existing path or a git url is the target; anything else is the image
      if (next && !next.startsWith("-") && !existsSync(next) && !/^(https?:\/\/|git@)/.test(next)) {
        o.docker = argv[++i];
      } else o.docker = true;
    } else if (a.startsWith("--docker=")) o.docker = a.slice(9) || true;
    else if (a === "--github") o.github = true;
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
let staged;
try {
  staged = stageClone(target);
} catch (e) {
  console.error(`coldstart: ${e.message}`);
  process.exit(2);
}

const { dir: cloneDir, tmp } = staged;
// exit handler covers every exit path, including SIGINT inside docker sessions
// where process.exit() would skip the finally below
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

  const docker =
    args.docker === true ? defaultDockerImage(cloneDir) : args.docker || null;
  if (args.docker === true && !docker) {
    console.error(
      "coldstart: can't pick a base image (no package.json/go.mod/Cargo.toml/requirements) - pass one: --docker node:22"
    );
    process.exit(2);
  }

  const findings = staticChecks(cloneDir, steps);
  let results = [];
  if (!args.onlyStatic) {
    let r;
    try {
      r = await replay(steps, {
      cloneDir,
      isServerish,
      classifyStep,
      blocker: (cwd, cmd) => stepBlocker(cwd, cmd),
      docker,
      keepGoing: args.keepGoing,
      repoName: basename(target.replace(/[/.]+$/, "")).replace(/\.git$/, ""),
        onStep: args.json || args.quiet ? () => {} : () => {},
      });
    } catch (e) {
      console.error(`coldstart: ${e.message}`);
      process.exit(2);
    }
    results = r.results;
  }

  const broken = results.some((r) => r.status === "fail" || r.status === "timeout");
  const flags = findings.filter((f) => f.level === "flag").length;

  // GitHub Actions annotations - inline PR comments on the README lines
  if (args.github || process.env.GITHUB_ACTIONS === "true") {
    for (const f of findings) {
      if (!f.line) continue;
      const sev = f.level === "flag" ? "error" : f.level === "warn" ? "warning" : null;
      if (sev) console.log(`::${sev} file=${readme.name},line=${f.line}::${f.msg}`);
    }
    for (const r of results) {
      if (r.status === "fail" || r.status === "timeout")
        console.log(
          `::error file=${readme.name},line=${r.line}::step \`${r.cmd}\` ${r.status}${r.code != null ? ` (exit ${r.code})` : ""}`
        );
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          target,
          readme: readme.name,
          staged: staged.how,
          docker,
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
    process.stdout.write(
      render({
        target: basename(target.replace(/\/$/, "")) || target,
        readmeName: readme.name,
        how: staged.how,
        uncommitted: staged.uncommitted,
        findings,
        results,
        docker,
      })
    );
  }
  // static-only mode fails on flags too - that's the whole point of the gate
  process.exit(broken || (args.onlyStatic && flags) ? 1 : 0);
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
