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

console.log("selfcheck ok: broken repo fails at the right step, fixed repo passes, regression fixture behaves");
