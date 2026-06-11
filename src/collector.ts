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

/** PERF_CPU=N throttles the CPU N times (mid-tier device emulation). 1 = off. */
const CPU_RATE = Number(process.env.PERF_CPU ?? "1");

/** Max time to wait for settle before marking a span capped (ms). */
const SETTLE_TIMEOUT_MS = Number(process.env.PERF_SETTLE_TIMEOUT ?? "5000");

/**
 * PERF_NET selects a network emulation profile via CDP. Throughput in bytes/s,
 * latency in ms. Approximate DevTools-style presets.
 */
const NET_PROFILES: Record<
  string,
  { latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  "slow-3g": { latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200 },
  "fast-3g": { latency: 150, downloadThroughput: 196_608, uploadThroughput: 98_304 },
  "4g": { latency: 40, downloadThroughput: 1_179_648, uploadThroughput: 589_824 },
};
const NET_PROFILE = NET_PROFILES[process.env.PERF_NET ?? ""];

// ---------------------------------------------------------------------------
// Report types (the contract layer)
// ---------------------------------------------------------------------------

export interface VitalSample {
  value: number;
  rating: string;
  attribution: Record<string, unknown>;
}

/**
 * Cost a span incurs from third-party origins (analytics, tag managers, ad
 * tech, embedded widgets) — anything served from a registrable domain other
 * than the page's own. This is the "weight emitted by non-application scripts":
 * bytes the app didn't ship and network time it didn't ask for. CPU spent by
 * third-party scripts is attributed separately by the drilldown (PERF_TRACE),
 * which classifies CPU-profiler frames by their script URL host.
 */
export interface ThirdPartyBreakdown {
  requestCount: number;
  encodedKB: number;
  /** wall time third-party requests kept the network busy (union of intervals, ms) */
  busyMs: number;
  /** per registrable-domain breakdown, heaviest first (by bytes) */
  byDomain: Array<{
    domain: string;
    requestCount: number;
    encodedKB: number;
    busyMs: number;
  }>;
}

