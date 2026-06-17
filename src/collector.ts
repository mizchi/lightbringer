import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// Type-only import (erased at build) so the core has no @playwright/test runtime
// dependency — the CLI can drive it with a plain `playwright` page. The fixture
// (src/fixture.ts) is what actually imports @playwright/test's test runner.
import type { CDPSession, Page } from "playwright";
import { toOtelSpans, type OtelSpan } from "./otel";
// The CDP/Performance-event analysis is the framework-agnostic `analyze` layer
// (pure functions, separately unit-tested). collector.ts is the capture + report
// assembly that drives a Playwright Page/CDPSession and feeds those analyzers.
import { round, type EpochWindow } from "./analyze/util";
import {
  hostOf,
  registrableDomain,
  shortenUrl,
  summarizeInitiator,
  buildGlobalNetwork,
  buildSpanNetwork,
  type NetReq,
  type CdpInitiator,
  type SpanNetwork,
  type NetworkReport,
} from "./analyze/network";
import {
  diffMetrics,
  buildTraceRender,
  buildSpanCpu,
  type SpanRender,
  type SpanCpu,
  type TraceEvent,
} from "./analyze/render";
import {
  diffMemory,
  buildTrends,
  type SpanMemory,
  type MemoryTrend,
} from "./analyze/memory";
import {
  buildCoverage,
  type Coverage,
  type CoverageReport,
  type CoverageArtifact,
  type JSCoverageEntry,
  type CSSCoverageEntry,
} from "./analyze/coverage";
import {
  pickAttribution,
  buildSpanInteraction,
  buildSpanFrames,
  type VitalSample,
  type SpanInteraction,
  type SpanFrames,
  type EpochEvent,
} from "./analyze/vitals";

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

export const PERF_OUT_DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

/**
 * PERF_CSS=1 adds the `disabled-by-default-blink.debug` trace category, which
 * makes Blink emit per-selector match stats (SelectorStats) on every style
 * recalc — so the drilldown can show WHICH selectors cost the recalc time. It's
 * expensive (instruments every match attempt), so it's opt-in and implies a trace.
 */
export const CSS_STATS = process.env.PERF_CSS === "1";

/**
 * PERF_COV=1 records JS + CSS coverage across the whole scenario
 * (resetOnNavigation: false) via Playwright's Chromium coverage API. It reveals
 * how much of each downloaded chunk / stylesheet the scenario actually used —
 * low usage means the chunk is split too coarsely or shipped needlessly. Across
 * scenarios, scripts/coverage.mjs unions the used ranges to find code no scenario
 * touched (dead-code / over-shipping candidates). Chromium-only; expensive.
 */
export const COV_ENABLED = process.env.PERF_COV === "1";

/** With PERF_TRACE=1 (or PERF_CSS=1), save a Chrome trace (openable in DevTools / Perfetto). */
export const TRACE_ENABLED = process.env.PERF_TRACE === "1" || CSS_STATS;

/** PERF_CPU=N throttles the CPU N times (mid-tier device emulation). 1 = off. */
export const CPU_RATE = Number(process.env.PERF_CPU ?? "1");

/**
 * PERF_MEM=1 forces a GC (HeapProfiler.collectGarbage) at each span boundary so
 * the memory deltas reflect *retained* memory — the leak signal — instead of
 * not-yet-collected garbage from the step itself. Off by default because the GC
 * adds wall time to the span (it would distort durationMs / settle timing).
 */
export const MEM_GC = process.env.PERF_MEM === "1";

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
export const NET_PROFILE = NET_PROFILES[process.env.PERF_NET ?? ""];

