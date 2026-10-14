import { readdirSync, readFileSync, existsSync } from "node:fs";
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
  /^(\$\s|>\s|❯\s|% \s|sudo\s|npm|npx|pnpm|yarn|bun|deno|bunx|node\b|git\b|gh\b|glab\b|cd\b|cp\b|mv\b|mkdir\b|rm\b|cat\b|echo\b|touch\b|curl\b|wget\b|tar\b|unzip\b|zip\b|pipx?\d*\b|python\d*\b|uv\b|poetry\b|pipenv\b|conda\b|docker\b|docker-compose\b|make\b|cmake\b|g\+\+|gcc|go\b|cargo\b|rustc\b|mvn\b|gradle\b|\.\.?\/[\w./~-]|~\/|source\b|export\b|set\b|[A-Z_][A-Z0-9_]*=|chmod\b|chown\b|ln\b|systemctl\b|brew\b|apt(-get)?\b|snap\b|dnf\b|yum\b|pacman\b|kubectl\b|helm\b|terraform\b|ansible|vercel\b|netlify\b|flyctl\b|wrangler\b|supabase\b|firebase\b|stripe\b|php\b|composer\b|bundle\b|rails\b|rake\b|gem\b|redis-cli\b|psql\b|mysql\b|mongosh\b|mongo\b|sqlite3\b|ffmpeg\b|magick\b|convert\b|rsync\b|ssh\b|scp\b|vagrant\b|nix\b|sh\b|bash\b|zsh\b|pwsh\b|nohup\b|pm2\b|jest\b|vitest\b|pytest\b|tsc\b|eslint\b|prettier\b|tsx\b|esbuild\b|vite\b|next\b|nuxt\b|astro\b|remix\b|expo\b|fastapi\b|flask\b|django|uvicorn\b|gunicorn\b|nginx\b|caddy\b|http-server\b|live-server\b|json-server\b|xcodebuild\b|swift\b|dotnet\b|java\b|javac\b|kotlin\b|sbt\b|perl\b|ruby\b|claude\b|codex\b|aider\b|ollama\b|open\b)/i;

// lines that are literal placeholders, not commands
const PLACEHOLDER_LINE_RE =
  /^(<[^>\n]+>|\[?[A-Z][A-Z_ ]*(here|key|token|id|secret)\]?|your .*(here|key|token|id)|\.\.\.|…)$/i;

// Split a fenced block's text into runnable command lines.
// Returns null when the block looks like pasted output, not commands.
function blockToCommands(text) {
  const rawLines = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    line = trimmed.replace(/^[$>❯%]\s+/, "");
    if (!line || PLACEHOLDER_LINE_RE.test(line)) continue;
    pending = pending ? pending + line : line;
    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1) + " ";
      continue;
    }
    rawLines.push(pending);
    pending = "";
  }
  if (pending.trim()) rawLines.push(pending.trim());
  if (!rawLines.length) return null;

  const commandish = rawLines.filter((l) => COMMANDISH_RE.test(l));
  if (!commandish.length) return null; // pasted output, not commands
  // in a mixed block keep only commandish lines - output rows get dropped
  return commandish.length === rawLines.length ? rawLines : commandish;
}

// Parse a README into ordered shell steps with their section context.
export function extractSteps(markdown) {
  const lines = markdown.split("\n");
  let heading = "";
  let inFence = false;
  let fenceLang = "";
  let fence = [];
  let fenceLine = 0;
  const steps = [];
  const sections = [];

  const flush = () => {
    if (!fence.length) return;
    if (SHELL_LANGS.has(fenceLang)) {
      const tagged = fenceLang !== "" && fenceLang !== "text";
      const cmds = blockToCommands(fence.join("\n"));
      if (cmds) {
        for (const cmd of cmds) {
          steps.push({ cmd, line: fenceLine, heading, tagged });
        }
      }
    }
    fence = [];
  };

  lines.forEach((line, i) => {
    const fenceMatch = line.match(/^\s*```(\S*)\s*$/);
    if (fenceMatch) {
      if (inFence) flush();
      else {
        fenceLang = fenceMatch[1].toLowerCase();
        fenceLine = i + 1;
      }
      inFence = !inFence;
      return;
    }
    if (inFence) {
      fence.push(line);
      return;
    }
    const head = line.match(/^\s{0,3}#{1,4}\s+(.*)/);
    if (head) {
      heading = head[1].replace(/[#*`]/g, "").trim();
      sections.push(heading);
    }
  });
  if (inFence) flush();

  // Prefer steps inside quickstart-ish sections; fall back to tagged shell
  // blocks anywhere, then to every shell-looking block.
  const inQuickstart = steps.filter(
    (s) => QUICKSTART_RE.test(s.heading) || (!s.heading && s.tagged)
  );
  if (inQuickstart.length) return { steps: inQuickstart, sections };
  const tagged = steps.filter((s) => s.tagged);
  if (tagged.length) return { steps: tagged, sections };
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

export function isServerish(cmd) {
  if (
    /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(dev|serve|start|watch|preview)\b/.test(
      cmd
    )
  )
    return true;
  return /\b(uvicorn|gunicorn|flask\s+run|rails\s+s(erver)?|http-server|live-server|caddy\s+run|nginx\b|next\s+dev|nodemon|pm2\s+start|docker\s+compose\s+up|docker-compose\s+up|make\s+(dev|serve|run|start|up)|python\d*\s+-m\s+http\.server|php\s+-S)\b/.test(
    cmd
  );
}
