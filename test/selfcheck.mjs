// selfcheck: build a fixture repo whose README fails at a known step,
// run coldstart on it, assert the verdict and the failing step.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const bin = join(root, "bin", "coldstart.js");

const fx = mkdtempSync(join(tmpdir(), "coldstart-fixture-"));
writeFileSync(
  join(fx, "package.json"),
  JSON.stringify({ name: "fx", scripts: { build: "echo built" } }, null, 2)
);
writeFileSync(
  join(fx, "README.md"),
  `# fixture

## Install

\`\`\`bash
echo step-one-ok
npm run missing-script
echo should-never-run
\`\`\`
`
);
execFileSync("git", ["init", "-q"], { cwd: fx });
execFileSync("git", ["add", "-A"], { cwd: fx });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  { cwd: fx }
);

const r = spawnSync("node", [bin, "--json", fx], { encoding: "utf8" });
const report = JSON.parse(r.stdout);

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`selfcheck FAIL: ${msg}`);
    console.error(r.stdout.slice(0, 2000));
    process.exit(1);
  }
};

assert(report.verdict === "broken", `expected broken, got ${report.verdict}`);
const failStep = report.results.find((x) => x.status === "fail");
assert(failStep, "no failing step reported");
assert(
  failStep.cmd === "npm run missing-script",
  `wrong failing step: ${failStep.cmd}`
);
assert(
  report.results.find((x) => x.cmd === "echo should-never-run")?.status ===
    "skip",
  "steps after failure should be skipped"
);
const flags = report.findings.filter((f) => f.level === "flag");
assert(
  flags.some((f) => f.msg.includes("missing-script")),
  "static check should flag the missing script before replay"
);

// good repo passes
writeFileSync(
  join(fx, "README.md"),
  `# fixture\n\n## Install\n\n\`\`\`bash\necho hello\nnode -e "console.log('works')"\n\`\`\`\n`
);
execFileSync("git", ["add", "-A"], { cwd: fx });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix"],
  { cwd: fx }
);
const r2 = spawnSync("node", [bin, "--json", fx], { encoding: "utf8" });
const report2 = JSON.parse(r2.stdout);
assert(report2.verdict === "passes", `expected passes, got ${report2.verdict}`);
assert(r2.status === 0, `expected exit 0, got ${r2.status}`);
assert(r.status === 1, `expected exit 1 for broken repo, got ${r.status}`);

// fixture B: regressions. exit-127 from an INNER command must fail (not skip),
// extension-bearing names like app.py are real files not placeholders,
// `cd x && cmd` compounds, fences with info strings still parse, and
// <!-- coldstart:ignore --> blocks are skipped.
const fx2 = mkdtempSync(join(tmpdir(), "coldstart-fixture-b-"));
mkdirSync(join(fx2, "sub"));
writeFileSync(join(fx2, "sub", "keep.txt"), "x");
writeFileSync(
  join(fx2, "package.json"),
  JSON.stringify(
    { name: "fxb", scripts: { build: "definitely-not-a-binary-xyz --run" } },
    null,
    2
  )
);
writeFileSync(
  join(fx2, "README.md"),
  `# fixture b

## Install

\`\`\`bash copy
cd sub && echo moved-in
\`\`\`

<!-- coldstart:ignore -->
\`\`\`bash
this-is-not-a-real-command-xyz
\`\`\`

## Run

\`\`\`bash
cd ..
npm run build
cat app.py
echo tail-step
\`\`\`
`
);
execFileSync("git", ["init", "-q"], { cwd: fx2 });
execFileSync("git", ["add", "-A"], { cwd: fx2 });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  { cwd: fx2 }
);

const r3 = spawnSync("node", [bin, "--json", "--keep-going", fx2], {
  encoding: "utf8",
});
const rep3 = JSON.parse(r3.stdout);
const byCmd = (c) => rep3.results.find((x) => x.cmd === c);

