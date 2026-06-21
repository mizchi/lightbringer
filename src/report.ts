import { toOtelSpans } from "./otel";
import { round, type EpochWindow } from "./analyze/util";
import {
  hostOf,
  registrableDomain,
  shortenUrl,
  buildGlobalNetwork,
  buildSpanNetwork,
  type NetReq,
} from "./analyze/network";
import {
  buildTraceRender,
  buildSpanCpu,
  type TraceEvent,
} from "./analyze/render";
import { buildTrends } from "./analyze/memory";
import type { CoverageReport } from "./analyze/coverage";
import {
  pickAttribution,
  buildSpanInteraction,
  buildSpanFrames,
  type VitalSample,
  type EpochEvent,
} from "./analyze/vitals";
import { MEM_GC } from "./config";
import type { PerfWindow } from "./browser";
import type { RawSpan } from "./controller";
import {
  checkBudgets,
  type PerfReport,
  type SpanReport,
  type AppSpanReport,
} from "./report-types";

// ---------------------------------------------------------------------------
// Report assembly. Pulls the per-domain breakdowns from ./analyze and composes
// them into the SpanReport / PerfReport contract.
// ---------------------------------------------------------------------------

export function buildReport(
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
