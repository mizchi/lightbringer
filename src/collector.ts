import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  test as base,
  type CDPSession,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { toOtelSpans, type OtelSpan } from "./otel";

// ---------------------------------------------------------------------------
// Per-step performance collector for Playwright.
//
// Measures the "after interaction" performance of a scenario. Each measured
// region (span) is broken down into:
//   - network (CDP) ........ how long fetches blocked the step
//   - cpu (long task / LoAF) how long the main thread was occupied
//   - render (CDP metrics) . style recalc / layout / paint / GPU
// so that the only way to move the number is to change the implementation,
// not how the test waits.
//
// All times are unified to epoch ms for correlation. Spans use
// performance.timeOrigin + performance.now(); CDP network uses wallTime; both
// derive from the system clock, so they line up across navigations.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// web-vitals' attribution iife declares `var webVitals = ...` at top level.
// addInitScript runs inside a function wrapper, so the var never reaches window.
// We append an explicit assignment so it is available at document-start.
// The deep iife path is not in web-vitals' "exports", so resolve the package
// main and locate the iife next to it.
const WEB_VITALS_IIFE =
  fs.readFileSync(
    path.join(
      path.dirname(require.resolve("web-vitals")),
      "web-vitals.attribution.iife.js",
    ),
    "utf8",
  ) + "\n;globalThis.webVitals=webVitals;";

const PERF_OUT_DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

/** With PERF_TRACE=1, save a Chrome trace (openable in DevTools / Perfetto). */
const TRACE_ENABLED = process.env.PERF_TRACE === "1";

// ---------------------------------------------------------------------------
// Report types (the contract layer)
// ---------------------------------------------------------------------------

export interface VitalSample {
  value: number;
  rating: string;
  attribution: Record<string, unknown>;
}

/** Network breakdown of a span (network bottleneck analysis). */
export interface SpanNetwork {
  requestCount: number;
  encodedKB: number;
  /** Wall time the network was busy during the span (union of request intervals, ms). */
  busyMs: number;
  /** Waterfall waves = approximate depth of serial dependency. 1 = one parallel wave. */
  waves: number;
  requests: Array<{
    url: string;
    type: string;
    /** start offset relative to the span start (ms) */
    startOffsetMs: number;
    durationMs: number;
    kb: number;
  }>;
}

/** CPU breakdown of a span (CPU bottleneck analysis). */
export interface SpanCpu {
  longTaskCount: number;
  /** total long task time (ms), approx. main-thread blocking */
  blockingMs: number;
  maxLongTaskMs: number;
  loafCount: number;
  /** blockingDuration of the heaviest LoAF (ms) */
  maxLoafBlockingMs: number;
}

/**
 * Render breakdown of a span (DOM change -> style recalc -> layout -> paint).
 * style/layout/script come from CDP Performance.getMetrics cumulative counters.
 * paint/GPU are filled from the trace when PERF_TRACE=1 (undefined otherwise).
 */
export interface SpanRender {
  recalcStyleCount: number;
  recalcStyleMs: number;
  layoutCount: number;
  layoutMs: number;
  /** JS execution time in the span (ms, CDP metric; distinct from cpu.blockingMs) */
  scriptMs: number;
  paintCount?: number;
  paintMs?: number;
  gpuMs?: number;
}

export interface SpanReport {
  name: string;
  /** measured time from action start until settle (ms) */
  durationMs: number;
  network: SpanNetwork;
  cpu: SpanCpu;
  render: SpanRender;
  /** span window in trace clock (monotonic μs). Used by the drilldown script. */
  traceWindowUs: [number, number];
}

/**
 * A User Timing (performance.measure) emitted from app code, converted to an OTel
 * span. Sits inside the operation-unit SpanReport to show which implementation
 * region spent the network / CPU.
 */
export interface AppSpanReport extends OtelSpan {
  network: SpanNetwork;
  cpu: SpanCpu;
}

export interface NetworkReport {
  totalRequests: number;
  totalEncodedKB: number;
  byType: Record<string, { count: number; encodedKB: number }>;
  slowest: Array<{ url: string; type: string; durationMs: number; kb: number }>;
}

