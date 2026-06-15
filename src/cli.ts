#!/usr/bin/env node
// lightbringer CLI — measure a scenario with zero spec/setup.
//
//   npx lightbringer run scenario.json [flags]
//
// scenario.json: { url, viewport?, settle?, steps: [{ name, goto?, click?, fill?,
//   text?, drag?, by?, press?, waitFor?, wait?, settle? }] }
// Each step becomes one measured span. Flags below; --emit-budgets writes a budget
// file from the measured medians and --gate fails against it (no hand-set numbers).
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type BrowserContextOptions } from "playwright";
import { startSession, logSummary, type PerfReport, type SpanReport } from "./collector";

interface Step {
  name: string;
  goto?: string;
  click?: string;
  fill?: string;
  text?: string;
  drag?: string;
  by?: [number, number];
  press?: string;
  waitFor?: string;
  wait?: number;
  settle?: SettleSpec;
}
interface Scenario {
  url: string;
  viewport?: { width: number; height: number };
  settle?: SettleSpec;
  steps: Step[];
}
type SettleSpec = "networkidle" | "load" | "raf" | number;

// ── arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv[0] !== "run" || !argv[1]) {
  console.error(
    "usage: lightbringer run <scenario.json> [--repeat N] [--out DIR]\n" +
      "       [--gpu] [--cpu N] [--net slow-3g|fast-3g|4g] [--cov] [--mem] [--css]\n" +
      "       [--trace] [--headed] [--emit-budgets] [--gate]",
  );
  process.exit(1);
}
const scenarioPath = argv[1];
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const opt = (name: string, def?: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const repeat = Math.max(1, Number(opt("repeat", "1")));
const outDir = path.resolve(opt("out", "perf-results")!);
const cpuRate = Number(opt("cpu", "1"));
const netName = opt("net");
const gpu = flags.has("--gpu");
const headed = flags.has("--headed");
const cov = flags.has("--cov");
const mem = flags.has("--mem");
const css = flags.has("--css");
const trace = flags.has("--trace") || css;
const emitBudgets = flags.has("--emit-budgets");
const gate = flags.has("--gate");

const NET_PROFILES: Record<string, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  "slow-3g": { latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200 },
  "fast-3g": { latency: 150, downloadThroughput: 196_608, uploadThroughput: 98_304 },
  "4g": { latency: 40, downloadThroughput: 1_179_648, uploadThroughput: 589_824 },
};
const netProfile = netName ? NET_PROFILES[netName] ?? null : null;

// ── scenario ────────────────────────────────────────────────────────────────
const scenario: Scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const slug = path.basename(scenarioPath).replace(/\.json$/, "").replace(/[^\p{L}\p{N}_]+/gu, "_");

function settleFn(spec: SettleSpec | undefined) {
  const s = spec ?? scenario.settle ?? "networkidle";
  if (s === "raf") return undefined; // use the library default (2 rAF)
  if (typeof s === "number") return (p: Page) => p.waitForTimeout(s);
  return (p: Page) => p.waitForLoadState(s).catch(() => {});
}

async function applyStep(page: Page, step: Step) {
  if (step.goto != null) await page.goto(new URL(step.goto, scenario.url).href);
  if (step.fill != null) await page.fill(step.fill, step.text ?? "");
  if (step.click != null) await page.click(step.click, { timeout: 8000 });
  if (step.press != null) await page.keyboard.press(step.press);
  if (step.drag != null) {
    const box = await page.locator(step.drag).first().boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const [dx, dy] = step.by ?? [-200, -150];
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
      await page.mouse.up();
    }
  }
  if (step.waitFor != null) await page.locator(step.waitFor).first().waitFor({ timeout: 15000 });
  if (step.wait != null) await page.waitForTimeout(step.wait);
}

