import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const PM_FILES = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
};

const ENV_RE = /(^|\s)(export\s+)?[A-Z][A-Z0-9_]{2,}=/g;
// paths a README treats as repo files: ./script.sh, configs, requirements
const FILE_ARG_RE =
  /(?:^|\s)(\.\/[\w./-]+|[\w.-]+\/(?:requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env[\w.-]*))\b/g;
// file args that are really "bring your own" inputs, not repo assets
const USER_INPUT_RE =
  /\.(jpe?g|png|gif|webp|mp3|mp4|mov|wav|pdf|docx?|xlsx?|pptx?|csv|tsv|zip|tar|gz|sqlite|db|bin|dat)$/i;
const PLACEHOLDER_RE =
  /^(my-app|myapp|your[-_]?app|your[-_]?project|example|sample|demo|foo|bar|baz|test[-_]?app|project|repo|app|website|site|input|file|path|name|<)/i;

function detectPackageManagers(dir) {
  const found = [];
  for (const [file, pm] of Object.entries(PM_FILES)) {
    if (existsSync(join(dir, file))) found.push(pm);
  }
  if (existsSync(join(dir, "package.json")) && !found.length) found.push("npm");
  return found;
}

function readPkgScripts(dir) {
  try {
    return Object.keys(
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {}
    );
  } catch {
    return null;
  }
}

