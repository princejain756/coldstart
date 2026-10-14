const c = {
  on: process.stdout.isTTY,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const paint = (fn, s) => (c.on ? fn(s) : s);

export function fmtMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS = {
  ok: () => paint(c.green, "PASS"),
  started: () => paint(c.green, "UP  "),
  env: () => paint(c.dim, "env "),
  cd: () => paint(c.dim, "cd  "),
  skip: () => paint(c.yellow, "skip"),
  fail: () => paint(c.red, "FAIL"),
  timeout: () => paint(c.red, "TOUT"),
};

const LEVEL = {
  ok: () => paint(c.green, " ok  "),
  warn: () => paint(c.yellow, "warn "),
  flag: () => paint(c.red, "flag "),
};

export function renderStep(r, i) {
  const tag = STATUS[r.status]?.() ?? "    ";
  const ms = r.ms != null ? paint(c.dim, fmtMs(r.ms).padStart(7)) : "       ";
  const show = r.origCmd || r.cmd;
  const cmdTxt = show.length > 72 ? show.slice(0, 69) + "..." : show;
  let line = `  ${String(i + 1).padStart(2)} ${tag} ${ms} ${cmdTxt}`;
  if (r.note) line += paint(c.dim, `  (${r.note})`);
  if (r.status === "env") line += paint(c.dim, `  (${r.value} set for later steps)`);
  if (r.status === "cd" && r.why) line += paint(c.dim, `  (${r.why})`);
  if (r.status === "skip") line += paint(c.dim, `  (${r.why})`);
  if (r.status === "started") line += paint(c.dim, `  (server, still running at 15s - assumed good)`);
  return line;
}

export function render({ target, readmeName, how, uncommitted, findings, results, docker }) {
  const out = [];
  out.push("");
  out.push(paint(c.bold, `coldstart - fresh-clone replay`));
  out.push(
    paint(
      c.dim,
      `repo: ${target}   readme: ${readmeName}   staged: ${how}` +
        (docker ? `   env: docker ${docker}` : `   env: host shell`)
    )
  );
  if (uncommitted) {
    out.push(
      paint(c.dim, `note: replayed committed state; ${uncommitted} uncommitted file(s) not included`)
    );
  }
  out.push("");

  out.push(paint(c.bold, "static checks (against the clean clone)"));
  for (const f of findings) {
    out.push(`  ${LEVEL[f.level]?.() ?? "     "} ${f.msg}${f.line ? paint(c.dim, `  [line ${f.line}]`) : ""}`);
  }
  out.push("");

  out.push(paint(c.bold, `replay (${results.length} steps)`));
  results.forEach((r, i) => out.push(renderStep(r, i)));
  const firstFail = results.find((r) => r.status === "fail" || r.status === "timeout");
  if (firstFail?.tail) {
    out.push("");
    out.push(paint(c.dim, "  last output lines:"));
    for (const l of firstFail.tail.split("\n")) out.push(paint(c.dim, `    ${l}`));
  }
  out.push("");

  const fails = results.filter((r) => r.status === "fail" || r.status === "timeout");
  const okCount = results.filter((r) => r.status === "ok" || r.status === "started").length;
  const flagCount = findings.filter((f) => f.level === "flag").length;
  if (!results.length) {
    out.push(
      flagCount
        ? paint(c.yellow, `verdict: STATIC ONLY`) +
            ` - ${flagCount} flag(s) found, nothing executed.`
        : paint(c.green, `verdict: STATIC ONLY`) + ` - clean, nothing executed.`
    );
  } else if (fails.length) {
    const idx = results.indexOf(fails[0]) + 1;
    out.push(
      paint(c.red, `verdict: BROKEN`) +
        ` at step ${idx} - a new user following your README hits a wall there.`
    );
  } else if (flagCount) {
    out.push(
      paint(c.yellow, `verdict: RUNS, but`) +
        ` ${flagCount} static flag(s) - the steps ran on this machine yet may still trip a stranger.`
    );
  } else {
    out.push(
      paint(c.green, `verdict: PASSES`) +
        ` - ${okCount}/${results.length} steps ran clean in a fresh clone.`
    );
  }
  out.push("");
  return out.join("\n");
}
