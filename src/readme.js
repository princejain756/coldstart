import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const QUICKSTART_RE = /install|setup|quick ?start|getting started|usage|run/i;
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "console", "zsh", "terminal", "shellsession", "text", "",
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

// the first word of a line, when it is a real CLI people type
const COMMANDISH_RE =
  /^(\$\s|npm\b|npx\b|pnpm\b|yarn\b|bun\b|node\b|git\b|cd\b|mkdir\b|cp\b|mv\b|curl\b|wget\b|tar\b|pip3?\b|python3?\b|uv\b|poetry\b|docker\b|docker-compose\b|make\b|go\b|cargo\b|\.\.?\/[\w./-]|source\b|export\b|[A-Z_][A-Z0-9_]*=)/;

// Split a fenced block into the lines a reader would actually type.
// Returns null for blocks that are pasted program output.
function blockToCommands(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(/\r$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    lines.push(trimmed.replace(/^[$>]\s+/, ""));
  }
  if (!lines.length) return null;
  const commands = lines.filter((l) => COMMANDISH_RE.test(l));
  return commands.length ? commands : null;
}

// Pull the ordered shell steps out of a README, with the heading they sit
// under so the report can say where in the document they came from.
export function extractSteps(markdown) {
  const steps = [];
  const sections = [];
  let heading = null;
  let inFence = false;
  let fenceLang = "";
  let fence = [];
  let fenceLine = 0;

  const flush = () => {
    if (fence.length && SHELL_LANGS.has(fenceLang)) {
      const cmds = blockToCommands(fence.join("\n"));
      if (cmds) {
        for (const cmd of cmds) {
          steps.push({ cmd, line: fenceLine, heading });
        }
      }
    }
    fence = [];
  };

  markdown.split("\n").forEach((line, i) => {
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
      const head = line.match(/^\s{0,3}(#{2,4})\s+(.*)/);
      if (head) {
        heading = head[2].replace(/[#*`]/g, "").trim();
        sections.push(heading);
      }
      return;
    }
    fence.push(line);
  });
  if (inFence) flush();

  return { steps, sections };
}

export function readReadme(dir) {
  const name = findReadme(dir);
  if (!name) return null;
  return { name, text: readFileSync(join(dir, name), "utf8") };
}

// Commands that should not be auto-replayed: they'd mutate the host, ask for
// input we can't give, or only make sense outside a clone.
const SKIP_RE =
  /^\s*(sudo\b|open\b|code\b|xcode-select|ssh\b|git\s+push|npm\s+publish|gh\s+repo\s+create|docker\s+push|rm\s+-rf?\s*\/|say\b|osascript|npm\s+(i|install)\s+(-g|--global)\b|brew\s+install\b|brew\s+services\b)/;
const INTERACTIVE_HINT = /create-(next|vite|react|expo|remix|nuxt|svelte)-app|npm\s+init|yarn\s+create|pnpm\s+create|read\s+-/;

export function classifyStep(cmd) {
  if (SKIP_RE.test(cmd)) return { run: false, why: "host-side command" };
  if (INTERACTIVE_HINT.test(cmd)) return { run: false, why: "interactive" };
  return { run: true };
}