// ---------------------------------------------------------------------------
// Report types (the contract layer). The per-domain fragment types
// (SpanNetwork / SpanCpu / SpanRender / SpanMemory / ...) live in ./analyze;
// the composite report types that tie them together live here.
// ---------------------------------------------------------------------------

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
  /** upper bound on style-recalc time (ms) — the selector-match cost of a step */
  recalcStyleMs?: number;
  /** upper bound on how many elements had style recalculated */
  recalcStyleCount?: number;
  nodes?: number;
  /** upper bound on bytes loaded from third-party origins */
  thirdPartyKB?: number;
  /** upper bound on request count to third-party origins */
  thirdPartyRequestCount?: number;
  /** paint metrics are only present with PERF_TRACE=1; the gate is a no-op otherwise */
  paintMs?: number;
  paintCount?: number;
  /** GPU task time (ms); only present with PERF_TRACE=1, gate is a no-op otherwise */
  gpuMs?: number;
  /** upper bound on JS heap in use at span end (MB) */
  jsHeapUsedMB?: number;
  /** upper bound on JS heap growth during the span (MB) — catches per-step leaks */
  jsHeapDeltaMB?: number;
  /** upper bound on net event listeners added during the span — catches listener leaks */
  listenersDelta?: number;
  /** upper bound on the worst interaction latency in the span (per-step INP, ms) */
  interactionMs?: number;
  /** upper bound on dropped frames in the span (animation jank) */
  droppedFrames?: number;
  /** upper bound on the worst frame gap in the span (ms) */
  longestFrameMs?: number;
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
  memory: SpanMemory;
  /** responsiveness of interactions in the span (per-step INP); absent if none */
  interaction?: SpanInteraction;
  /** frame cadence during the span (animation smoothness); absent if too few frames */
  frames?: SpanFrames;
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
  recalcStyleMs: (s) => s.render.recalcStyleMs,
  recalcStyleCount: (s) => s.render.recalcStyleCount,
  nodes: (s) => s.render.nodes,
  thirdPartyKB: (s) => s.network.thirdParty.encodedKB,
  thirdPartyRequestCount: (s) => s.network.thirdParty.requestCount,
  paintMs: (s) => s.render.paintMs ?? 0,
  paintCount: (s) => s.render.paintCount ?? 0,
  gpuMs: (s) => s.render.gpuMs ?? 0,
  jsHeapUsedMB: (s) => s.memory.jsHeapUsedMB,
  jsHeapDeltaMB: (s) => s.memory.jsHeapDeltaMB,
  listenersDelta: (s) => s.memory.listenersDelta,
  interactionMs: (s) => s.interaction?.maxDurationMs ?? 0,
  droppedFrames: (s) => s.frames?.droppedFrames ?? 0,
  longestFrameMs: (s) => s.frames?.longestFrameMs ?? 0,
};

/** Budget violations on a single run (actual > budget). */
export function checkBudgets(report: PerfReport): string[] {
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
  /** page CSS/DOM capacity — the "why is style recalc expensive" denominator */
  css?: CssProfile;
  /** JS/CSS coverage across the scenario (PERF_COV=1) — chunk usage / dead code */
  coverage?: Coverage;
  /** image over-fetch + uncompressed-resource analysis */
  media?: MediaReport;
  /** render-blocking resources in <head> (delay first paint / LCP) */
  renderBlocking?: RenderBlocking;
  /** WebGL renderer string; "SwiftShader" means software GL (GPU numbers are fake) */
  glRenderer?: string;
  /** uncaught page errors during measurement; non-empty means results are suspect */
  pageErrors?: string[];
  /** true if the in-page collector never ran (e.g. page.setContent without a goto) */
  collectorMissing?: boolean;
  /** memory growth across repeated steps (from measureRepeat); leak signal */
  trends?: MemoryTrend[];
  tracePath?: string;
}

/**
 * Page CSS/DOM capacity. Style recalc cost is roughly O(elements × selectors that
 * survive fast-rejection), so a big DOM crossed with a big stylesheet is the
 * structural cause of an expensive recalc. This is the denominator; PERF_CSS=1 +
 * the drilldown's selector stats are the per-selector numerator.
 */
export interface CssProfile {
  styleSheets: number;
  /** total style rules across all same-origin sheets (recurses into @media) */
  cssRules: number;
  /** total selectors (comma-split selectorText) — the match-cost multiplier */
  selectors: number;
  /** live DOM element count */
  domNodes: number;
}

/**
 * Image / media weight. Two wins that a byte count alone misses: images shipped
 * far larger than they're displayed (over-fetch — a 2000px image in a 256px box),
 * and large text resources served with little/no compression. From Resource
 * Timing (encoded/decoded sizes) + DOM intrinsic-vs-rendered dimensions.
 */
export interface MediaReport {
  imageCount: number;
  imageKB: number;
  /** images whose intrinsic pixels far exceed their rendered (CSS×DPR) pixels */
  oversized: Array<{
    url: string;
    naturalPx: string;
    renderedPx: string;
    /** intrinsic area / rendered area (≥4 means ≥2× too big per dimension) */
    overFetch: number;
    kb: number;
  }>;
  /** large compressible resources shipped ~uncompressed (decoded ≈ encoded) */
  uncompressed: Array<{ url: string; kb: number; ratio: number; type: string }>;
}