assert(byCmd("cd sub"), `cd half of compound should be recorded`);
assert(byCmd("echo moved-in")?.status === "ok", `compound cd && cmd should run the rest, got ${byCmd("echo moved-in")?.status}`);
assert(byCmd("cd ..")?.status === "cd", `cd .. should return to repo root, got ${byCmd("cd ..")?.status}`);
assert(
  byCmd("this-is-not-a-real-command-xyz")?.status === "skip" &&
    byCmd("this-is-not-a-real-command-xyz")?.why === "coldstart:ignore",
  `directive should skip, got ${byCmd("this-is-not-a-real-command-xyz")?.status}`
);
assert(
  byCmd("npm run build")?.status === "fail",
  `inner 127 must fail not skip, got ${byCmd("npm run build")?.status}`
);
assert(
  byCmd("cat app.py")?.status === "fail",
  `missing app.py must fail not skip, got ${byCmd("cat app.py")?.status} why=${byCmd("cat app.py")?.why}`
);
assert(byCmd("echo tail-step")?.status === "ok", `keep-going should continue after failures`);
assert(rep3.verdict === "broken", `fixture b should be broken, got ${rep3.verdict}`);

// fixture C: the H1 repo title must not poison the quickstart filter
// ("# awesome-build-tool" + a Contributing section: contributing commands
// must NOT run), missing ./scripts/x.sh must FAIL (not skip), inline
// KEY=VAL prefixes must not be treated as binaries, and `export R=$(pwd)`
// must run through the shell instead of being stored literally.
const fx3 = mkdtempSync(join(tmpdir(), "coldstart-fixture-c-"));
writeFileSync(
  join(fx3, "package.json"),
  JSON.stringify({ name: "fxc", scripts: { ok: "echo ok-script" } }, null, 2)
);
writeFileSync(
  join(fx3, "README.md"),
  `# awesome-build-tool

## Install

\`\`\`bash
echo install-ran
FOO=bar echo inline-env-ok
export ROOT=$(pwd)
./scripts/setup.sh
\`\`\`

## Contributing

\`\`\`bash
echo contrib-must-not-run
\`\`\`
`
);
execFileSync("git", ["init", "-q"], { cwd: fx3 });
execFileSync("git", ["add", "-A"], { cwd: fx3 });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  { cwd: fx3 }
);
const r4 = spawnSync("node", [bin, "--json", "--keep-going", fx3], {
  encoding: "utf8",
});
const rep4 = JSON.parse(r4.stdout);
const byCmd4 = (c) => rep4.results.find((x) => x.cmd === c);
assert(
  !byCmd4("echo contrib-must-not-run"),
  "H1 title must not pull Contributing into the quickstart set"
);
assert(
  byCmd4("FOO=bar echo inline-env-ok")?.status === "ok",
  `inline KEY=VAL prefix should run, got ${byCmd4("FOO=bar echo inline-env-ok")?.status}`
);
assert(
  byCmd4("export ROOT=$(pwd)")?.status === "ok",
  `command substitution must run via shell, got ${byCmd4("export ROOT=$(pwd)")?.status}`
);
assert(
  byCmd4("./scripts/setup.sh")?.status === "fail",
  `missing ./scripts/setup.sh must fail not skip, got ${byCmd4("./scripts/setup.sh")?.status}`
);

// unit checks on extractSteps: daemon applies to the last block command
// only, and forced directive blocks still strip $ prompts + join
// backslash continuations
const { extractSteps } = await import(join(root, "src", "readme.js"));
const u = extractSteps(`# repo

## Run

<!-- coldstart:daemon -->
\`\`\`bash
npm install
my-server --port 8000
\`\`\`

<!-- coldstart:env DEMO=1 -->
\`\`\`bash
$ my-custom-tool \\
  --flag yes
\`\`\`
`);
const daemonSteps = u.steps.filter((s) => s.directive?.daemon);
const plainSteps = u.steps.filter(
  (s) => s.directive && !s.directive.daemon && !s.directive.env
);
assert(
  daemonSteps.length === 1 && daemonSteps[0].cmd === "my-server --port 8000",
  `daemon should tag only the last block command, got ${JSON.stringify(daemonSteps.map((s) => s.cmd))}`
);
assert(
  plainSteps.length === 0,
  `non-last commands in a daemon block must not carry the daemon tag`
);
assert(
  u.steps.some((s) => s.cmd === "my-custom-tool --flag yes"),
  `prompt + continuation should join to one command, got ${JSON.stringify(u.steps.map((s) => s.cmd))}`
);
assert(
  u.steps.find((s) => s.cmd === "my-custom-tool --flag yes")?.directive?.env
    ?.DEMO === "1",
  "env directive should ride along on the forced block"
);

console.log("selfcheck ok: broken repo fails at the right step, fixed repo passes, regression fixture behaves");
