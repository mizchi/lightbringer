import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// Type-only import (erased at build) so the core has no @playwright/test runtime
// dependency — the CLI can drive it with a plain `playwright` page. The fixture
// (src/fixture.ts) is what actually imports @playwright/test's test runner.
import type { CDPSession, Page } from "playwright";
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

/**
 * What triggered a request (CDP `Network.requestWillBeSent.initiator`). The
 * network-side analogue of the CPU drilldown: when a span's waterfall is deep,
 * this points at the code (or the parser) that issued the requests.
 */
export interface Initiator {
  /** script | parser | preload | preflight | other */
  type: string;
  /** best-effort triggering site: "functionName  url:line" (script) or "url:line" (parser) */
  frame?: string;
}

/** Requests grouped by what issued them (heaviest first, by request count). */
export interface InitiatorStat {
  frame: string;
  type: string;
  requestCount: number;
  encodedKB: number;
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
  /** requests grouped by what issued them (top issuers first); over ALL requests */
  byInitiator: InitiatorStat[];
  requests: Array<{
    url: string;
    type: string;
    /** start offset relative to the span start (ms) */
    startOffsetMs: number;
    durationMs: number;
    kb: number;
    /** true if served from a registrable domain other than the page's */
    thirdParty: boolean;
    /** what triggered the request (code / parser), best-effort */
    initiator?: Initiator;
  }>;
}

/**
 * Responsiveness of the interactions inside a span (per-step INP). web-vitals
 * reports one page-global worst INP; this attributes the worst interaction to the
 * span it happened in and breaks it into the three INP phases, so you can see
 * which step is janky and why. Sourced from the Event Timing API
 * (interactionId > 0 entries). Undefined for spans with no interaction.
 */
export interface SpanInteraction {
  /** interactions (interactionId>0 event-timing entries) in the span */
  count: number;
  /** worst interaction's total latency (input → next paint), ms — the span's INP */
  maxDurationMs: number;
  /** event type of the worst interaction (click / keydown / pointerup / …) */
  type: string;
  /** time before the handler ran (main thread busy) */
  inputDelayMs: number;
  /** time spent in the event handlers */
  processingMs: number;
  /** time from handlers done to the next paint */
  presentationMs: number;
}

/**
 * Frame cadence during a span (animation smoothness), from a rAF probe. A static
 * span sits near display refresh with no drops; a janky pan/scroll shows dropped
 * frames and a long worst-frame. The量-side render metrics (paint/gpu) say how
 * much work; this says whether it actually rendered smoothly.
 */