/**
 * Render-blocking resources in <head>: stylesheets (the parser waits for CSSOM
 * before first paint) and parser-blocking classic scripts (no async/defer, not a
 * module). These push out first paint / LCP. Pair with the LCP attribution
 * sub-parts (TTFB / load delay / load duration / render delay) to see whether LCP
 * is server-bound, resource-bound, or render-bound.
 */
export interface RenderBlocking {
  stylesheets: string[];
  scripts: string[];
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
    /** Event Timing entries for real interactions (interactionId > 0) */
    events: Array<{
      start: number;
      duration: number;
      type: string;
      processingStart: number;
      processingEnd: number;
    }>;
    /** requestAnimationFrame timestamps (DOMHighResTimeStamp) — frame cadence */
    frames: number[];
    /** drain pending PerformanceObserver records into the store (see flush below) */
    flush?: () => void;
  };
}

function browserCollector() {
  const w = window as unknown as PerfWindow;
  w.__perf = { vitals: {}, longTasks: [], loaf: [], measures: [], events: [], frames: [] };
  const store = w.__perf;

  // Record frame cadence with a self-rescheduling rAF. Each callback just pushes
  // a timestamp (negligible work), so the gap between frames reflects the page's
  // own jank, not the probe. A gap >> 16.7ms means dropped frames.
  const onFrame = (t: number) => {
    store.frames.push(t);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

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

  // Event Timing: only interactionId>0 entries are real interactions (click,
  // keydown, pointerup, …). duration is input→next-paint (8ms-bucketed); split
  // into input delay / processing / presentation at aggregation.
  type EventTimingLike = PerformanceEntry & {
    processingStart: number;
    processingEnd: number;
    interactionId?: number;
  };
  const drainEvent = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const pe = e as EventTimingLike;
      if (!pe.interactionId) continue;
      store.events.push({
        start: pe.startTime,
        duration: pe.duration,
        type: pe.name,
        processingStart: pe.processingStart,
        processingEnd: pe.processingEnd,
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
  observe(drainEvent, {
    type: "event",
    buffered: true,
    durationThreshold: 16,
  } as PerformanceObserverInit);

  store.flush = () => {
    for (const obs of observers) {
      const records = obs.takeRecords();
      if (records.length === 0) continue;
      const type = records[0].entryType;
      if (type === "longtask") drainLongTask(records);
      else if (type === "long-animation-frame") drainLoaf(records);
      else if (type === "measure") drainMeasure(records);
      else if (type === "event" || type === "first-input") drainEvent(records);
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
  memory: SpanMemory;
  /** span window in trace clock (monotonic μs) for correlation / drilldown */
  traceStartUs: number;
  traceEndUs: number;
  budget?: Budget;
}

export class PerfController {
  readonly spans: RawSpan[] = [];
  vitalsBudget: VitalsBudget = {};
  constructor(
    private page: Page,
    private client: CDPSession,
    private settle: Settle = defaultSettle,
    /** force a GC at span boundaries so memory deltas are retained-only (PERF_MEM) */
    private memGc: boolean = MEM_GC,
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
  async measure<T>(
    name: string,
    action: () => Promise<T>,
    opts: { settle?: Settle; budget?: Budget } = {},
  ): Promise<T> {
    const startEpochMs = await this.now();
    // With PERF_MEM, GC before the baseline so the delta starts from a clean heap.
    if (this.memGc) await this.gc();
    const before = await this.metrics();
    const result = await action();
    const capped = await this.runSettle(opts.settle ?? this.settle);
    const endEpochMs = await this.now();
    const after = await this.metrics();
    // Memory uses a post-GC end snapshot under PERF_MEM (retained-only); render and
    // timing keep the un-GC'd `after` so the GC pause doesn't distort them.
    let memAfter = after;
    if (this.memGc) {
      await this.gc();
      memAfter = await this.metrics();
    }
    this.spans.push({
      name,
      startEpochMs,
      endEpochMs,
      capped,
      render: diffMetrics(before, after),
      memory: diffMemory(before, memAfter),
      // getMetrics Timestamp (monotonic seconds) shares the clock with trace ts (μs).
      traceStartUs: (before.Timestamp ?? 0) * 1e6,
      traceEndUs: (after.Timestamp ?? 0) * 1e6,
      budget: opts.budget,
    });
    return result;
  }

  /**
   * Repeat the same operation N times, each recorded as a `${name}#${i}` span.
   * buildReport then checks whether memory (heap / listeners / DOM nodes /
   * ArrayBuffers) climbs monotonically across the repeats — the real leak signal,
   * which a single per-step delta can't separate from GC noise. Use PERF_MEM=1 so
   * each repeat's memory is measured after a forced GC (retained-only).
   */
  async measureRepeat(
    name: string,
    action: () => Promise<void>,
    opts: { times?: number; settle?: Settle; budget?: Budget } = {},
  ): Promise<void> {
    const times = opts.times ?? 3;
    for (let i = 0; i < times; i++) {
      await this.measure(`${name}#${i}`, action, {
        settle: opts.settle,
        budget: opts.budget,
      });
    }
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

  /** Force a GC so subsequent memory metrics reflect retained, not pending-collection, memory. */
  private async gc(): Promise<void> {
    // Twice: one collectGarbage leaves recently-promoted objects uncollected, so a
    // dropped allocation can still inflate JSHeapUsedSize after a single pass.
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
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
// The NetReq record shape and its summarizer live in ./analyze/network.
// ---------------------------------------------------------------------------

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
      initiator?: CdpInitiator;
    };
    reqs.set(p.requestId, {
      url: p.request.url,
      type: p.type ?? "Other",
      startMono: p.timestamp,
      startEpochMs: p.wallTime * 1000,
      initiator: summarizeInitiator(p.initiator),
    });
  });
  client.on("Network.responseReceived", (e) => {
    const p = e as unknown as {
      requestId: string;
      type?: string;
      response?: {
        fromDiskCache?: boolean;
        fromPrefetchCache?: boolean;
        fromServiceWorker?: boolean;
      };
    };
    const r = reqs.get(p.requestId);
    if (!r) return;
    if (p.type) r.type = p.type;
    if (
      p.response?.fromDiskCache ||
      p.response?.fromPrefetchCache ||
      p.response?.fromServiceWorker
    )
      r.fromCache = true;
  });
  // memory-cache hits don't carry a response body; they fire this instead
  client.on("Network.requestServedFromCache", (e) => {
    const p = e as unknown as { requestId: string };
    const r = reqs.get(p.requestId);
    if (r) r.fromCache = true;
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
  tracePath: string,
  cssStats: boolean = CSS_STATS,
): Promise<() => Promise<{ renderEvents: TraceEvent[] }>> {
  // A heavy page emits tens-to-hundreds of MB of trace events. Holding them all
  // in a JS array and JSON.stringify-ing at the end peaks at 2x that in heap and
  // OOMs. Instead: stream every event straight to disk for the drilldown, and
  // keep in memory only the handful aggregation needs (Paint / GPUTask, used to
  // fill per-span paint/GPU). The drilldown reads the file when it needs the rest.
  const renderEvents: TraceEvent[] = [];
  const out = fs.createWriteStream(tracePath);
  out.write("[");
  let wroteAny = false;
  let writeError: Error | undefined;
  out.on("error", (err) => {
    writeError = err;
  });

  client.on("Tracing.dataCollected", (e) => {
    const p = e as unknown as { value: TraceEvent[] };
    const batch = p.value;
    // for-loop, NOT events.push(...batch): a single dataCollected batch can
    // exceed the spread-call argument limit (~120k) and throw RangeError, which
    // would lose the entire trace on exactly the heavy pages this is meant for.
    let chunk = "";
    for (let i = 0; i < batch.length; i++) {
      const ev = batch[i];
      chunk += (wroteAny ? "," : "") + JSON.stringify(ev);
      wroteAny = true;
      if (ev.ph === "X" && (ev.name === "Paint" || ev.name === "GPUTask")) {
        renderEvents.push(ev);
      }
    }
    if (chunk) out.write(chunk);
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
      // per-selector style-recalc match stats (SelectorStats); opt-in, expensive
      ...(cssStats ? ["disabled-by-default-blink.debug"] : []),
    ].join(","),
  });
  return async () => {
    const done = new Promise<void>((resolve) => {
      client.once("Tracing.tracingComplete", () => resolve());
    });
    await client.send("Tracing.end");
    await done;
    // close the JSON array and flush to disk before we read the file path back
    await new Promise<void>((resolve, reject) => {
      out.end("]", () => (writeError ? reject(writeError) : resolve()));
    });
    return { renderEvents };
  };
}

// ---------------------------------------------------------------------------
// Report assembly. Pulls the per-domain breakdowns from ./analyze and composes
// them into the SpanReport / PerfReport contract.
// ---------------------------------------------------------------------------

function buildReport(
  title: string,
  url: string,
  raw: NonNullable<PerfWindow["__perf"]>,
  timeOrigin: number,
  spans: RawSpan[],
  reqs: NetReq[],
  /** pre-filtered Paint / GPUTask events (not the full trace) for per-span paint/GPU */
  renderEvents?: TraceEvent[],
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
  const events: EpochEvent[] = (raw.events ?? []).map((e) => ({
    epochStart: timeOrigin + e.start,
    duration: e.duration,
    type: e.type,
    start: e.start,
    processingStart: e.processingStart,
    processingEnd: e.processingEnd,
  }));
  const frameEpochs = (raw.frames ?? []).map((t) => timeOrigin + t);

  const spanReports: SpanReport[] = spans.map((s) => {
    const render = renderEvents
      ? {
          ...s.render,
          ...buildTraceRender(renderEvents, s.traceStartUs, s.traceEndUs),
        }
      : s.render;
    return {
      name: s.name,
      durationMs: round(s.endEpochMs - s.startEpochMs),
      capped: s.capped,
      network: buildSpanNetwork(s, reqs, firstPartyDomain),
      cpu: buildSpanCpu(s, longTasks, loaf),
      render,
      memory: s.memory,
      interaction: buildSpanInteraction(s, events),
      frames: buildSpanFrames(s, frameEpochs),
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

  const trends = buildTrends(spanReports);

  return {
    title,
    url,
    vitals,
    spans: spanReports,
    appSpans,
    network: buildGlobalNetwork(reqs, firstPartyDomain),
    ...(trends.length ? { trends } : {}),
  };
}

export function logSummary(report: PerfReport, memGc: boolean = MEM_GC): void {
  const lines: string[] = [`\n[perf] ${report.title}`];
  const v = report.vitals;
  const fmt = (s?: VitalSample) => (s ? `${s.value} (${s.rating})` : "n/a");
  lines.push(
    `  vitals  LCP=${fmt(v.LCP)}  INP=${fmt(v.INP)}  CLS=${fmt(v.CLS)}  TTFB=${fmt(v.TTFB)}`,
  );
  // LCP sub-parts (where the LCP time goes) + render-blocking resources behind it.
  const lcpAttr = v.LCP?.attribution as
    | {
        timeToFirstByte?: number;
        resourceLoadDelay?: number;
        resourceLoadDuration?: number;
        elementRenderDelay?: number;
        element?: string;
      }
    | undefined;
  if (lcpAttr && (lcpAttr.timeToFirstByte != null || lcpAttr.elementRenderDelay != null)) {
    const r = (n?: number) => round(n ?? 0);
    lines.push(
      `    lcp ttfb=${r(lcpAttr.timeToFirstByte)} / load-delay=${r(lcpAttr.resourceLoadDelay)}` +
        ` / load=${r(lcpAttr.resourceLoadDuration)} / render-delay=${r(lcpAttr.elementRenderDelay)}ms` +
        (lcpAttr.element ? `  <${String(lcpAttr.element).slice(0, 40)}>` : ""),
    );
  }
  if (report.renderBlocking) {
    const rb = report.renderBlocking;
    lines.push(
      `    render-blocking: ${rb.stylesheets.length} css, ${rb.scripts.length} js` +
        (rb.stylesheets.length || rb.scripts.length
          ? `  [${[...rb.stylesheets, ...rb.scripts].slice(0, 3).map(shortenUrl).join(", ")}]`
          : ""),
    );
  }
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
    // When the waterfall is deep (or request-heavy), name the code that issued the
    // requests — the network-side "who's responsible" the way the drilldown does CPU.
    if (s.network.byInitiator.length > 0 && (s.network.waves >= 2 || s.network.requestCount >= 5)) {
      const top = s.network.byInitiator
        .slice(0, 3)
        .map((it) => `${it.frame} (${it.requestCount})`)
        .join("  ");
      lines.push(`      ↳ from ${top}`);
    }
    lines.push(
      `      cpu   block=${s.cpu.blockingMs}ms  longtasks=${s.cpu.longTaskCount}` +
        `  maxTask=${s.cpu.maxLongTaskMs}ms  loaf=${s.cpu.loafCount}/${s.cpu.maxLoafBlockingMs}ms`,
    );
    if (s.interaction) {
      const it = s.interaction;
      lines.push(
        `      inp   ${it.type}=${it.maxDurationMs}ms  (input ${it.inputDelayMs} / proc ${it.processingMs} / present ${it.presentationMs})` +
          (it.count > 1 ? `  ${it.count} interactions` : ""),
      );
    }
    // only surface frames when there's actually a hitch (static spans sit at ~60fps)
    if (s.frames && (s.frames.droppedFrames > 0 || s.frames.longestFrameMs > 33)) {
      const f = s.frames;
      lines.push(
        `      frames ${f.fps}fps  ${f.droppedFrames} dropped  longest=${f.longestFrameMs}ms`,
      );
    }
    const r = s.render;
    const paint =
      r.paintCount !== undefined
        ? `  paint=${r.paintCount}/${r.paintMs}ms  gpu=${r.gpuMs}ms`
        : "";
    lines.push(
      `      render style=${r.recalcStyleCount}/${r.recalcStyleMs}ms` +
        `  layout=${r.layoutCount}/${r.layoutMs}ms  nodes=${r.nodes}  script=${r.scriptMs}ms${paint}`,
    );
    const m = s.memory;
    const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    // A single span's delta is too noisy to call a leak (every initial load grows
    // heap + listeners from zero). Leak verdicts come from the cross-step trend
    // (measureRepeat → report.trends); here we just show the numbers.
    lines.push(
      `      mem   heap=${m.jsHeapUsedMB}MB (${sign(m.jsHeapDeltaMB)}MB)` +
        `  arraybufs=${m.arrayBuffers}  listeners=${m.jsEventListeners} (${sign(m.listenersDelta)})` +
        `  docs=${sign(m.documentsDelta)}  domNodes=${m.domNodes}` +
        (memGc ? "" : "  (pre-GC; set PERF_MEM=1 for retained-only deltas)"),
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
  if (report.trends && report.trends.length > 0) {
    lines.push("  memory trends (across repeated steps):");
    for (const t of report.trends) {
      const unit = t.metric === "jsHeapUsedMB" ? "MB" : "";
      const series = t.values.join("→");
      const flag = t.leak
        ? "  ⚠ likely leak"
        : t.monotonic
          ? "  (monotonic)"
          : "";
      lines.push(
        `    ${t.name} x${t.count}  ${t.metric} ${series}${unit}` +
          `  ${t.growth >= 0 ? "+" : ""}${t.growth}${unit} (${t.perStep >= 0 ? "+" : ""}${t.perStep}/step)${flag}`,
      );
    }
    if (!memGc) {
      lines.push(
        "    (deltas include uncollected garbage; PERF_MEM=1 for a retained-only trend)",
      );
    }
  }
  if (report.css) {
    const c = report.css;
    // elements × selectors is the recalc-cost ceiling; flag when it's large
    const heavy = c.domNodes * c.selectors > 5_000_000;
    lines.push(
      `  css   ${c.styleSheets} sheets / ${c.cssRules} rules / ${c.selectors} selectors` +
        `  ×  ${c.domNodes} DOM nodes` +
        (heavy
          ? "  (large selector×DOM product — PERF_CSS=1 to see the costly selectors)"
          : ""),
    );
  }
  if (report.media) {
    const m = report.media;
    lines.push(`  media  ${m.imageCount} images / ${m.imageKB}KB`);
    for (const o of m.oversized.slice(0, 5)) {
      lines.push(
        `      oversized ${o.overFetch}×  ${o.naturalPx} shown ${o.renderedPx}  ${o.kb}KB  ${shortenUrl(o.url)}`,
      );
    }
    for (const u of m.uncompressed.slice(0, 5)) {
      lines.push(
        `      uncompressed ${u.kb}KB (ratio ${u.ratio} [${u.type}])  ${shortenUrl(u.url)}`,
      );
    }
  }
  if (report.coverage) {
    const kb = (b: number) => Math.round(b / 102.4) / 10;
    const cov = (label: string, c: CoverageReport) => {
      if (c.totalBytes === 0) return;
      lines.push(
        `  ${label}  ${c.usedPct}% used  (${kb(c.usedBytes)}/${kb(c.totalBytes)}KB)`,
      );
      // chunks the scenario barely touched — split too coarse / shipped needlessly
      for (const f of c.files) {
        if (f.totalBytes < 5_000) continue; // ignore tiny files
        if (f.usedPct >= 40) continue;
        lines.push(
          `      ${String(f.usedPct).padStart(5)}% used  ${kb(f.totalBytes - f.usedBytes)}KB unused  ${shortenUrl(f.url)}`,
        );
      }
    };
    lines.push("  coverage (PERF_COV — scenario-wide):");
    cov("js ", report.coverage.js);
    cov("css", report.coverage.css);
  }
  lines.push(
    `  total network ${report.network.totalRequests} reqs / ${report.network.totalEncodedKB}KB` +
      (report.network.fromCacheCount > 0
        ? `  (${report.network.fromCacheCount} from cache)`
        : ""),
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
// Reusable measurement session. Works with any Playwright Page + CDPSession, so
// the collection logic isn't tied to @playwright/test — the fixture below and the
// CLI driver (src/cli.ts) both build on it.
// ---------------------------------------------------------------------------

export interface SessionOptions {
  /** CPU throttling multiplier (1 = off) */
  cpuRate?: number;
  /** network emulation profile (bytes/s, ms), or null for none */
  netProfile?: {
    latency: number;
    downloadThroughput: number;
    uploadThroughput: number;
  } | null;
  /** add per-selector SelectorStats to the trace (requires trace) */
  cssStats?: boolean;
  /** capture a Chrome trace, streamed to tracePath */
  trace?: boolean;
  /** where to stream the trace (required when trace is true) */
  tracePath?: string;
  /** record JS/CSS coverage across the scenario */
  coverage?: boolean;
  /** force a GC at span boundaries (retained-only memory deltas) */
  memGc?: boolean;
}

export interface PerfSession {
  controller: PerfController;
  /** uncaught page errors observed during the run */
  pageErrors: string[];
  /** finalize: gather everything and build the report (`title` labels it) */
  finish: (title: string) => Promise<{
    report: PerfReport;
    covArtifact?: CoverageArtifact;
  }>;
}

/** The browser-side eval bodies, shared verbatim by finish(). */
function readGlRenderer(): string | null {
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
}
function readCssProfile(): CssProfile {
  let cssRules = 0;
  let selectors = 0;
  let styleSheets = 0;
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const sel = (rule as CSSStyleRule).selectorText;
      if (sel) {
        cssRules += 1;
        selectors += sel.split(",").length;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    styleSheets += 1;
    try {
      walk(sheet.cssRules);
    } catch {
      /* cross-origin stylesheet — rules not readable */
    }
  }
  return {
    styleSheets,
    cssRules,
    selectors,
    domNodes: document.getElementsByTagName("*").length,
  };
}
function readMedia(): MediaReport {
  const res = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const byUrl = new Map(res.map((r) => [r.name, r]));
  const dpr = window.devicePixelRatio || 1;
  let imageCount = 0;
  let imageBytes = 0;
  const oversized: MediaReport["oversized"] = [];
  for (const img of Array.from(document.images)) {
    const url = img.currentSrc || img.src;
    const nW = img.naturalWidth;
    const nH = img.naturalHeight;
    if (!url || !nW || !nH) continue;
    imageCount += 1;
    const r = byUrl.get(url);
    const bytes = r ? r.encodedBodySize || r.transferSize || 0 : 0;
    imageBytes += bytes;
    const rect = img.getBoundingClientRect();
    const rW = Math.round(rect.width);
    const rH = Math.round(rect.height);
    if (rW > 0 && rH > 0) {
      const overFetch = (nW * nH) / (rW * rH * dpr * dpr);
      if (overFetch >= 4) {
        oversized.push({
          url,
          naturalPx: `${nW}x${nH}`,
          renderedPx: `${rW}x${rH}`,
          overFetch: Math.round(overFetch * 10) / 10,
          kb: Math.round(bytes / 102.4) / 10,
        });
      }
    }
  }
  oversized.sort((a, b) => b.kb - a.kb);
  const textType = new Set([
    "script",
    "link",
    "css",
    "fetch",
    "xmlhttprequest",
    "other",
  ]);
  const uncompressed: MediaReport["uncompressed"] = [];
  for (const r of res) {
    if (!textType.has(r.initiatorType)) continue;
    const enc = r.encodedBodySize;
    const dec = r.decodedBodySize;
    if (!enc || !dec || enc < 20_000) continue; // skip tiny / cross-origin (no TAO)
    const ratio = dec / enc;
    if (ratio < 1.1) {
      uncompressed.push({
        url: r.name,
        kb: Math.round(enc / 102.4) / 10,
        ratio: Math.round(ratio * 100) / 100,
        type: r.initiatorType,
      });
    }
  }
  uncompressed.sort((a, b) => b.kb - a.kb);
  return {
    imageCount,
    imageKB: Math.round(imageBytes / 102.4) / 10,
    oversized: oversized.slice(0, 10),
    uncompressed: uncompressed.slice(0, 10),
  };
}
function readRenderBlocking(): RenderBlocking {
  const stylesheets: string[] = [];
  const scripts: string[] = [];
  const head = document.head;
  if (head) {
    for (const link of Array.from(
      head.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet]"),
    )) {
      if (link.hasAttribute("disabled")) continue;
      const m = (link.getAttribute("media") || "all").toLowerCase();
      if (m === "all" || m === "screen" || m === "")
        stylesheets.push(link.getAttribute("href") || "");
    }
    for (const s of Array.from(
      head.querySelectorAll<HTMLScriptElement>("script[src]"),
    )) {
      if (
        !s.hasAttribute("async") &&
        !s.hasAttribute("defer") &&
        (s.getAttribute("type") || "") !== "module"
      )
        scripts.push(s.getAttribute("src") || "");
    }
  }
  return { stylesheets, scripts };
}

export async function startSession(
  page: Page,
  client: CDPSession,
  opts: SessionOptions = {},
): Promise<PerfSession> {
  const cpuRate = opts.cpuRate ?? 1;
  const memGc = opts.memGc ?? MEM_GC;

  await page.addInitScript({ content: WEB_VITALS_IIFE });
  await page.addInitScript(browserCollector);

  // A broken / stale build typically throws; capture it so the report can warn.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await client.send("Performance.enable");
  if (cpuRate > 1)
    await client.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const finishNetwork = await startNetworkCapture(client);
  if (opts.netProfile) {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      ...opts.netProfile,
    });
  }
  const finishTrace =
    opts.trace && opts.tracePath
      ? await startTrace(client, opts.tracePath, opts.cssStats ?? CSS_STATS)
      : undefined;
  // Coverage spans the whole scenario (resetOnNavigation:false). Chromium-only.
  if (opts.coverage && page.coverage) {
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
    });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  }

  const controller = new PerfController(page, client, undefined, memGc);

  const finish = async (title: string) => {
    // Drain pending PerformanceObserver records first (callbacks are async).
    await page
      .evaluate(() => (window as unknown as PerfWindow).__perf?.flush?.())
      .catch(() => {});
    const raw = await page
      .evaluate(() => (window as unknown as PerfWindow).__perf)
      .catch(() => undefined);
    const timeOrigin = await page
      .evaluate(() => performance.timeOrigin)
      .catch(() => 0);
    const glRenderer = await page.evaluate(readGlRenderer).catch(() => null);
    const css = await page.evaluate(readCssProfile).catch(() => undefined);

    let coverage: Coverage | undefined;
    let covArtifact: CoverageArtifact | undefined;
    if (opts.coverage && page.coverage) {
      const jsCov = await page.coverage.stopJSCoverage().catch(() => []);
      const cssCov = await page.coverage.stopCSSCoverage().catch(() => []);
      const built = buildCoverage(
        jsCov as unknown as JSCoverageEntry[],
        cssCov as unknown as CSSCoverageEntry[],
      );
      coverage = built.coverage;
      covArtifact = built.artifact;
    }

    const media = await page.evaluate(readMedia).catch(() => undefined);
    const renderBlocking = await page
      .evaluate(readRenderBlocking)
      .catch(() => undefined);

    const url = page.url();
    const reqs = finishNetwork();
    const renderEvents = finishTrace
      ? (await finishTrace()).renderEvents
      : undefined;

    const report = buildReport(
      title,
      url,
      raw ?? {
        vitals: {},
        longTasks: [],
        loaf: [],
        measures: [],
        events: [],
        frames: [],
      },
      timeOrigin,
      controller.spans,
      reqs,
      renderEvents,
    );

    if (css) report.css = css;
    if (
      renderBlocking &&
      (renderBlocking.stylesheets.length || renderBlocking.scripts.length)
    )
      report.renderBlocking = renderBlocking;
    if (
      media &&
      (media.oversized.length || media.uncompressed.length || media.imageCount)
    )
      report.media = media;
    if (coverage) report.coverage = coverage;
    if (glRenderer) report.glRenderer = glRenderer;
    if (pageErrors.length) report.pageErrors = pageErrors;
    if (Object.keys(controller.vitalsBudget).length > 0)
      report.vitalsBudget = controller.vitalsBudget;
    if (raw === undefined) report.collectorMissing = true;
    if (opts.trace && opts.tracePath) report.tracePath = opts.tracePath;

    return { report, covArtifact };
  };

  return { controller, pageErrors, finish };
}

// The Playwright fixture (`test` / `expect`) lives in src/fixture.ts so this core
// module stays free of an @playwright/test runtime import (see the import note).
