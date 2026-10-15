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
// exact segment matches only: "app" counts, "apps", "app.py", "app.main"
// do not - those are real names
const PLACEHOLDER_RE =
  /^(my-app|myapp|your[-_]?app|your[-_]?project|example|sample|demo|foo|bar|baz|test[-_]?app|project|repo|app|website|site|input|file|path|name)$/i;

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
    execFileSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// lookahead keeps `bun index.ts` / `deno fmt` from matching as scripts
const PM_CMD_RE =
  /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+|task\s+)?([a-zA-Z0-9:_-]+)(?=[\s;&|]|$)/g;
// pm built-ins never live in package.json scripts
const PM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "unlink",
  "test", "exec", "dlx", "x", "create", "init", "audit", "outdated",
  "publish", "login", "logout", "whoami", "run", "link", "ln", "rebuild",
  "pack", "version", "cache", "config", "store", "update", "up", "upgrade",
  "why", "list", "ls", "info", "view", "doctor", "completion", "env",
  "node", "bin", "root", "help", "workspaces", "fmt", "lint", "compile",
  "task", "bundle", "install-global", "dedupe", "prune", "patch",
]);
// npm only runs scripts via run/start/test/stop/restart; deno via task;
// everything else for npm/deno is a builtin or a file argument
const PM_SCRIPT_STYLE = { npm: "explicit", deno: "task", bun: "run", pnpm: "bare", yarn: "bare" };

// a required arg in a step that is a placeholder or a file the user supplies,
// not something the repo ships - the step can't run meaningfully without it
const KNOWN_ASSET_RE =
  /^(requirements\.txt|docker-compose[\w.-]*\.ya?ml|Makefile|\.env\.?\w*|package\.json|tsconfig\.json|setup\.py|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i;

// commands that CREATE their path arguments - a missing target is the point
const CREATES_ARG_RE = /^\s*(mkdir|touch|git\s+clone|cp\b|mv\b|ln\b|tee\b|cat\s*>)/;

// tokens that introduce the thing being run - never treat them as path args:
// token 0 (the command), the script after `pm run`, the target after
// make/just/task, the tag after -t, the branch after -b/checkout
const RUNNER_RE = /^(npm|pnpm|yarn|bun|deno|npx|bunx|make|just|task|mise|cargo|go|mvn|gradle|rake|bundle|mix|dotnet|cmake)$/i;
const GITISH_RE = /^(git|gh|glab|hub|tea)$/;
const HOSTISH_RE = /^(localhost|127\.|0\.0\.0\.0|0x|.*\.(com|org|net|io|dev|app|local|sh|ai|co|xyz|me)|\d+\.\d+)/i;

export function stepBlocker(dir, cmd) {
  if (CREATES_ARG_RE.test(cmd)) return null;
  const tokens = [...cmd.matchAll(/(?:^|\s)(\S+)/g)];
  // indices to never treat as file args: the command itself, the script name
  // after `pm run`, the target after make-style runners, flag values
  const skipIdx = new Set();
  let firstReal = 0;
  while (
    firstReal < tokens.length &&
    /^(sudo|[A-Za-z_][A-Za-z0-9_]*=\S+|env)$/.test(tokens[firstReal][1])
  )
    firstReal++;
  if (firstReal < tokens.length) {
    skipIdx.add(firstReal);
    const verb = tokens[firstReal][1];
    const next = tokens[firstReal + 1]?.[1];
    if (RUNNER_RE.test(verb) && next && !next.startsWith("-")) {
      // `pm run script` -> skip two words; `pm script` / `make target` -> one
      skipIdx.add(next === "run" && tokens[firstReal + 2] ? firstReal + 2 : firstReal + 1);
    }
    if (GITISH_RE.test(verb)) {
      for (let i = firstReal + 1; i < Math.min(firstReal + 4, tokens.length); i++) {
        if (/^(checkout|switch|branch|clone|remote|merge|rebase|cherry-pick)$/.test(tokens[i][1])) {
          if (tokens[i + 1]) skipIdx.add(i + 1);
          break;
        }
      }
    }
  }
  // flags that consume the next token as a value (--filter apps/web, -t tag)
  const VALUE_FLAG_RE = /^(--filter|-F|--tag|-t|--branch|-b|--name|-n|--file|-f|--output|-o|--cwd|-C|--prefix|--context|-c|--target|--env|-e|--user|-u|--workdir|-w)$/;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (VALUE_FLAG_RE.test(tokens[i][1])) skipIdx.add(i + 1);
  }

  // a bare `owner/repo` only means a repo slug when a clone-ish or
  // package-runner command invites it - `localhost/health`, docker tags,
  // git branches, and ./paths never count
  const verbForSlug = tokens[firstReal]?.[1] ?? "";
  const slugContext =
    GITISH_RE.test(verbForSlug) && /\bclone\b/.test(cmd)
      ? true
      : /^(npx|bunx|pnpx|npm|pnpm|yarn|gh|hub|tea|glab|pipx?|uvx?)$/.test(verbForSlug);

  for (const m of tokens) {
    if (skipIdx.has(tokens.indexOf(m))) continue;
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
    // explicit ./paths are repo files - missing means the README is broken,
    // never a "bring your own" skip
    if (!hadDotSlash && !hasExt && segs.length === 2 && slugContext &&
        /^[\w.-]+\/[\w.-]+$/.test(bare) && !HOSTISH_RE.test(segs[0])) {
      return `needs a real repo/owner arg (\`${bare}\` is an example)`;
    }
    if (!hasExt && PLACEHOLDER_RE.test(segs[0])) {
      return `needs your own path (\`${bare}\` is a placeholder)`;
    }
    if (USER_INPUT_RE.test(lastSeg)) return `needs your file \`${lastSeg}\``;
    if (hadDotSlash && !bare.includes("/")) {
      return `needs your own path (\`./${bare}\` isn't in the repo)`;
    }
  }
  return null;
}

