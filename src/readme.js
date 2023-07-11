import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const QUICKSTART_RE =
  /install|setup|quick ?start|getting started|usage|run|develop|build|deploy|try/i;
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "console", "zsh", "terminal", "shellsession",
  "bash-session", "text", "",
]);

export function findReadme(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  return names.find((n) => /^readme(\..*)?$/i.test(n)) ?? null;
}

// a line that is clearly a command vs. pasted example output
const COMMANDISH_RE =
  /^(\$\s|>\s|❯\s|% \s|sudo\s|npm\b|npx\b|pnpm\b|yarn\b|bun\b|bunx\b|node\b|git\b|cd\b|cp\b|mv\b|mkdir\b|rm\b|cat\b|echo\b|touch\b|curl\b|wget\b|tar\b|unzip\b|pipx?\d*\b|python\d*\b|uv\b|poetry\b|docker\b|docker-compose\b|make\b|cmake\b|g\+\+|gcc\b|go\b|cargo\b|mvn\b|gradle\b|\.\.?\/[\w./~-]|~\/|source\b|export\b|set\b|[A-Z_][A-Z0-9_]*=|chmod\b|ln\b|brew\b|apt(-get)?\b|php\b|composer\b|bundle\b|rails\b|rake\b|gem\b|redis-cli\b|psql\b|mysql\b|sqlite3\b|ffmpeg\b|sh\b|bash\b|zsh\b|nohup\b|pm2\b|jest\b|vitest\b|pytest\b|tsc\b|eslint\b|prettier\b|tsx\b|vite\b|next\b|uvicorn\b|flask\b|gunicorn\b|nginx\b|open\b)/i;

// lines that are literal placeholders, not commands
const PLACEHOLDER_LINE_RE =
  /^(<[^>\n]+>|\[?[A-Z][A-Z_ ]*(here|key|token|id|secret)\]?|your .*(here|key|token|id)|\.\.\.|…)$/i;

// Split a fenced block's text into runnable command lines.
// Returns null when the block looks like pasted output, not commands.
function blockToCommands(text) {
  const entries = [];
  let pending = "";
  let hadPrompt = false;
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(/\r$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const promptMatch = /^[$>❯%]\s+/.test(trimmed);
    const line = trimmed.replace(/^[$>❯%]\s+/, "");
    if (!line || PLACEHOLDER_LINE_RE.test(line)) continue;
    if (!pending) hadPrompt = promptMatch;
    pending = pending ? pending + line : line;
    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1).trimEnd() + " ";
      continue;
    }
    entries.push({ cmd: pending, hadPrompt });
    pending = "";
  }
  if (pending.trim()) entries.push({ cmd: pending.trim(), hadPrompt });
  if (!entries.length) return null;

  // a $ prompt line is a command even when the binary is custom/unknown
  const commandish = entries.filter((e) => e.hadPrompt || COMMANDISH_RE.test(e.cmd));
  if (!commandish.length) return null; // pasted output, not commands
  // in a mixed block keep only commandish lines - output rows get dropped
  return commandish.length === entries.length
    ? entries.map((e) => e.cmd)
    : commandish.map((e) => e.cmd);
}

// Parse a README into ordered shell steps with their section context.
export function extractSteps(markdown) {
  const lines = markdown.split("\n");
  const headingStack = []; // breadcrumb per level: ## Install > ### 1. Configure
  let inFence = false;
  let fenceLang = "";
  let fence = [];
  let fenceLine = 0;
  const steps = [];
  const sections = [];

  const headingText = () => headingStack.filter(Boolean).join(" > ");

  const flush = () => {
    if (!fence.length) return;
    if (SHELL_LANGS.has(fenceLang)) {
      const tagged = fenceLang !== "" && fenceLang !== "text";
      const cmds = blockToCommands(fence.join("\n"));
      if (cmds && cmds.length) {
        for (const cmd of cmds) {
          steps.push({ cmd, line: fenceLine, heading: headingText(), tagged });
        }
      }
    }
    fence = [];
  };

  lines.forEach((line, i) => {
    if (inFence && /^\s*```\s*$/.test(line)) {
      flush();
      inFence = false;
      return;
    }
    if (!inFence) {
      const open = line.match(/^\s*```\s*([\w-]*)/);
      if (open) {
        inFence = true;
        fenceLang = (open[1] || "").toLowerCase();
        fenceLine = i + 1;
        return;
      }
      // a second # H1 starts a fresh document context - clear the breadcrumb
      if (/^\s{0,3}#\s+/.test(line)) {
        headingStack.length = 0;
        return;
      }
      // H2-H4 only: the # H1 repo title ("# fast-build-runner") would
      // otherwise poison the breadcrumb and match QUICKSTART_RE everywhere
      const head = line.match(/^\s{0,3}(#{2,4})\s+(.*)/);
      if (head) {
        const level = head[1].length - 1;
        const text = head[2].replace(/[#*`]/g, "").trim();
        headingStack[level - 1] = text;
        headingStack.length = level;
        sections.push(text);
      }
      return;
    }
    fence.push(line);
  });
  if (inFence) flush();