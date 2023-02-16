import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readPkgScripts(dir) {
  try {
    return Object.keys(
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {}
    );
  } catch {
    return null;
  }
}

// `npm run build`, `yarn build`, `pnpm run test` - the script name is the
// third token; `npm install` and friends are package-manager builtins.
const PM_SCRIPT_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?([a-zA-Z0-9:_-]+)(?=[\s;&|]|$)/g;
const PM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "unlink",
  "test", "exec", "dlx", "x", "create", "init", "audit", "outdated",
  "publish", "login", "logout", "whoami", "run", "link", "ln", "rebuild",
  "pack", "version", "cache", "config", "store", "update", "up", "upgrade",
  "why", "list", "ls", "info", "view", "doctor", "completion", "env",
  "node", "bin", "root", "help", "workspaces",
]);

// paths a README treats as repo files: ./script.sh, configs, requirements
const FILE_ARG_RE =
  /(?:^|\s)(\.\/[\w./-]+|[\w.-]+\/(?:requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env[\w.-]*))\b/g;

// Static checks run against the clean clone, before any command executes.
// Everything here is a promise the README makes that the repo does not keep.
export function staticChecks(dir, steps) {
  const findings = [];
  const scripts = readPkgScripts(dir);
  const checkedScripts = new Set();
  const missingFiles = new Map();

  for (const { cmd, line } of steps) {
    for (const m of cmd.matchAll(PM_SCRIPT_RE)) {
      const [full, pm, runKw, sub] = m;
      if (!sub || PM_BUILTINS.has(sub)) continue;
      // npm only runs scripts through `run`/start/test; the rest is a file arg
      const isScript =
        runKw === "run " ||
        (pm === "npm" && ["start", "test", "stop", "restart"].includes(sub)) ||
        (pm !== "npm" && runKw === undefined);
      if (!isScript || !scripts) continue;
      if (!scripts.includes(sub) && !checkedScripts.has(sub)) {
        checkedScripts.add(sub);
        findings.push({
          level: "flag",
          line,
          msg: `\`${full.trim()}\` but package.json has no "${sub}" script (has: ${scripts.slice(0, 8).join(", ") || "none"})`,
        });
      }
    }

    for (const m of cmd.matchAll(FILE_ARG_RE)) {
      const p = m[1].replace(/^(\.\/)/, "");
      if (p.includes("..")) continue;
      // `./name.ext` with no directory part is usually a usage example
      const looksLikeAsset =
        p.includes("/") ||
        /^(requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env|\.env\.\w+)$/i.test(
          p
        );
      if (!looksLikeAsset) continue;
      if (!existsSync(join(dir, p)) && !missingFiles.has(p)) missingFiles.set(p, line);
    }
  }

  for (const [file, line] of missingFiles) {
    findings.push({
      level: "flag",
      line,
      msg: `README references \`${file}\` but it does not exist in the repo`,
    });
  }

  if (!findings.length) {
    findings.push({ level: "ok", msg: "no static problems found" });
  }
  return findings;
}