// Static checks run against the clean clone, before any command executes.
export function staticChecks(dir, steps, opts = {}) {
  const { repoName = null, docker = false } = opts;
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

  for (const { cmd, line, directive } of steps) {
    if (directive?.ignore) continue; // author says this block is illustrative
    // follow cd steps so script checks hit the right package.json (monorepos)
    const cdTo = cmd.match(/^\s*cd\s+([^\s;&|]+)/)?.[1];
    if (cdTo && !cdTo.startsWith("/") && !cdTo.includes("..")) {
      // `cd <repoName>` right after `git clone` re-enters the staged clone
      if (cdTo === repoName) {
        curDir = dir;
        curScripts = scripts;
      } else if (existsSync(join(curDir, cdTo))) {
        curDir = join(curDir, cdTo);
        curScripts = readPkgScripts(curDir) ?? curScripts;
      }
    }
    for (const m of cmd.matchAll(PM_CMD_RE)) {
      const [full, pm, runKw, sub] = m;
      pmInReadme.add(pm);
      if (!sub) continue;
      const style = PM_SCRIPT_STYLE[pm];
      const isScript =
        style === "bare" ||
        (style === "task" && runKw === "task ") ||
        (style === "explicit" &&
          (runKw === "run " || ["start", "test", "stop", "restart"].includes(sub))) ||
        (style === "run" && runKw === "run ");
      const scriptName = sub;
      if (
        curScripts &&
        isScript &&
        !PM_BUILTINS.has(scriptName) &&
        !curScripts.includes(scriptName)
      ) {
        const key = `${pm} ${scriptName}`;
        if (!checkedScripts.has(key)) {
          checkedScripts.add(key);
          findings.push({
            level: "flag",
            line,
            msg: `\`${full.trim()}\` but package.json has no "${scriptName}" script (has: ${curScripts.slice(0, 8).join(", ") || "none"})`,
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
        p !== repoName && // `cd <repo>` re-enters the staged clone, not missing
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
    if (!docker && !which(pm)) {
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
  if (!docker) {
    for (const b of wanted) {
      if (!which(b)) {
        findings.push({
          level: "warn",
          msg: `README needs \`${b}\` - not on this machine's PATH (fresh users may not have it either)`,
        });
      }
    }
  }

  if (!findings.length) {
    findings.push({ level: "ok", msg: "no static problems found" });
  }
  return findings;
}