export interface SpanFrames {
  count: number;
  /** missed display frames (each gap counts floor(gap/16.7)-1) */
  droppedFrames: number;
  /** longest gap between frames (ms) — the worst hitch */
  longestFrameMs: number;
  /** effective frames per second over the span */
  fps: number;
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
 * Memory load a span incurs, from CDP Performance.getMetrics gauges (always on,
 * no trace needed). This is per-step memory *load* — how much a step grows the JS
 * heap and what it retains (DOM / listeners / documents) — in the same
 * "resource consumed per step" model as cpu / network / render. It is NOT
 * heap-snapshot leak detection: the retained-object graph (which object holds
 * what) is out of scope. The leak *signal* here is a delta that stays positive
 * across repeated runs of the same step (heap / listeners / documents climbing).
 *
 * Byte-level binary / GPU memory is NOT available here: CDP getMetrics has no
 * byte counter for off-heap memory (only disabled-by-default-memory-infra trace
 * dumps do, which are heavy and unreliable headless), and JSHeapUsedSize counts
 * only on-heap JS objects — an ArrayBuffer / typed-array / wasm backing store is
 * off-heap and does NOT move it. The closest available proxy for buffer memory is
 * arrayBuffers, a *count* of live ArrayBuffers (climbing ⇒ buffers being retained,
 * e.g. GPU textures / staging buffers / wasm), not their byte size.
 */
export interface SpanMemory {
  /** on-heap JS in use at span end (MB, absolute; excludes off-heap buffer backing stores) */
  jsHeapUsedMB: number;
  /** on-heap JS growth during the span (MB; sustained positive across repeats ⇒ leak) */
  jsHeapDeltaMB: number;
  /** count of live ArrayBuffers at span end (NOT bytes; a climbing count ⇒ buffer leak) */
  arrayBuffers: number;
  /** total DOM nodes retained at span end (absolute; the DOM size, not the delta) */
  domNodes: number;
  /** event listeners retained at span end (absolute; climbing every step ⇒ listener leak) */
  jsEventListeners: number;
  /** net event listeners added during the span */
  listenersDelta: number;
  /** net documents added during the span (climbing ⇒ detached-document leak) */
  documentsDelta: number;
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

export interface NetworkReport {
  totalRequests: number;
  totalEncodedKB: number;
  byType: Record<string, { count: number; encodedKB: number }>;
  slowest: Array<{ url: string; type: string; durationMs: number; kb: number }>;
  /** scenario-wide third-party total (bytes/requests the app didn't ship) */
  thirdParty: ThirdPartyBreakdown;
  /** scenario-wide request issuers (which code / parser issued the most requests) */
  byInitiator: InitiatorStat[];
  /** requests served from cache (disk / memory / prefetch / SW) — no network fetch */
  fromCacheCount: number;
}

/** Upper bounds on page-global web-vitals (gated on the median, like span budgets). */
export interface VitalsBudget {
  LCP?: number;
  INP?: number;
  CLS?: number;
  TTFB?: number;
  FCP?: number;
}

/**
 * Growth of a memory metric across repeated runs of the SAME step (the `#0..#N`
 * spans emitted by measureRepeat). Per-step deltas are GC-noisy, but a value that
 * climbs monotonically every time you repeat the same operation is the real leak
 * signal — and it stays inside one scenario, so it isn't the out-of-scope
 * cross-scenario analysis. Most trustworthy under PERF_MEM=1 (retained-only).
 */
export interface MemoryTrend {
  /** the repeated step name (the shared prefix of the `#i` spans) */
  name: string;
  /** number of repeats */
  count: number;
  /** which memory gauge: jsHeapUsedMB | jsEventListeners | domNodes | arrayBuffers */
  metric: string;
  /** the metric's absolute value at the end of each repeat */
  values: number[];
  /** last - first */
  growth: number;
  /** growth per repeat */
  perStep: number;
  /** value never (meaningfully) dropped across the repeats */
  monotonic: boolean;
  /** monotonic AND grew past the metric's floor — flagged as a likely leak */
  leak: boolean;
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

/** Coverage of one downloaded resource (a JS chunk or a stylesheet). */
export interface CoverageFile {
  url: string;
  totalBytes: number;
  usedBytes: number;
  /** usedBytes / totalBytes as a percentage (0..100) */
  usedPct: number;
}

/** JS or CSS coverage rollup for the scenario. */
export interface CoverageReport {
  totalBytes: number;
  usedBytes: number;
  usedPct: number;
  /** per-resource, heaviest unused first (the best split / drop candidates) */
  files: CoverageFile[];
}

export interface Coverage {
  js: CoverageReport;
  css: CoverageReport;
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

const BYTES_PER_MB = 1024 * 1024;

/** CDP Performance.getMetrics memory gauges -> per-step memory load. */
function diffMemory(
  before: Record<string, number>,
  after: Record<string, number>,
): SpanMemory {
  const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  const a = (k: string) => after[k] ?? 0;
  return {
    jsHeapUsedMB: round(a("JSHeapUsedSize") / BYTES_PER_MB),
    jsHeapDeltaMB: round(d("JSHeapUsedSize") / BYTES_PER_MB),
    arrayBuffers: a("ArrayBufferContents"),
    domNodes: a("Nodes"),
    jsEventListeners: a("JSEventListeners"),
    listenersDelta: d("JSEventListeners"),
    documentsDelta: d("Documents"),
  };
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
// ---------------------------------------------------------------------------

interface NetReq {
  url: string;
  type: string;
  startMono: number;
  startEpochMs: number;
  endEpochMs?: number;
  encoded?: number;
  initiator?: Initiator;
  /** served from disk / memory / prefetch / service-worker cache (no network fetch) */
  fromCache?: boolean;
}

/** CDP initiator shape (only the fields we read). */
interface CdpInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  stack?: {
    callFrames?: Array<{
      functionName?: string;
      url?: string;
      lineNumber?: number;
    }>;
  };
}

/** Trim the origin off a URL for compact display (mirrors the drilldown). */
function shortenUrl(url: string): string {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return `${url.slice(0, comma > 0 ? Math.min(comma, 40) : 40)}…`;
  }
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60) || url.slice(0, 60);
}

/** Reduce a CDP initiator to a type + a single best-effort triggering frame. */
function summarizeInitiator(init: CdpInitiator | undefined): Initiator | undefined {
  if (!init) return undefined;
  const type = init.type ?? "other";
  const frames = init.stack?.callFrames ?? [];
  // the topmost frame with a script URL is the code that issued the request
  const top = frames.find((f) => f.url) ?? frames[0];
  if (top) {
    const fn = top.functionName || "(anonymous)";
    const loc = top.url ? `${shortenUrl(top.url)}:${(top.lineNumber ?? 0) + 1}` : "";
    return { type, frame: `${fn}  ${loc}`.trim() };
  }
  // parser-inserted (e.g. <img>/<script src>): initiator.url is the referencing doc
  if (init.url) {
    const loc = init.lineNumber != null ? `:${init.lineNumber + 1}` : "";
    return { type, frame: `${shortenUrl(init.url)}${loc}` };
  }
  return { type };
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
// Aggregation
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Max per-request detail entries kept per span (slowest-first); counts/bytes are full. */
const REQUESTS_PER_SPAN_LIMIT = 20;

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

/** Aggregate requests by their initiator frame (top issuers first, by count). */
function buildInitiators(
  records: Array<{ initiator?: Initiator; encodedKB: number }>,
): InitiatorStat[] {
  const by = new Map<string, InitiatorStat>();
  for (const r of records) {
    if (!r.initiator) continue;
    const frame = r.initiator.frame ?? `(${r.initiator.type})`;
    const bucket =
      by.get(frame) ??
      by.set(frame, { frame, type: r.initiator.type, requestCount: 0, encodedKB: 0 }).get(frame)!;
    bucket.requestCount += 1;
    bucket.encodedKB += r.encodedKB;
  }
  return [...by.values()]
    .map((s) => ({ ...s, encodedKB: round(s.encodedKB) }))
    .sort((a, b) => b.requestCount - a.requestCount || b.encodedKB - a.encodedKB)
    .slice(0, 8);
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
    initiator?: Initiator;
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
      initiator: r.initiator,
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
    byInitiator: buildInitiators(tpRecords),
    fromCacheCount: reqs.filter((r) => r.fromCache).length,
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
    initiator?: Initiator;
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
      initiator: r.initiator,
    });
    tpRecords.push({
      url: r.url,
      encodedKB: (r.encoded ?? 0) / 1024,
      interval,
      initiator: r.initiator,
    });
  }
  requests.sort((a, b) => b.durationMs - a.durationMs);
  // Cap the per-request detail list: a span on a request-heavy page can hold
  // hundreds of entries and bloat every report. Counts/bytes/busy/thirdParty
  // above are computed over all requests; only the (slowest-first) detail is cut.
  const requestCount = requests.length;
  return {
    requestCount,
    encodedKB: round(encoded / 1024),
    busyMs: round(unionLength(intervals)),
    waves: countWaves(intervals),
    thirdParty: buildThirdParty(tpRecords, firstPartyDomain),
    byInitiator: buildInitiators(tpRecords),
    requests: requests.slice(0, REQUESTS_PER_SPAN_LIMIT),
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

/** Memory gauges tracked for cross-step growth; floor = min growth to call a leak. */
const TREND_METRICS: Array<{
  key: string;
  get: (m: SpanMemory) => number;
  floor: number;
}> = [
  { key: "jsHeapUsedMB", get: (m) => m.jsHeapUsedMB, floor: 2 },
  { key: "jsEventListeners", get: (m) => m.jsEventListeners, floor: 10 },
  { key: "domNodes", get: (m) => m.domNodes, floor: 50 },
  { key: "arrayBuffers", get: (m) => m.arrayBuffers, floor: 5 },
];

const repeatIndex = (name: string): number => {
  const m = /#(\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
};

/**
 * Detect monotonic memory growth across the `${name}#${i}` spans of a measureRepeat.
 * A metric is reported only when it grows past its floor; `leak` is set when that
 * growth is also monotonic (the value didn't meaningfully drop between repeats).
 */
function buildTrends(spans: SpanReport[]): MemoryTrend[] {
  const groups = new Map<string, SpanReport[]>();
  for (const s of spans) {
    const m = /^(.*)#(\d+)$/.exec(s.name);
    if (!m) continue;
    const prefix = m[1];
    (groups.get(prefix) ?? groups.set(prefix, []).get(prefix)!).push(s);
  }
  const trends: MemoryTrend[] = [];
  for (const [prefix, group] of groups) {
    if (group.length < 3) continue; // too few points to call a trend
    group.sort((a, b) => repeatIndex(a.name) - repeatIndex(b.name));
    for (const tm of TREND_METRICS) {
      const values = group.map((s) => round(tm.get(s.memory)));
      const growth = round(values[values.length - 1] - values[0]);
      // Worst single backslide. A real leak ramps up with only minor dips; a
      // value that bounces (e.g. maplibre's tile buffers, reclaimed by GC between
      // steps) has a backslide comparable to or larger than its net growth, even
      // when the endpoints happen to be higher. Require the net climb to dominate
      // the jitter — otherwise the +N is noise, not retention.
      let maxDrop = 0;
      let maxStepInc = 0;
      let incCount = 0;
      for (let i = 1; i < values.length; i++) {
        const delta = values[i] - values[i - 1];
        if (delta > 0) {
          incCount += 1;
          if (delta > maxStepInc) maxStepInc = delta;
        } else if (-delta > maxDrop) {
          maxDrop = -delta;
        }
      }
      const monotonic = maxDrop <= 0.1 * Math.abs(growth);
      // A leak grows step over step. Three things must hold:
      // - the net climb dominates the worst backslide (not a bouncing series, e.g.
      //   maplibre tile buffers reclaimed by GC),
      // - the growth is a meaningful fraction of the baseline, not just past an
      //   absolute floor (a +8 churn on a 1500 baseline isn't a leak; 30→180 is),
      // - the growth is DISTRIBUTED across steps, not one jump (a single tile batch
      //   loaded on the last pan, 44→44→44→44→125, is a one-off, not retention).
      const rel = values[0] > 0 ? growth / values[0] : Infinity;
      // and the back half must keep growing — a series that ramps then plateaus
      // (maplibre warming its tile cache: 11→21→27→27.6) is allocation that
      // levels off, not an unbounded leak.
      const mid = Math.floor(values.length / 2);
      const secondHalfGrowth = values[values.length - 1] - values[mid];
      const distributed =
        maxStepInc <= 0.6 * growth &&
        incCount >= Math.ceil((values.length - 1) / 2) &&
        secondHalfGrowth >= 0.25 * growth;
      const leak =
        growth >= tm.floor && growth > 2 * maxDrop && rel >= 0.2 && distributed;
      if (!leak) continue; // only surface sustained, distributed, non-plateauing ramps
      trends.push({
        name: prefix,
        count: group.length,
        metric: tm.key,
        values,
        growth,
        perStep: round(growth / (group.length - 1)),
        monotonic,
        leak,
      });
    }
  }
  return trends;
}

// --- coverage (PERF_COV) -------------------------------------------------
// Playwright Chromium coverage entry shapes (only the fields we read).
interface JSCoverageEntry {
  url: string;
  source?: string;
  functions: Array<{
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}
interface CSSCoverageEntry {
  url: string;
  text?: string;
  ranges: Array<{ start: number; end: number }>;
}

/** Per-resource used byte ranges (merged), kept for cross-scenario union. */
interface CoverageArtifact {
  js: Array<{ url: string; total: number; used: Array<[number, number]> }>;
  css: Array<{ url: string; total: number; used: Array<[number, number]> }>;
}

/** Merge overlapping/adjacent byte ranges into a minimal sorted set. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const rangesLen = (r: Array<[number, number]>): number =>
  r.reduce((a, [s, e]) => a + (e - s), 0);

/**
 * V8 block coverage → used byte ranges. Ranges are nested: a byte's coverage is
 * the count of the INNERMOST range containing it (the outermost range is the whole
 * module and is count>0 whenever it merely evaluated, so a naive union of count>0
 * ranges reports ~100%). Paint outer→inner (inner overrides) and extract the runs
 * that ended up covered.
 */
function jsUsedRanges(
  functions: JSCoverageEntry["functions"],
  total: number,
): Array<[number, number]> {
  if (!total) return [];
  const ranges: Array<{ startOffset: number; endOffset: number; count: number }> = [];
  for (const fn of functions) for (const r of fn.ranges) ranges.push(r);
  // outer first: smaller start, then larger end; inner ranges come later and override
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const paint = new Uint8Array(total);
  for (const r of ranges) {
    paint.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, total));
  }
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < total; i++) {
    if (paint[i] === 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, total]);
  return out;
}