export interface PerfReport {
  title: string;
  url: string;
  vitals: Record<string, VitalSample>;
  spans: SpanReport[];
  /** spans derived from app-code measures (OTel shape) */
  appSpans: AppSpanReport[];
  /** scenario-wide network total */
  network: NetworkReport;
  tracePath?: string;
}

/** Strategy that waits until the page has settled after an action. */
export type Settle = (page: Page) => Promise<void>;

/** Default settle: wait for two animation frames (ensures at least one painted frame). */
const defaultSettle: Settle = (page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

// ---------------------------------------------------------------------------
// Browser-side collector (injected at document-start via addInitScript).
// Stringified and run inside the page, so it must be fully self-contained.
// long task / LoAF are stored in performance.now() time and shifted to epoch ms
// at aggregation using timeOrigin.
// ---------------------------------------------------------------------------

interface BrowserMetric {
  name: string;
  value: number;
  rating: string;
  attribution?: Record<string, unknown>;
}

interface PerfWindow {
  webVitals?: {
    onLCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onCLS: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onINP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onTTFB: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onFCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
  };
  __perf?: {
    vitals: Record<string, BrowserMetric>;
    longTasks: Array<{ start: number; duration: number }>;
    loaf: Array<{ start: number; duration: number; blocking: number }>;
    measures: Array<{
      name: string;
      start: number;
      duration: number;
      detail: unknown;
    }>;
  };
}

function browserCollector() {
  const w = window as unknown as PerfWindow;
  w.__perf = { vitals: {}, longTasks: [], loaf: [], measures: [] };
  const store = w.__perf;

  const record = (m: BrowserMetric) => {
    store.vitals[m.name] = m;
  };
  const wv = w.webVitals;
  if (wv) {
    wv.onLCP(record, { reportAllChanges: true });
    wv.onCLS(record, { reportAllChanges: true });
    wv.onINP(record, { reportAllChanges: true });
    wv.onTTFB(record);
    wv.onFCP(record);
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        store.longTasks.push({ start: e.startTime, duration: e.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported */
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const loaf = e as PerformanceEntry & { blockingDuration?: number };
        store.loaf.push({
          start: loaf.startTime,
          duration: loaf.duration,
          blocking: loaf.blockingDuration ?? 0,
        });
      }
    }).observe({
      type: "long-animation-frame",
      buffered: true,
    } as PerformanceObserverInit);
  } catch {
    /* LoAF unsupported */
  }

  // Collect app-emitted User Timing measures. PerformanceMeasure.toJSON() omits
  // detail, so read entry.detail directly here. Only collect measures carrying
  // the __lbSpan sentinel to skip framework measures (React Mount/Update, etc.).
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const measure = e as PerformanceEntry & { detail?: unknown };
        const detail = measure.detail;
        if (
          !detail ||
          typeof detail !== "object" ||
          (detail as { __lbSpan?: unknown }).__lbSpan !== true
        ) {
          continue;
        }
        store.measures.push({
          name: measure.name,
          start: measure.startTime,
          duration: measure.duration,
          detail,
        });
      }
    }).observe({ type: "measure", buffered: true });
  } catch {
    /* measure unsupported */
  }
}

// ---------------------------------------------------------------------------
// Span controller. Span boundaries are kept on the node side in epoch ms,
// because storing them in the page would reset them on navigation.
// ---------------------------------------------------------------------------

interface RawSpan {
  name: string;
  startEpochMs: number;
  endEpochMs: number;
  render: SpanRender;
  /** span window in trace clock (monotonic μs) for correlation / drilldown */
  traceStartUs: number;
  traceEndUs: number;
}

/** CDP Performance.getMetrics cumulative counter delta -> render cost */
function diffMetrics(
  before: Record<string, number>,
  after: Record<string, number>,
): SpanRender {
  const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  return {
    recalcStyleCount: d("RecalcStyleCount"),
    recalcStyleMs: round(d("RecalcStyleDuration") * 1000),
    layoutCount: d("LayoutCount"),
    layoutMs: round(d("LayoutDuration") * 1000),
    scriptMs: round(d("ScriptDuration") * 1000),
  };
}