/** Network breakdown of a span (network bottleneck analysis). */
export interface SpanNetwork {
  requestCount: number;
  encodedKB: number;
  /** Wall time the network was busy during the span (union of request intervals, ms). */
  busyMs: number;
  /** Waterfall waves = approximate depth of serial dependency. 1 = one parallel wave. */
  waves: number;
  /** subset of this span's network attributable to third-party origins */
  thirdParty: ThirdPartyBreakdown;
  requests: Array<{
    url: string;
    type: string;
    /** start offset relative to the span start (ms) */
    startOffsetMs: number;
    durationMs: number;
    kb: number;
    /** true if served from a registrable domain other than the page's */
    thirdParty: boolean;
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
  /** net DOM nodes added during the span (CDP Nodes delta) — the driver of huge-DOM
   * style/layout cost. Not a memory metric; a render-cost cause. */
  nodes: number;
  /** JS execution time in the span (ms, CDP metric; distinct from cpu.blockingMs) */
  scriptMs: number;
  paintCount?: number;
  paintMs?: number;
  gpuMs?: number;
}

/**
 * Per-span budget. Each field is an upper bound; the median gate (and optional
 * inline assert) fails when the measured value exceeds it. scriptMs is the most
 * reliable bound (±1ms); duration/blocking are noisier — gate them on the median.
 */
export interface Budget {
  durationMs?: number;
  scriptMs?: number;
  blockingMs?: number;
  encodedKB?: number;
  requestCount?: number;
  waves?: number;
  busyMs?: number;
  layoutCount?: number;
  nodes?: number;
  /** upper bound on bytes loaded from third-party origins */
  thirdPartyKB?: number;
  /** upper bound on request count to third-party origins */
  thirdPartyRequestCount?: number;
  /** paint metrics are only present with PERF_TRACE=1; the gate is a no-op otherwise */
  paintMs?: number;
  paintCount?: number;
}

export interface SpanReport {
  name: string;
  /** measured time from action start until settle (ms) */
  durationMs: number;
  /** true if settle hit PERF_SETTLE_TIMEOUT (durationMs is then unreliable) */
  capped: boolean;
  network: SpanNetwork;
  cpu: SpanCpu;
  render: SpanRender;
  /** span window in trace clock (monotonic μs). Used by the drilldown script. */
  traceWindowUs: [number, number];
  /** declared budget, if any (carried into the report so the median gate can read it) */
  budget?: Budget;
}

/** Map a budget field to the actual value on a span report. */
const BUDGET_METRIC: Record<keyof Budget, (s: SpanReport) => number> = {
  durationMs: (s) => s.durationMs,
  scriptMs: (s) => s.render.scriptMs,
  blockingMs: (s) => s.cpu.blockingMs,
  encodedKB: (s) => s.network.encodedKB,
  requestCount: (s) => s.network.requestCount,
  waves: (s) => s.network.waves,
  busyMs: (s) => s.network.busyMs,
  layoutCount: (s) => s.render.layoutCount,
  nodes: (s) => s.render.nodes,
  thirdPartyKB: (s) => s.network.thirdParty.encodedKB,
  thirdPartyRequestCount: (s) => s.network.thirdParty.requestCount,
  paintMs: (s) => s.render.paintMs ?? 0,
  paintCount: (s) => s.render.paintCount ?? 0,
};

/** Budget violations on a single run (actual > budget). */
function checkBudgets(report: PerfReport): string[] {
  const out: string[] = [];
  for (const s of report.spans) {
    if (!s.budget) continue;
    for (const k of Object.keys(s.budget) as (keyof Budget)[]) {
      const limit = s.budget[k];
      if (limit == null) continue;
      const actual = BUDGET_METRIC[k](s);
      if (actual > limit) {
        out.push(`${s.name}.${k}=${actual} > budget ${limit}`);
      }
    }
  }
  if (report.vitalsBudget) {
    for (const k of Object.keys(report.vitalsBudget) as (keyof VitalsBudget)[]) {
      const limit = report.vitalsBudget[k];
      const actual = report.vitals[k]?.value;
      if (limit != null && actual != null && actual > limit) {
        out.push(`vitals.${k}=${actual} > budget ${limit}`);
      }
    }
  }
  return out;
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
  /** scenario-wide third-party total (bytes/requests the app didn't ship) */
  thirdParty: ThirdPartyBreakdown;
}

/** Upper bounds on page-global web-vitals (gated on the median, like span budgets). */
export interface VitalsBudget {
  LCP?: number;
  INP?: number;
  CLS?: number;
  TTFB?: number;
  FCP?: number;
}

export interface PerfReport {
  title: string;
  url: string;
  vitals: Record<string, VitalSample>;
  /** declared web-vitals budget, if any (carried so the median gate can read it) */
  vitalsBudget?: VitalsBudget;
  spans: SpanReport[];
  /** spans derived from app-code measures (OTel shape) */
  appSpans: AppSpanReport[];
  /** scenario-wide network total */
  network: NetworkReport;
  /** WebGL renderer string; "SwiftShader" means software GL (GPU numbers are fake) */
  glRenderer?: string;
  /** uncaught page errors during measurement; non-empty means results are suspect */
  pageErrors?: string[];
  /** true if the in-page collector never ran (e.g. page.setContent without a goto) */
  collectorMissing?: boolean;
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
    /** drain pending PerformanceObserver records into the store (see flush below) */
    flush?: () => void;
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

