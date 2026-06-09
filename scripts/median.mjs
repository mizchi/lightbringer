/**
 * Aggregate multiple run reports (perf-results/<slug>.run*.json) into a median
 * with min..max per span / app span / vital.
 *
 * Usage:
 *   pnpm exec playwright test --repeat-each=5
 *   node scripts/median.mjs            # aggregate all slugs
 *   node scripts/median.mjs <slug>     # aggregate one slug
 *
 * A single run is noisy (JIT / cache / GC), so use the median for regression
 * checks and before/after comparisons. min..max is the noise band — how far you
 * can trust the number.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 10) / 10;
}

function stat(values) {
  return {
    median: median(values),
    min: Math.round(Math.min(...values) * 10) / 10,
    max: Math.round(Math.max(...values) * 10) / 10,
    n: values.length,
  };
}

function statBy(items, selector) {
  return stat(items.map(selector));
}

function aggregateSlug(slug, runs) {
  const vitalNames = new Set();
  for (const r of runs) for (const k of Object.keys(r.vitals)) vitalNames.add(k);
  const vitals = {};
  for (const name of vitalNames) {
    const vals = runs
      .map((r) => r.vitals[name]?.value)
      .filter((v) => typeof v === "number");
    if (vals.length) vitals[name] = stat(vals);
  }

  const spanNames = [];
  for (const r of runs)
    for (const s of r.spans)
      if (!spanNames.includes(s.name)) spanNames.push(s.name);
  const spans = spanNames.map((name) => {
    const items = runs.flatMap((r) => r.spans.filter((s) => s.name === name));
    const budget = items.find((s) => s.budget)?.budget;
    const hasPaint = items.some((s) => s.render?.paintCount !== undefined);
    const render = {
      recalcStyleCount: statBy(items, (s) => s.render?.recalcStyleCount ?? 0),
      recalcStyleMs: statBy(items, (s) => s.render?.recalcStyleMs ?? 0),
      layoutCount: statBy(items, (s) => s.render?.layoutCount ?? 0),
      layoutMs: statBy(items, (s) => s.render?.layoutMs ?? 0),
      scriptMs: statBy(items, (s) => s.render?.scriptMs ?? 0),
    };
    if (hasPaint) {
      render.paintCount = statBy(items, (s) => s.render?.paintCount ?? 0);
      render.paintMs = statBy(items, (s) => s.render?.paintMs ?? 0);
      render.gpuMs = statBy(items, (s) => s.render?.gpuMs ?? 0);
    }
    return {
      name,
      durationMs: statBy(items, (s) => s.durationMs),
      network: {
        busyMs: statBy(items, (s) => s.network.busyMs),
        waves: statBy(items, (s) => s.network.waves ?? 0),
        encodedKB: statBy(items, (s) => s.network.encodedKB),
        requestCount: statBy(items, (s) => s.network.requestCount),
      },
      cpu: {
        blockingMs: statBy(items, (s) => s.cpu.blockingMs),
        maxLongTaskMs: statBy(items, (s) => s.cpu.maxLongTaskMs),
      },
      render,
      budget,
    };
  });

  const appNames = [];
  for (const r of runs)
    for (const s of r.appSpans ?? [])
      if (!appNames.includes(s.name)) appNames.push(s.name);
  const appSpans = appNames.map((name) => {
    const items = runs.flatMap((r) =>
      (r.appSpans ?? []).filter((s) => s.name === name),
    );
    return {
      name,
      occurrences: items.length,
      durationMs: statBy(items, (s) => s.durationMs),
      network: { busyMs: statBy(items, (s) => s.network.busyMs) },
      cpu: { blockingMs: statBy(items, (s) => s.cpu.blockingMs) },
    };
  });

  return { slug, runs: runs.length, vitals, spans, appSpans };
}

function fmt(s) {
  return `${s.median} (${s.min}..${s.max})`;
}

// budget field -> aggregated median accessor
const MEDIAN_OF = {
  durationMs: (s) => s.durationMs.median,
  scriptMs: (s) => s.render.scriptMs.median,
  blockingMs: (s) => s.cpu.blockingMs.median,
  encodedKB: (s) => s.network.encodedKB.median,
  requestCount: (s) => s.network.requestCount.median,
  layoutCount: (s) => s.render.layoutCount.median,
};

/** Budget violations against the median (the statistically sound CI gate). */
function checkBudget(agg) {
  const out = [];
  for (const s of agg.spans) {
    if (!s.budget) continue;
    for (const [k, limit] of Object.entries(s.budget)) {
      if (limit == null || !MEDIAN_OF[k]) continue;
      const median = MEDIAN_OF[k](s);
      if (median > limit) {
        out.push(`${agg.slug} / ${s.name}.${k} median=${median} > budget ${limit}`);
      }
    }
  }
  return out;
}