/** Group by url, merge used ranges; total = source/text length (or max offset). */
function collectCoverage(
  items: Array<{ url: string; total: number; used: Array<[number, number]> }>,
): Array<{ url: string; total: number; used: Array<[number, number]> }> {
  const by = new Map<
    string,
    { total: number; used: Array<[number, number]> }
  >();
  for (const it of items) {
    if (!it.url) continue; // skip inline/anonymous
    const b = by.get(it.url) ?? { total: 0, used: [] };
    b.total = Math.max(b.total, it.total);
    b.used.push(...it.used);
    by.set(it.url, b);
  }
  return [...by.entries()].map(([url, b]) => ({
    url,
    total: b.total,
    used: mergeRanges(b.used),
  }));
}

function toCoverageReport(
  perUrl: Array<{ url: string; total: number; used: Array<[number, number]> }>,
): CoverageReport {
  let totalBytes = 0;
  let usedBytes = 0;
  const files = perUrl.map((f) => {
    const used = rangesLen(f.used);
    totalBytes += f.total;
    usedBytes += used;
    return {
      url: f.url,
      totalBytes: f.total,
      usedBytes: used,
      usedPct: f.total > 0 ? Math.round((used / f.total) * 1000) / 10 : 0,
    };
  });
  // heaviest unused first — the best split/drop candidates
  files.sort((a, b) => b.totalBytes - b.usedBytes - (a.totalBytes - a.usedBytes));
  return {
    totalBytes,
    usedBytes,
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    files: files.slice(0, 40),
  };
}