async function runOnce(index: number): Promise<PerfReport> {
  const browser = await chromium.launch({
    headless: !headed,
    args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"] : [],
  });
  try {
    const ctxOpts: BrowserContextOptions = scenario.viewport ? { viewport: scenario.viewport } : {};
    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    fs.mkdirSync(outDir, { recursive: true });
    const tracePath = path.join(outDir, `${slug}.run${index}.trace.json`);
    const session = await startSession(page, client, {
      cpuRate,
      netProfile,
      coverage: cov,
      memGc: mem,
      cssStats: css,
      trace,
      tracePath,
    });
    for (const step of scenario.steps) {
      await session.controller.measure(step.name, () => applyStep(page, step), {
        settle: settleFn(step.settle),
      });
    }
    const { report, covArtifact } = await session.finish(scenario.url);
    fs.writeFileSync(path.join(outDir, `${slug}.run${index}.json`), JSON.stringify(report, null, 2));
    if (covArtifact)
      fs.writeFileSync(path.join(outDir, `${slug}.run${index}.coverage.json`), JSON.stringify(covArtifact));
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

// ── median + budgets ──────────────────────────────────────────────────────
const METRICS: Record<string, (s: SpanReport) => number | undefined> = {
  durationMs: (s) => s.durationMs,
  scriptMs: (s) => s.render.scriptMs,
  blockingMs: (s) => s.cpu.blockingMs,
  layoutCount: (s) => s.render.layoutCount,
  recalcStyleMs: (s) => s.render.recalcStyleMs,
  encodedKB: (s) => s.network.encodedKB,
  requestCount: (s) => s.network.requestCount,
  interactionMs: (s) => s.interaction?.maxDurationMs,
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** spanName -> metric -> median across runs */
function medians(runs: PerfReport[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const names = [...new Set(runs.flatMap((r) => r.spans.map((s) => s.name)))];
  for (const name of names) {
    const spans = runs.flatMap((r) => r.spans.filter((s) => s.name === name));
    out[name] = {};
    for (const [k, get] of Object.entries(METRICS)) {
      const vals = spans.map(get).filter((v): v is number => typeof v === "number");
      if (vals.length) out[name]![k] = Math.round(median(vals) * 10) / 10;
    }
  }
  return out;
}

async function main() {
  const runs: PerfReport[] = [];
  for (let i = 0; i < repeat; i++) {
    process.stderr.write(`[lightbringer] run ${i + 1}/${repeat}\n`);
    runs.push(await runOnce(i));
  }
  logSummary(runs[runs.length - 1]!, mem);

  const budgetsPath = path.join(outDir, "lightbringer.budgets.json");
  if (emitBudgets) {
    // budget = median × 1.25 headroom, rounded — derived, not hand-set.
    const med = medians(runs);
    const budgets: Record<string, Record<string, number>> = {};
    for (const [span, metrics] of Object.entries(med)) {
      budgets[span] = {};
      for (const [k, v] of Object.entries(metrics)) budgets[span]![k] = Math.ceil(v * 1.25);
    }
    fs.writeFileSync(budgetsPath, JSON.stringify(budgets, null, 2));
    console.log(`\n[lightbringer] wrote budgets → ${path.relative(process.cwd(), budgetsPath)} (median ×1.25)`);
  }

  if (gate) {
    if (!fs.existsSync(budgetsPath)) {
      console.error(`[lightbringer] --gate: no budgets at ${budgetsPath} (run --emit-budgets first)`);
      process.exit(1);
    }
    const budgets = JSON.parse(fs.readFileSync(budgetsPath, "utf8")) as Record<string, Record<string, number>>;
    const med = medians(runs);
    const violations: string[] = [];
    for (const [span, metrics] of Object.entries(budgets)) {
      for (const [k, limit] of Object.entries(metrics)) {
        const actual = med[span]?.[k];
        if (actual != null && actual > limit) violations.push(`${span}.${k} median=${actual} > budget ${limit}`);
      }
    }
    if (violations.length) {
      console.error(`\n[lightbringer] GATE FAILED (${violations.length}):`);
      for (const v of violations) console.error(`  ✗ ${v}`);
      process.exit(1);
    }
    console.log(`\n[lightbringer] gate passed (${Object.keys(budgets).length} spans).`);
  }
}

main().catch((e) => {
  if (String(e).includes("Executable doesn't exist") || String(e).includes("playwright install")) {
    console.error("[lightbringer] Chromium not installed. Run: npx playwright install chromium");
  } else {
    console.error(e);
  }
  process.exit(1);
});