function printSummary(agg) {
  const lines = [`\n[median] ${agg.slug}  (${agg.runs} runs)`];
  const v = agg.vitals;
  const vfmt = (name) => (v[name] ? fmt(v[name]) : "n/a");
  lines.push(
    `  vitals  LCP=${vfmt("LCP")}  INP=${vfmt("INP")}  CLS=${vfmt("CLS")}  TTFB=${vfmt("TTFB")}`,
  );
  for (const s of agg.spans) {
    lines.push(`  ${s.name}  ${fmt(s.durationMs)}ms`);
    lines.push(
      `      net    busy=${fmt(s.network.busyMs)}ms  reqs=${fmt(s.network.requestCount)}  waves=${fmt(s.network.waves)}  ${fmt(s.network.encodedKB)}KB`,
    );
    lines.push(
      `      cpu    block=${fmt(s.cpu.blockingMs)}ms  maxTask=${fmt(s.cpu.maxLongTaskMs)}ms`,
    );
    const r = s.render;
    const paint = r.paintCount
      ? `  paint=${fmt(r.paintCount)}/${fmt(r.paintMs)}ms  gpu=${fmt(r.gpuMs)}ms`
      : "";
    lines.push(
      `      render style=${fmt(r.recalcStyleCount)}/${fmt(r.recalcStyleMs)}ms  layout=${fmt(r.layoutCount)}/${fmt(r.layoutMs)}ms  script=${fmt(r.scriptMs)}ms${paint}`,
    );
  }
  if (agg.appSpans.length) {
    lines.push("  app spans (performance.measure):");
    for (const s of agg.appSpans) {
      lines.push(
        `    ${s.name} x${s.occurrences}  ${fmt(s.durationMs)}ms  net=${fmt(s.network.busyMs)}ms  cpu=${fmt(s.cpu.blockingMs)}ms`,
      );
    }
  }
  console.log(lines.join("\n"));
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`${DIR} not found. Run the playwright tests first.`);
    process.exit(1);
  }
  const filter = process.argv[2];
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /\.run\d+\.json$/.test(f) && !f.includes(".trace."));

  const bySlug = new Map();
  for (const f of files) {
    const slug = f.replace(/\.run\d+\.json$/, "");
    if (filter && slug !== filter) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)).push(f);
  }

  if (bySlug.size === 0) {
    console.error("No run reports found (<slug>.run*.json).");
    process.exit(1);
  }

  const violations = [];
  for (const [slug, runFiles] of bySlug) {
    const runs = runFiles.map((f) =>
      JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")),
    );
    const agg = aggregateSlug(slug, runs);
    fs.writeFileSync(
      path.join(DIR, `${slug}.median.json`),
      JSON.stringify(agg, null, 2),
    );
    printSummary(agg);
    violations.push(...checkBudget(agg));
  }

  if (violations.length > 0) {
    console.error(`\n[median] BUDGET EXCEEDED (${violations.length}):`);
    for (const v of violations) console.error(`  ! ${v}`);
    process.exit(1);
  }
}

main();