export class PerfController {
  readonly spans: RawSpan[] = [];
  constructor(
    private page: Page,
    private client: CDPSession,
    private settle: Settle = defaultSettle,
  ) {}

  /**
   * Measure a named operation. Runs action, waits for the page to settle, and
   * records the region as one span. Include your waitFor assertions inside
   * action so the span covers "until the operation is done", then its
   * network / CPU / render breakdown can be correlated afterwards.
   */
  async measure(
    name: string,
    action: () => Promise<void>,
    opts: { settle?: Settle } = {},
  ): Promise<void> {
    const startEpochMs = await this.now();
    const before = await this.metrics();
    await action();
    await (opts.settle ?? this.settle)(this.page);
    const endEpochMs = await this.now();
    const after = await this.metrics();
    this.spans.push({
      name,
      startEpochMs,
      endEpochMs,
      render: diffMetrics(before, after),
      // getMetrics Timestamp (monotonic seconds) shares the clock with trace ts (μs).
      traceStartUs: (before.Timestamp ?? 0) * 1e6,
      traceEndUs: (after.Timestamp ?? 0) * 1e6,
    });
  }

  private now(): Promise<number> {
    return this.page.evaluate(() => performance.timeOrigin + performance.now());
  }

  private async metrics(): Promise<Record<string, number>> {
    const res = (await this.client.send("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>;
    };
    const out: Record<string, number> = {};
    for (const m of res.metrics) out[m.name] = m.value;
    return out;
  }
}

// ---------------------------------------------------------------------------
// CDP network capture (epoch ms).
// requestWillBeSent carries both timestamp (monotonic s) and wallTime (epoch s).
// loadingFinished carries timestamp (monotonic s) only, hence:
//   startEpochMs = wallTime * 1000
//   endEpochMs   = startEpochMs + (endMono - startMono) * 1000
// ---------------------------------------------------------------------------

interface NetReq {
  url: string;
  type: string;
  startMono: number;
  startEpochMs: number;
  endEpochMs?: number;
  encoded?: number;
}

async function startNetworkCapture(
  client: CDPSession,
): Promise<() => NetReq[]> {
  const reqs = new Map<string, NetReq>();
  await client.send("Network.enable");

  client.on("Network.requestWillBeSent", (e) => {
    const p = e as unknown as {
      requestId: string;
      request: { url: string };
      type?: string;
      timestamp: number;
      wallTime: number;
    };
    reqs.set(p.requestId, {
      url: p.request.url,
      type: p.type ?? "Other",
      startMono: p.timestamp,
      startEpochMs: p.wallTime * 1000,
    });
  });
  client.on("Network.responseReceived", (e) => {
    const p = e as unknown as { requestId: string; type?: string };
    const r = reqs.get(p.requestId);
    if (r && p.type) r.type = p.type;
  });
  client.on("Network.loadingFinished", (e) => {
    const p = e as unknown as {
      requestId: string;
      timestamp: number;
      encodedDataLength: number;
    };
    const r = reqs.get(p.requestId);
    if (r) {
      r.endEpochMs = r.startEpochMs + (p.timestamp - r.startMono) * 1000;
      r.encoded = p.encodedDataLength;
    }
  });

  return () => [...reqs.values()];
}

// ---------------------------------------------------------------------------
// Chrome trace capture (opt-in)
// ---------------------------------------------------------------------------

async function startTrace(
  client: CDPSession,
): Promise<() => Promise<unknown[]>> {
  const events: unknown[] = [];
  client.on("Tracing.dataCollected", (e) => {
    const p = e as unknown as { value: unknown[] };
    events.push(...p.value);
  });
  await client.send("Tracing.start", {
    transferMode: "ReportEvents",
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink.user_timing",
      "loading",
      "latencyInfo",
      "v8.execute",
      "gpu",
    ].join(","),
  });
  return async () => {
    const done = new Promise<void>((resolve) => {
      client.once("Tracing.tracingComplete", () => resolve());
    });
    await client.send("Tracing.end");
    await done;
    return events;
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Length of the union of intervals. Used for network busy time. */
function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

function pickAttribution(
  name: string,
  attr: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attr) return {};
  const keys: Record<string, string[]> = {
    LCP: [
      "element",
      "url",
      "timeToFirstByte",
      "resourceLoadDelay",
      "resourceLoadDuration",
      "elementRenderDelay",
    ],
    INP: [
      "interactionTarget",
      "interactionType",
      "inputDelay",
      "processingDuration",
      "presentationDelay",
    ],
    CLS: ["largestShiftTarget", "largestShiftValue"],
  };
  const wanted = keys[name];
  if (!wanted) return {};
  const out: Record<string, unknown> = {};
  for (const k of wanted) {
    if (attr[k] !== undefined) out[k] = attr[k];
  }
  return out;
}

function buildGlobalNetwork(reqs: NetReq[]): NetworkReport {
  const byType: NetworkReport["byType"] = {};
  let totalEncoded = 0;
  const finished: NetworkReport["slowest"] = [];
  for (const r of reqs) {
    const encoded = r.encoded ?? 0;
    totalEncoded += encoded;
    const bucket = (byType[r.type] ??= { count: 0, encodedKB: 0 });
    bucket.count += 1;
    bucket.encodedKB += encoded / 1024;
    if (r.endEpochMs != null) {
      finished.push({
        url: r.url,
        type: r.type,
        durationMs: round(r.endEpochMs - r.startEpochMs),
        kb: round(encoded / 1024),
      });
    }
  }
  for (const b of Object.values(byType)) b.encodedKB = round(b.encodedKB);
  finished.sort((a, b) => b.durationMs - a.durationMs);
  return {
    totalRequests: reqs.length,
    totalEncodedKB: round(totalEncoded / 1024),
    byType,
    slowest: finished.slice(0, 8),
  };
}

interface EpochWindow {
  startEpochMs: number;
  endEpochMs: number;
}

function buildSpanNetwork(span: EpochWindow, reqs: NetReq[]): SpanNetwork {
  const intervals: Array<[number, number]> = [];
  const requests: SpanNetwork["requests"] = [];
  let encoded = 0;
  for (const r of reqs) {
    const end = r.endEpochMs ?? r.startEpochMs;
    if (r.startEpochMs > span.endEpochMs || end < span.startEpochMs) continue;
    encoded += r.encoded ?? 0;
    const clipStart = Math.max(r.startEpochMs, span.startEpochMs);
    const clipEnd = Math.min(end, span.endEpochMs);
    if (clipEnd > clipStart) intervals.push([clipStart, clipEnd]);
    requests.push({
      url: r.url,
      type: r.type,
      startOffsetMs: round(r.startEpochMs - span.startEpochMs),
      durationMs: round(end - r.startEpochMs),
      kb: round((r.encoded ?? 0) / 1024),
    });
  }
  requests.sort((a, b) => b.durationMs - a.durationMs);
  return {
    requestCount: requests.length,
    encodedKB: round(encoded / 1024),
    busyMs: round(unionLength(intervals)),
    waves: countWaves(intervals),
    requests,
  };
}

/**
 * Number of waterfall waves = approximate serial dependency depth. Scans request
 * intervals in start order; a request that starts after the running wave's max
 * end time begins a new wave. 1 = fully parallel, higher = deeper fetch chains.
 */
function countWaves(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let waves = 1;
  let waveEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > waveEnd) {
      waves += 1;
      waveEnd = e;
    } else {
      waveEnd = Math.max(waveEnd, e);
    }
  }
  return waves;
}

