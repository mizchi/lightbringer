/**
 * Drill down into one span: aggregate the trace within the span window to find
 * which subsystem / function spends CPU. A generic way to locate the cause of a
 * span's CPU cost.
 *
 * Requires PERF_TRACE=1 so that <slug>.run<idx>.json and <slug>.run<idx>.trace.json
 * both exist (span.traceWindowUs is matched against the trace).
 *
 * Usage:
 *   PERF_TRACE=1 pnpm exec playwright test
 *   node scripts/drilldown.mjs <slug> <spanName> [run=0] [topN=15]
 *
 * Output: total RunTask time in the span window, an event-name breakdown (which
 * subsystem), and a function-level breakdown (functionName @ url:line).
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function shorten(url) {
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70);
}

const [, , slug, spanName, runArg, topArg] = process.argv;
if (!slug || !spanName) {
  die("usage: node scripts/drilldown.mjs <slug> <spanName> [run] [topN]");
}
const run = runArg ?? "0";
const topN = Number(topArg ?? 15);

const reportPath = path.join(DIR, `${slug}.run${run}.json`);
const tracePath = path.join(DIR, `${slug}.run${run}.trace.json`);
if (!fs.existsSync(reportPath)) die(`not found: ${reportPath}`);
if (!fs.existsSync(tracePath))
  die(`not found: ${tracePath} (measured with PERF_TRACE=1?)`);

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const span = report.spans.find((s) => s.name === spanName);
if (!span) {
  die(
    `span "${spanName}" not found. candidates: ${report.spans.map((s) => s.name).join(", ")}`,
  );
}
const [startUs, endUs] = span.traceWindowUs;
const events = JSON.parse(fs.readFileSync(tracePath, "utf8"));

const inWindow = events.filter(
  (e) => e.ph === "X" && e.ts != null && e.ts >= startUs && e.ts <= endUs,
);

const tasks = inWindow
  .filter((e) => e.name === "RunTask")
  .map((e) => e.dur / 1000);
const taskTotal = tasks.reduce((a, d) => a + d, 0);
const longTasks = tasks.filter((d) => d >= 50).sort((a, b) => b - a);

// event-name breakdown: which subsystem is heavy (RunTask excluded as a container)
const byName = new Map();
for (const e of inWindow) {
  if (!e.name || e.name === "RunTask" || e.dur == null) continue;
  const cur = byName.get(e.name) ?? { totalMs: 0, count: 0 };
  cur.totalMs += e.dur / 1000;
  cur.count += 1;
  byName.set(e.name, cur);
}
const nameRanked = [...byName.entries()]
  .map(([name, v]) => ({ name, totalMs: round(v.totalMs), count: v.count }))
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, 12);

// function-level breakdown (FunctionCall / EvaluateScript)
const byFn = new Map();
for (const e of inWindow) {
  const d = e.args?.data;
  if (!d) continue;
  let key;
  if (e.name === "FunctionCall") {
    const fn = d.functionName || "(anonymous)";
    const loc = d.url ? `${shorten(d.url)}:${d.lineNumber ?? "?"}` : "";
    key = `${fn}  ${loc}`;
  } else if (e.name === "EvaluateScript" || e.name === "v8.compile") {
    key = `(eval) ${shorten(d.url || "")}`;
  } else {
    continue;
  }
  const cur = byFn.get(key) ?? { totalMs: 0, count: 0 };
  cur.totalMs += e.dur / 1000;
  cur.count += 1;
  byFn.set(key, cur);
}
const fnRanked = [...byFn.entries()]
  .map(([key, v]) => ({ key, totalMs: round(v.totalMs), count: v.count }))
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, topN);

console.log(`\n[drilldown] ${slug}`);
console.log(
  `span "${spanName}"  dur=${span.durationMs}ms  cpu.block=${span.cpu.blockingMs}ms  render.script=${span.render.scriptMs}ms`,
);
console.log(
  `  RunTask total ${round(taskTotal)}ms / ${tasks.length} tasks` +
    `  (long tasks >=50ms: ${longTasks.map((d) => round(d) + "ms").join(", ") || "none"})`,
);
console.log(`\n  event-name total time (which subsystem):`);
for (const r of nameRanked) {
  console.log(`    ${String(r.totalMs).padStart(8)}ms x${r.count}  ${r.name}`);
}
console.log(`\n  function total time top ${topN} (includes children):`);
if (fnRanked.length === 0) {
  console.log(
    "    no matching events (v8.execute category may be missing from the trace)",
  );
}
for (const r of fnRanked) {
  console.log(`    ${String(r.totalMs).padStart(8)}ms x${r.count}  ${r.key}`);
}