  // Handlers are shared between the observer callback and flush(): PerformanceObserver
  // callbacks fire asynchronously, so a long task at the very end of a span would be
  // missed if we read the store before the callback runs. flush() drains takeRecords()
  // right before the node side reads, fixing per-span attribution retroactively
  // (spans are matched by time window, not by arrival order).
  const drainLongTask = (entries: PerformanceEntryList) => {
    for (const e of entries)
      store.longTasks.push({ start: e.startTime, duration: e.duration });
  };
  const drainLoaf = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const loaf = e as PerformanceEntry & { blockingDuration?: number };
      store.loaf.push({
        start: loaf.startTime,
        duration: loaf.duration,
        blocking: loaf.blockingDuration ?? 0,
      });
    }
  };
  const drainMeasure = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const measure = e as PerformanceEntry & { detail?: unknown };
      const detail = measure.detail;
      // Only our own spans (the __lbSpan sentinel) — skip framework measures
      // (React Mount/Update, etc.). detail is read here because toJSON() omits it.
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
  };

  const observers: PerformanceObserver[] = [];
  const observe = (
    drain: (e: PerformanceEntryList) => void,
    init: PerformanceObserverInit,
  ) => {
    try {
      const obs = new PerformanceObserver((list) => drain(list.getEntries()));
      obs.observe(init);
      observers.push(obs);
    } catch {
      /* entry type unsupported */
    }
  };

  observe(drainLongTask, { type: "longtask", buffered: true });
  observe(drainLoaf, {
    type: "long-animation-frame",
    buffered: true,
  } as PerformanceObserverInit);
  observe(drainMeasure, { type: "measure", buffered: true });

  store.flush = () => {
    for (const obs of observers) {
      const records = obs.takeRecords();
      if (records.length === 0) continue;
      const type = records[0].entryType;
      if (type === "longtask") drainLongTask(records);
      else if (type === "long-animation-frame") drainLoaf(records);
      else if (type === "measure") drainMeasure(records);
    }
  };
}

// ---------------------------------------------------------------------------
// Span controller. Span boundaries are kept on the node side in epoch ms,
// because storing them in the page would reset them on navigation.
// ---------------------------------------------------------------------------

interface RawSpan {
  name: string;
  startEpochMs: number;
  endEpochMs: number;
  capped: boolean;
  render: SpanRender;
  /** span window in trace clock (monotonic μs) for correlation / drilldown */
  traceStartUs: number;
  traceEndUs: number;
  budget?: Budget;
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
    nodes: d("Nodes"),
    scriptMs: round(d("ScriptDuration") * 1000),
  };
}

export class PerfController {
  readonly spans: RawSpan[] = [];
  vitalsBudget: VitalsBudget = {};
  constructor(
    private page: Page,
    private client: CDPSession,
    private settle: Settle = defaultSettle,
  ) {}

  /** Declare upper bounds on web-vitals (LCP / INP / CLS / TTFB / FCP) for this test. */
  setVitalsBudget(budget: VitalsBudget): void {
    this.vitalsBudget = budget;
  }

  /**
   * Measure a named operation. Runs action, waits for the page to settle, and
   * records the region as one span. Include your waitFor assertions inside
   * action so the span covers "until the operation is done", then its
   * network / CPU / render breakdown can be correlated afterwards.
   */
  async measure(
    name: string,
    action: () => Promise<void>,
    opts: { settle?: Settle; budget?: Budget } = {},
  ): Promise<void> {
    const startEpochMs = await this.now();
    const before = await this.metrics();
    await action();
    const capped = await this.runSettle(opts.settle ?? this.settle);
    const endEpochMs = await this.now();
    const after = await this.metrics();
    this.spans.push({
      name,
      startEpochMs,
      endEpochMs,
      capped,
      render: diffMetrics(before, after),
      // getMetrics Timestamp (monotonic seconds) shares the clock with trace ts (μs).
      traceStartUs: (before.Timestamp ?? 0) * 1e6,
      traceEndUs: (after.Timestamp ?? 0) * 1e6,
      budget: opts.budget,
    });
  }

  /** Run settle but give up after SETTLE_TIMEOUT_MS. Returns true if it capped. */
  private async runSettle(settle: Settle): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SETTLE_TIMEOUT_MS);
    });
    const done = settle(this.page).then(() => false);
    const capped = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return capped;
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
      "disabled-by-default-v8.cpu_profiler",
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