interface TraceEvent {
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
}

/**
 * Aggregate Paint count/time and GPU task time within a span window (monotonic μs).
 * The span window comes from getMetrics Timestamp, the same clock as trace ts, so
 * no conversion is needed.
 */
function buildTraceRender(
  events: TraceEvent[],
  startUs: number,
  endUs: number,
): Pick<SpanRender, "paintCount" | "paintMs" | "gpuMs"> {
  let paintCount = 0;
  let paintMs = 0;
  let gpuMs = 0;
  for (const e of events) {
    if (e.ph !== "X" || e.ts == null || e.dur == null) continue;
    if (e.ts < startUs || e.ts > endUs) continue;
    if (e.name === "Paint") {
      paintCount += 1;
      paintMs += e.dur / 1000;
    } else if (e.name === "GPUTask") {
      gpuMs += e.dur / 1000;
    }
  }
  return { paintCount, paintMs: round(paintMs), gpuMs: round(gpuMs) };
}

function buildSpanCpu(
  span: EpochWindow,
  longTasks: Array<{ epochStart: number; duration: number }>,
  loaf: Array<{ epochStart: number; duration: number; blocking: number }>,
): SpanCpu {
  const inWindow = (epochStart: number) =>
    epochStart >= span.startEpochMs && epochStart <= span.endEpochMs;
  const lt = longTasks.filter((t) => inWindow(t.epochStart));
  const lf = loaf.filter((l) => inWindow(l.epochStart));
  return {
    longTaskCount: lt.length,
    blockingMs: round(lt.reduce((a, t) => a + t.duration, 0)),
    maxLongTaskMs: round(lt.reduce((a, t) => Math.max(a, t.duration), 0)),
    loafCount: lf.length,
    maxLoafBlockingMs: round(lf.reduce((a, l) => Math.max(a, l.blocking), 0)),
  };
}