/** Build the scenario coverage report + the range artifact (for cross-scenario union). */
function buildCoverage(
  js: JSCoverageEntry[],
  css: CSSCoverageEntry[],
): { coverage: Coverage; artifact: CoverageArtifact } {
  const jsItems = js.map((e) => {
    let maxEnd = 0;
    for (const fn of e.functions)
      for (const r of fn.ranges) if (r.endOffset > maxEnd) maxEnd = r.endOffset;
    const total = e.source?.length ?? maxEnd;
    return { url: e.url, total, used: jsUsedRanges(e.functions, total) };
  });
  const cssItems = css.map((e) => ({
    url: e.url,
    total: e.text?.length ?? 0,
    used: e.ranges.map((r) => [r.start, r.end] as [number, number]),
  }));
  const jsPerUrl = collectCoverage(jsItems);
  const cssPerUrl = collectCoverage(cssItems);
  return {
    coverage: { js: toCoverageReport(jsPerUrl), css: toCoverageReport(cssPerUrl) },
    artifact: { js: jsPerUrl, css: cssPerUrl },
  };
}

interface EpochEvent {
  epochStart: number;
  duration: number;
  type: string;
  start: number;
  processingStart: number;
  processingEnd: number;
}

/** Worst interaction in the span window, split into the three INP phases. */
function buildSpanInteraction(
  span: EpochWindow,
  events: EpochEvent[],
): SpanInteraction | undefined {
  const inWindow = events.filter(
    (e) => e.epochStart >= span.startEpochMs && e.epochStart <= span.endEpochMs,
  );
  if (inWindow.length === 0) return undefined;
  let worst = inWindow[0];
  for (const e of inWindow) if (e.duration > worst.duration) worst = e;
  return {
    count: inWindow.length,
    maxDurationMs: round(worst.duration),
    type: worst.type,
    inputDelayMs: round(worst.processingStart - worst.start),
    processingMs: round(worst.processingEnd - worst.processingStart),
    presentationMs: round(worst.start + worst.duration - worst.processingEnd),
  };
}

/** Frame cadence inside the span window (16.7ms = one 60Hz frame). */
function buildSpanFrames(
  span: EpochWindow,
  frameEpochs: number[],
): SpanFrames | undefined {
  const inWindow = frameEpochs
    .filter((t) => t >= span.startEpochMs && t <= span.endEpochMs)
    .sort((a, b) => a - b);
  if (inWindow.length < 2) return undefined;
  let dropped = 0;
  let longest = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const dt = inWindow[i] - inWindow[i - 1];
    if (dt > longest) longest = dt;
    const missed = Math.round(dt / 16.67) - 1;
    if (missed > 0) dropped += missed;
  }
  const seconds = (inWindow[inWindow.length - 1] - inWindow[0]) / 1000;
  return {
    count: inWindow.length,
    droppedFrames: dropped,
    longestFrameMs: round(longest),
    fps: seconds > 0 ? round((inWindow.length - 1) / seconds) : 0,
  };
}

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
// fixture
// ---------------------------------------------------------------------------

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