// First-party vs third-party classification by registrable domain.
// Not a full Public Suffix List — a compact set of common multi-label suffixes
// keeps "third party" honest on typical hosts without bundling the PSL. A
// request is first-party when its registrable domain equals the page's.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "gov.uk", "ac.uk", "org.uk", "co.jp", "ne.jp", "or.jp", "go.jp",
  "ac.jp", "co.kr", "co.in", "co.nz", "co.za", "com.au", "com.br", "com.cn",
  "com.tw", "com.hk", "com.sg", "com.mx",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null; // data:, blob:, about: — treated as first-party (inline)
  }
}

/** Registrable domain (eTLD+1), best-effort. IPs and bare hosts pass through. */
function registrableDomain(host: string): string {
  if (host.includes(":")) return host; // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

function isThirdParty(reqUrl: string, firstPartyDomain: string): boolean {
  const h = hostOf(reqUrl);
  if (!h || !firstPartyDomain) return false;
  return registrableDomain(h) !== firstPartyDomain;
}

/** Aggregate the third-party slice of a set of network records. */
function buildThirdParty(
  records: Array<{ url: string; encodedKB: number; interval?: [number, number] }>,
  firstPartyDomain: string,
): ThirdPartyBreakdown {
  const byDomain = new Map<
    string,
    { requestCount: number; encodedKB: number; intervals: Array<[number, number]> }
  >();
  const allIntervals: Array<[number, number]> = [];
  let requestCount = 0;
  let encodedKB = 0;
  for (const r of records) {
    if (!isThirdParty(r.url, firstPartyDomain)) continue;
    const host = hostOf(r.url);
    if (!host) continue;
    const domain = registrableDomain(host);
    const bucket =
      byDomain.get(domain) ??
      byDomain.set(domain, { requestCount: 0, encodedKB: 0, intervals: [] }).get(domain)!;
    bucket.requestCount += 1;
    bucket.encodedKB += r.encodedKB;
    requestCount += 1;
    encodedKB += r.encodedKB;
    if (r.interval) {
      bucket.intervals.push(r.interval);
      allIntervals.push(r.interval);
    }
  }
  return {
    requestCount,
    encodedKB: round(encodedKB),
    busyMs: round(unionLength(allIntervals)),
    byDomain: [...byDomain.entries()]
      .map(([domain, v]) => ({
        domain,
        requestCount: v.requestCount,
        encodedKB: round(v.encodedKB),
        busyMs: round(unionLength(v.intervals)),
      }))
      .sort((a, b) => b.encodedKB - a.encodedKB),
  };
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

function buildGlobalNetwork(
  reqs: NetReq[],
  firstPartyDomain: string,
): NetworkReport {
  const byType: NetworkReport["byType"] = {};
  let totalEncoded = 0;
  const finished: NetworkReport["slowest"] = [];
  const tpRecords: Array<{
    url: string;
    encodedKB: number;
    interval?: [number, number];
  }> = [];
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
    tpRecords.push({
      url: r.url,
      encodedKB: encoded / 1024,
      interval:
        r.endEpochMs != null ? [r.startEpochMs, r.endEpochMs] : undefined,
    });
  }
  for (const b of Object.values(byType)) b.encodedKB = round(b.encodedKB);
  finished.sort((a, b) => b.durationMs - a.durationMs);
  return {
    totalRequests: reqs.length,
    totalEncodedKB: round(totalEncoded / 1024),
    byType,
    slowest: finished.slice(0, 8),
    thirdParty: buildThirdParty(tpRecords, firstPartyDomain),
  };
}

interface EpochWindow {
  startEpochMs: number;
  endEpochMs: number;
}

function buildSpanNetwork(
  span: EpochWindow,
  reqs: NetReq[],
  firstPartyDomain: string,
): SpanNetwork {
  const intervals: Array<[number, number]> = [];
  const requests: SpanNetwork["requests"] = [];
  const tpRecords: Array<{
    url: string;
    encodedKB: number;
    interval?: [number, number];
  }> = [];
  let encoded = 0;
  for (const r of reqs) {
    const end = r.endEpochMs ?? r.startEpochMs;
    if (r.startEpochMs > span.endEpochMs || end < span.startEpochMs) continue;
    encoded += r.encoded ?? 0;
    const clipStart = Math.max(r.startEpochMs, span.startEpochMs);
    const clipEnd = Math.min(end, span.endEpochMs);
    const interval: [number, number] | undefined =
      clipEnd > clipStart ? [clipStart, clipEnd] : undefined;
    if (interval) intervals.push(interval);
    const tp = isThirdParty(r.url, firstPartyDomain);
    requests.push({
      url: r.url,
      type: r.type,
      startOffsetMs: round(r.startEpochMs - span.startEpochMs),
      durationMs: round(end - r.startEpochMs),
      kb: round((r.encoded ?? 0) / 1024),
      thirdParty: tp,
    });
    tpRecords.push({ url: r.url, encodedKB: (r.encoded ?? 0) / 1024, interval });
  }
  requests.sort((a, b) => b.durationMs - a.durationMs);
  return {
    requestCount: requests.length,
    encodedKB: round(encoded / 1024),
    busyMs: round(unionLength(intervals)),
    waves: countWaves(intervals),
    thirdParty: buildThirdParty(tpRecords, firstPartyDomain),
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
  // The page's own registrable domain anchors first- vs third-party. Falls back
  // to "" (everything counts as first-party) when the URL has no host.
  const pageHost = hostOf(url);
  const firstPartyDomain = pageHost ? registrableDomain(pageHost) : "";

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
      capped: s.capped,
      network: buildSpanNetwork(s, reqs, firstPartyDomain),
      cpu: buildSpanCpu(s, longTasks, loaf),
      render,
      traceWindowUs: [s.traceStartUs, s.traceEndUs],
      budget: s.budget,
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
        network: buildSpanNetwork(win, reqs, firstPartyDomain),
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
    network: buildGlobalNetwork(reqs, firstPartyDomain),
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
      `  ${s.name.padEnd(26)} ${String(s.durationMs).padStart(7)}ms${s.capped ? " (capped)" : ""}`,
    );
    // when the network is busy for ~the whole span, busyMs reflects the wait
    // window (continuous loading: ads, polling), not a discrete load cost.
    const saturated =
      s.durationMs > 50 && s.network.busyMs / s.durationMs > 0.9;
    lines.push(
      `      net   busy=${s.network.busyMs}ms  ${s.network.requestCount}reqs  ${s.network.waves}waves  ${s.network.encodedKB}KB` +
        (saturated ? "  (net-saturated: busyMs ≈ window)" : ""),
    );
    const tp = s.network.thirdParty;
    if (tp.requestCount > 0) {
      const top = tp.byDomain
        .slice(0, 3)
        .map((d) => `${d.domain} ${d.encodedKB}KB`)
        .join(", ");
      lines.push(
        `      3p    ${tp.requestCount}reqs  ${tp.encodedKB}KB  busy=${tp.busyMs}ms  [${top}]`,
      );
    }
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
        `  layout=${r.layoutCount}/${r.layoutMs}ms  nodes=${r.nodes}  script=${r.scriptMs}ms${paint}`,
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
  const gtp = report.network.thirdParty;
  if (gtp.requestCount > 0) {
    const share = report.network.totalEncodedKB
      ? Math.round((gtp.encodedKB / report.network.totalEncodedKB) * 100)
      : 0;
    lines.push(
      `    third-party ${gtp.requestCount} reqs / ${gtp.encodedKB}KB (${share}% of bytes)` +
        ` across ${gtp.byDomain.length} domains`,
    );
  }
  const violations = checkBudgets(report);
  for (const v of violations) {
    lines.push(`  ! budget: ${v}`);
  }
  if (report.collectorMissing) {
    lines.push(
      "  ! in-page collector did not run — vitals / cpu / render are missing." +
        " Navigate with page.goto (page.setContent does not trigger init scripts).",
    );
  }
  if (report.glRenderer && /swiftshader/i.test(report.glRenderer)) {
    lines.push(
      "  ! software GL (SwiftShader): GPU / render numbers are NOT real hardware. Use PERF_GPU=1.",
    );
  }
  if (report.pageErrors && report.pageErrors.length > 0) {
    lines.push(
      `  ! ${report.pageErrors.length} page error(s) during measurement — results may be invalid:`,
    );
    for (const e of report.pageErrors.slice(0, 3)) {
      lines.push(`      ${e.split("\n")[0]}`);
    }
  }
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

    // Capture uncaught errors: a broken / stale build (e.g. a reused dev server
    // serving an old bundle) typically throws, which makes the measurement invalid.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    // Scale the test timeout under CPU throttling: a page that runs N times slower
    // makes fixed waitFor / navigation timeouts trip. (The expect() timeout is a
    // global config and can't be changed per-test at runtime — raise it in config
    // or pass an explicit timeout when throttling hard.)
    if (CPU_RATE > 1 && testInfo.timeout > 0) {
      testInfo.setTimeout(testInfo.timeout * CPU_RATE);
    }

    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    // PERF_CPU=N slows the CPU N times (mid-tier device emulation). GL/GPU is not
    // throttled, so this surfaces JS / render bottlenecks hidden on a fast machine.
    if (CPU_RATE > 1) {
      await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
    }
    const finishNetwork = await startNetworkCapture(client);
    // PERF_NET emulates a slower network so payload / waterfall costs are realistic.
    if (NET_PROFILE) {
      await client.send("Network.emulateNetworkConditions", {
        offline: false,
        ...NET_PROFILE,
      });
    }
    const finishTrace = TRACE_ENABLED ? await startTrace(client) : undefined;

    const controller = new PerfController(page, client);
    await use(controller);

    // Drain pending PerformanceObserver records first (callbacks are async, so a
    // long task at the end of the last span would otherwise be missed).
    await page
      .evaluate(() => (window as unknown as PerfWindow).__perf?.flush?.())
      .catch(() => {});
    const raw = await page
      .evaluate(() => (window as unknown as PerfWindow).__perf)
      .catch(() => undefined);
    const timeOrigin = await page
      .evaluate(() => performance.timeOrigin)
      .catch(() => 0);
    // Detect software GL (SwiftShader): its GPU/render numbers are not real hardware.
    const glRenderer = await page
      .evaluate(() => {
        try {
          const gl = document.createElement("canvas").getContext("webgl");
          if (!gl) return null;
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          return ext
            ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
            : (gl.getParameter(gl.RENDERER) as string);
        } catch {
          return null;
        }
      })
      .catch(() => null);
    const url = page.url();
    const reqs = finishNetwork();
    // finish the trace before buildReport so Paint/GPU can correlate to spans
    const traceEvents = finishTrace
      ? ((await finishTrace()) as TraceEvent[])
      : undefined;

    fs.mkdirSync(PERF_OUT_DIR, { recursive: true });
    // Use the full title path (describe blocks + test title) so tests that share a
    // title under different describes (e.g. one test body looped over many sites)
    // don't collide into the same report / median bucket.
    const slug = testInfo.titlePath
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}_]+/gu, "_");
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

    if (glRenderer) report.glRenderer = glRenderer;
    if (pageErrors.length) report.pageErrors = pageErrors;
    if (Object.keys(controller.vitalsBudget).length > 0)
      report.vitalsBudget = controller.vitalsBudget;
    // raw === undefined means the addInitScript collector never ran in the page.
    if (raw === undefined) report.collectorMissing = true;

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

    // Inline budget assertion (opt-in). Off by default because a single run is
    // noisy for duration/blocking; the statistically sound gate is the median
    // script. Enable PERF_ASSERT=1 for fast local fail-fast on stable metrics.
    if (process.env.PERF_ASSERT === "1") {
      const violations = checkBudgets(report);
      if (violations.length > 0) {
        throw new Error(`perf budget exceeded:\n  ${violations.join("\n  ")}`);
      }
    }
  },
});

export { expect } from "@playwright/test";