function buildReport(
  testInfo: TestInfo,
  url: string,
  raw: NonNullable<PerfWindow["__perf"]>,
  timeOrigin: number,
  spans: RawSpan[],
  reqs: NetReq[],
  traceEvents?: TraceEvent[],
): PerfReport {
  const vitals: Record<string, VitalSample> = {};
  for (const [name, m] of Object.entries(raw.vitals)) {
    vitals[name] = {
      value: round(m.value),
      rating: m.rating,
      attribution: pickAttribution(name, m.attribution),
    };
  }

  const longTasks = raw.longTasks.map((t) => ({
    epochStart: timeOrigin + t.start,
    duration: t.duration,
  }));
  const loaf = raw.loaf.map((l) => ({
    epochStart: timeOrigin + l.start,
    duration: l.duration,
    blocking: l.blocking,
  }));

  const spanReports: SpanReport[] = spans.map((s) => {
    const render = traceEvents
      ? {
          ...s.render,
          ...buildTraceRender(traceEvents, s.traceStartUs, s.traceEndUs),
        }
      : s.render;
    return {
      name: s.name,
      durationMs: round(s.endEpochMs - s.startEpochMs),
      network: buildSpanNetwork(s, reqs),
      cpu: buildSpanCpu(s, longTasks, loaf),
      render,
      traceWindowUs: [s.traceStartUs, s.traceEndUs],
    };
  });

  // app measures -> OTel spans -> network/CPU correlation.
  // __perf.measures uses `start`, PerfMeasureLike uses `startTime`; remap.
  const measureLikes = raw.measures.map((m) => ({
    name: m.name,
    startTime: m.start,
    duration: m.duration,
    detail: m.detail,
  }));
  const appSpans: AppSpanReport[] = toOtelSpans(measureLikes, timeOrigin).map(
    (s) => {
      const win: EpochWindow = {
        startEpochMs: s.startUnixMs,
        endEpochMs: s.endUnixMs,
      };
      return {
        ...s,
        network: buildSpanNetwork(win, reqs),
        cpu: buildSpanCpu(win, longTasks, loaf),
      };
    },
  );

  return {
    title: testInfo.title,
    url,
    vitals,
    spans: spanReports,
    appSpans,
    network: buildGlobalNetwork(reqs),
  };
}