function which(cmd) {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const PM_CMD_RE = /\b(npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?([a-zA-Z0-9:_][a-zA-Z0-9:_-]*)?/g;

// a required arg in a step that is a placeholder or a file the user supplies,
// not something the repo ships - the step can't run meaningfully without it
const KNOWN_ASSET_RE =
  /^(requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env\.?\w*|package\.json|tsconfig\.json|setup\.py|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i;

// commands that CREATE their path arguments - a missing target is the point
const CREATES_ARG_RE = /^\s*(mkdir|touch|git\s+clone|cp\b|mv\b|ln\b|tee\b|cat\s*>)/;

export function stepBlocker(dir, cmd) {
  if (CREATES_ARG_RE.test(cmd)) return null;
  for (const m of cmd.matchAll(/(?:^|\s)(\S+)/g)) {
    let p = m[1].replace(/^['"(]/, "").replace(/[)>'"`,;]+$/, "");
    if (!p || p.startsWith("-") || p.includes("=") || p.startsWith("$")) continue;
    if (/[>|]\s*$/.test(cmd.slice(0, m.index))) continue;
    const hadDotSlash = p.startsWith("./");
    const bare = p.replace(/^\.\//, "");
    if (p.startsWith("/") || p.includes("..") || !bare) continue;
    if (existsSync(join(dir, bare)) || existsSync(join(dir, bare.split("/").pop()))) continue;
    if (KNOWN_ASSET_RE.test(bare.split("/").pop())) continue; // real missing asset: let it fail

    const segs = bare.split("/");
    const lastSeg = segs[segs.length - 1];
    const hasExt = /\.[a-z0-9]+$/i.test(lastSeg);
    // owner/repo-style slugs are placeholders; real file paths just get
    // checked for existence (missing -> the step fails on its own)
    if (!hasExt && /^[\w.-]+\/[\w.-]+$/.test(bare)) {
      return `needs a real repo/owner arg (\`${bare}\` is an example)`;
    }
    // placeholder words only count extension-free names, so `app.py`,
    // `project.json` and friends still get evaluated for real
    if (!hasExt && PLACEHOLDER_RE.test(segs[0])) {
      return `needs your own path (\`${bare}\` is a placeholder)`;
    }
    const base = lastSeg;
    if (USER_INPUT_RE.test(base)) return `needs your file \`${base}\``;
    // single-segment relative arg that doesn't exist: the README means "yours"
    if (hadDotSlash && !bare.includes("/")) {
      return `needs your own path (\`./${bare}\` isn't in the repo)`;
    }
  }
  return null;
}

// Static checks run against the clean clone, before any command executes.
export function staticChecks(dir, steps) {
  const findings = [];
  const pms = detectPackageManagers(dir);
  const scripts = readPkgScripts(dir);
  const envFiles = readdirSync(dir).filter((f) =>
    /^\.env(\.example|\.sample|\.template|\.dist)?$/i.test(f)
  );
  const hasEnvExample = envFiles.some((f) => !/^\.env$/i.test(f));

  const pmInReadme = new Set();
  const envVars = new Set();
  const checkedScripts = new Set();
  const missingFiles = new Map();
  let curDir = dir;
  let curScripts = scripts;

  for (const { cmd, line } of steps) {
    // follow cd steps so script checks hit the right package.json (monorepos)
    const cdTo = cmd.match(/^\s*cd\s+([^\s;&|]+)/)?.[1];
    if (cdTo && !cdTo.startsWith("/") && !cdTo.includes("..") && existsSync(join(curDir, cdTo))) {
      curDir = join(curDir, cdTo);
      curScripts = readPkgScripts(curDir) ?? curScripts;
    }
    for (const m of cmd.matchAll(PM_CMD_RE)) {
      pmInReadme.add(m[1]);
      const sub = m[2];
      if (
        curScripts &&
        sub &&
        !["install", "i", "ci", "add", "remove", "test", "exec", "dlx", "create", "init", "audit", "outdated", "publish", "login", "whoami", "run"].includes(sub) &&
        !curScripts.includes(sub)
      ) {
        const key = `${m[1]} run ${sub}`;
        if (!checkedScripts.has(key)) {
          checkedScripts.add(key);
          findings.push({
            level: "flag",
            line,
            msg: `\`${m[1]} run ${sub}\` but package.json has no "${sub}" script (has: ${curScripts.slice(0, 8).join(", ") || "none"})`,
          });
        }
      }
    }

    for (const m of cmd.matchAll(ENV_RE)) {
      const name = cmd.slice(m.index).match(/[A-Z][A-Z0-9_]{2,}/)?.[0];
      if (name && /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|API/i.test(name)) {
        envVars.add(name);
      }
    }

    if (/\|\s*(sudo\s+)?(ba|z)?sh\b/.test(cmd) && /curl|wget/.test(cmd)) {
      findings.push({
        level: "warn",
        line,
        msg: `pipes a remote script into a shell - runs on the user's machine, not the sandbox`,
      });
    }

    for (const m of cmd.matchAll(FILE_ARG_RE)) {
      const p = m[1].replace(/^(\.\/)/, "");
      if (p.includes("..") || PLACEHOLDER_RE.test(p)) continue;
      // `./name.ext` with no directory part is usually a usage example, not a
      // repo asset - only nested paths and known config names get flagged
      const looksLikeAsset =
        p.includes("/") ||
        /^(requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env|\.env\.\w+|package\.json|tsconfig\.json|setup\.py|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i.test(
          p
        );
      if (!looksLikeAsset) continue;
      if (USER_INPUT_RE.test(p)) {
        if (!existsSync(join(dir, p)) && !missingFiles.has(`input:${p}`)) {
          missingFiles.set(`input:${p}`, line);
        }
        continue;
      }
      if (!existsSync(join(dir, p)) && !missingFiles.has(p)) {
        missingFiles.set(p, line);
      }
    }

    const cdMatch = cmd.match(/^\s*cd\s+([^\s;&|]+)/);
    if (cdMatch && !cdMatch[1].startsWith("/") && !cdMatch[1].includes("..")) {
      const p = cdMatch[1];
      if (
        !PLACEHOLDER_RE.test(p) &&
        !existsSync(join(dir, p)) &&
        !missingFiles.has(p)
      ) {
        missingFiles.set(p, line);
      }
    }
  }

  for (const [file, line] of missingFiles) {
    if (file.startsWith("input:")) {
      findings.push({
        level: "warn",
        line,
        msg: `step expects \`${file.slice(6)}\` - a file the user brings, not one the repo ships (fine, but worth saying in the README)`,
      });
    } else {
      findings.push({
        level: "flag",
        line,
        msg: `README references \`${file}\` but it does not exist in the repo`,
      });
    }
  }

  for (const pm of pmInReadme) {
    const lockfilePm = pms.find((p) => p !== pm);
    if (lockfilePm) {
      findings.push({
        level: "warn",
        msg: `README uses \`${pm}\` but the repo ships a ${lockfilePm} lockfile`,
      });
    }
    if (!which(pm)) {
      findings.push({
        level: "warn",
        msg: `\`${pm}\` is used by the README but is not on this machine's PATH`,
      });
    }
  }

  for (const v of envVars) {
    if (!hasEnvExample) {
      findings.push({
        level: "flag",
        msg: `README needs a secret (\`${v}\`) but the repo ships no .env.example / .env.sample - a new user has to guess`,
      });
      break; // once is enough
    }
  }

  // binaries the README assumes exist
  const wanted = new Set();
  for (const { cmd } of steps) {
    const first = cmd.match(/^\s*(?:sudo\s+)?([a-zA-Z0-9_.-]+)\s/)?.[1];
    if (first && /^(docker|go|cargo|rustc|python\d*|pip\d*|uv|poetry|make|cmake|gcc|rustc|node|php|composer|mysql|psql|redis-server|ffmpeg|ffmpeg)$/.test(first)) {
      wanted.add(first);
    }
  }
  for (const b of wanted) {
    if (!which(b)) {
      findings.push({
        level: "warn",
        msg: `README needs \`${b}\` - not on this machine's PATH (fresh users may not have it either)`,
      });
    }
  }

  if (!findings.length) {
    findings.push({ level: "ok", msg: "no static problems found" });
  }
  return findings;
}
