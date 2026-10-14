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

console.log("selfcheck ok: broken repo fails at the right step, fixed repo passes");