function logSummary(report: PerfReport): void {
  const lines: string[] = [`\n[perf] ${report.title}`];
  const v = report.vitals;
  const fmt = (s?: VitalSample) => (s ? `${s.value} (${s.rating})` : "n/a");
  lines.push(
    `  vitals  LCP=${fmt(v.LCP)}  INP=${fmt(v.INP)}  CLS=${fmt(v.CLS)}  TTFB=${fmt(v.TTFB)}`,
  );
  for (const s of report.spans) {
    lines.push(
      `  ${s.name.padEnd(26)} ${String(s.durationMs).padStart(7)}ms`,
    );
    lines.push(
      `      net   busy=${s.network.busyMs}ms  ${s.network.requestCount}reqs  ${s.network.waves}waves  ${s.network.encodedKB}KB`,
    );
    lines.push(
      `      cpu   block=${s.cpu.blockingMs}ms  longtasks=${s.cpu.longTaskCount}` +
        `  maxTask=${s.cpu.maxLongTaskMs}ms  loaf=${s.cpu.loafCount}/${s.cpu.maxLoafBlockingMs}ms`,
    );
    const r = s.render;
    const paint =
      r.paintCount !== undefined
        ? `  paint=${r.paintCount}/${r.paintMs}ms  gpu=${r.gpuMs}ms`
        : "";
    lines.push(
      `      render style=${r.recalcStyleCount}/${r.recalcStyleMs}ms` +
        `  layout=${r.layoutCount}/${r.layoutMs}ms  script=${r.scriptMs}ms${paint}`,
    );
  }
  if (report.appSpans.length > 0) {
    const depthOf = (s: AppSpanReport): number => {
      if (!s.parentSpanId) return 0;
      const parent = report.appSpans.find((p) => p.spanId === s.parentSpanId);
      return parent ? depthOf(parent) + 1 : 0;
    };
    lines.push("  app spans (performance.measure):");
    for (const s of report.appSpans) {
      const indent = "    " + "  ".repeat(depthOf(s));
      lines.push(
        `${indent}${s.name} ${round(s.durationMs)}ms` +
          `  net=${s.network.busyMs}ms/${s.network.encodedKB}KB  cpu=${s.cpu.blockingMs}ms`,
      );
    }
  }
  lines.push(
    `  total network ${report.network.totalRequests} reqs / ${report.network.totalEncodedKB}KB`,
  );
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

export const test = base.extend<{ perf: PerfController }>({
  perf: async ({ page }, use, testInfo) => {
    await page.addInitScript({ content: WEB_VITALS_IIFE });
    await page.addInitScript(browserCollector);

    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const finishNetwork = await startNetworkCapture(client);
    const finishTrace = TRACE_ENABLED ? await startTrace(client) : undefined;

    const controller = new PerfController(page, client);
    await use(controller);

    const raw = await page
      .evaluate(() => (window as unknown as PerfWindow).__perf)
      .catch(() => undefined);
    const timeOrigin = await page
      .evaluate(() => performance.timeOrigin)
      .catch(() => 0);
    const url = page.url();
    const reqs = finishNetwork();
    // finish the trace before buildReport so Paint/GPU can correlate to spans
    const traceEvents = finishTrace
      ? ((await finishTrace()) as TraceEvent[])
      : undefined;

    fs.mkdirSync(PERF_OUT_DIR, { recursive: true });
    const slug = testInfo.title.replace(/[^\p{L}\p{N}_]+/gu, "_");
    // run index keeps files from colliding under --repeat-each=N.
    // The median script aggregates <slug>.run*.json.
    const runTag = `run${testInfo.repeatEachIndex}`;

    const report = buildReport(
      testInfo,
      url,
      raw ?? { vitals: {}, longTasks: [], loaf: [], measures: [] },
      timeOrigin,
      controller.spans,
      reqs,
      traceEvents,
    );

    if (traceEvents) {
      const tracePath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.trace.json`);
      fs.writeFileSync(tracePath, JSON.stringify(traceEvents));
      report.tracePath = tracePath;
    }

    const jsonPath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    await testInfo.attach("perf-report", {
      path: jsonPath,
      contentType: "application/json",
    });

    logSummary(report);
  },
});

export { expect } from "@playwright/test";
