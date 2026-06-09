# lightbringer

Per-step web performance measurement for Playwright.

Lighthouse only measures the initial load. For SPAs and interaction-heavy pages,
the expensive work happens **after** an interaction (route changes, data fetches,
re-renders, map/canvas redraws). lightbringer wraps each step of a Playwright
scenario and breaks its cost into **network**, **CPU**, and **render**, so the
only way to move the number is to change the implementation — not how the test
waits.

```
[perf] measure initial load and a follow-up navigation
  vitals  LCP=120 (good)  INP=48 (good)  CLS=0 (good)  TTFB=12 (good)
  initial-load                  210ms
      net   busy=160ms  18reqs  7waves  680KB
      cpu   block=52ms  longtasks=1  maxTask=52ms  loaf=1/0ms
      render style=7/4.5ms  layout=7/8.9ms  script=56ms  paint=8/1.7ms  gpu=6ms
  app-work                       22ms
      ...
  app spans (performance.measure):
    demo-work 20ms  net=0ms/0KB  cpu=0ms
  total network 21 reqs / 681KB
```

## What it measures

Per **span** (one `perf.measure(name, action)` region):

- **web-vitals (attribution build)** — LCP / INP / CLS / TTFB / FCP with attribution.
- **network** (CDP) — request count, transferred KB, `busyMs` (union of request
  intervals = how long the network was actually busy), and `waves` (approximate
  serial-dependency depth of the waterfall).
- **cpu** — long task count, total blocking time, heaviest long task, LoAF.
- **render** — style recalc / layout count and time (from CDP
  `Performance.getMetrics` cumulative counters), JS execution time; and, with
  `PERF_TRACE=1`, Paint count/time and GPU task time from the trace.

All times are unified to epoch ms so spans correlate with network / CPU even
across navigations.

## Install

```sh
pnpm add -D lightbringer @playwright/test
```

`web-vitals` is pulled in automatically.

## Usage

Use the extended `test` fixture and measure named steps:

```ts
import { test, expect } from "lightbringer";

test("checkout flow", async ({ page, perf }) => {
  await perf.measure("initial-load", async () => {
    await page.goto("https://app.example.com");
    await expect(page.getByRole("heading")).toBeVisible();
  });

  await perf.measure("open-cart", async () => {
    await page.getByRole("button", { name: "Cart" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
```

Reports are written to `perf-results/<title>.run<idx>.json` and a summary is
logged. Put your `waitFor`/`expect` assertions **inside** the action so the span
covers "until the operation is done".

```sh
pnpm exec playwright test                       # measure
PERF_TRACE=1 pnpm exec playwright test          # also save a Chrome trace
PERF_CPU=4 pnpm exec playwright test            # throttle CPU 4x (mid-tier device)
pnpm exec playwright test --repeat-each=5        # multiple runs for median
node node_modules/lightbringer/scripts/median.mjs
```

### CPU throttling (find bottlenecks hidden by a fast machine)

A fast dev machine makes app JS look free. `PERF_CPU=N` slows the CPU N times via
CDP (`Emulation.setCPUThrottlingRate`), so React re-render storms and heavy
synchronous work surface as long tasks. GPU/GL is **not** throttled, so this
isolates the JS/main-thread cost. Note that the page's own fixed `waitFor`
timeouts may need raising under heavy throttle.

### Median (kill the noise)

A single run is noisy (JIT / cache / GC). For regression checks and before/after
comparisons, run N times and take the median:

```sh
pnpm exec playwright test --repeat-each=5
lightbringer-median            # writes <slug>.median.json, prints median (min..max)
```

`min..max` is the noise band — how far you can trust the number.

### Drilldown (find the cause)

When a span's CPU is high, capture a trace and aggregate it within the span
window to see which subsystem and which functions spend the time:

```sh
PERF_TRACE=1 pnpm exec playwright test
lightbringer-drilldown <slug> <spanName>
```

It prints three views: an event-name breakdown (Layout / Paint / FunctionCall /
WebGL / `v8.parseOnBackground` / …), a function **total** time (includes children),
and a function **self** time computed from the V8 CPU profiler — the latter is what
pinpoints the actual hot function (e.g. a specific React render), with V8 synthetic
frames like `(idle)` / `(program)` filtered out.

### App spans (`withSpan`)

To attribute cost to a region of your **application** code, wrap it with
`withSpan`. It emits a standard `performance.measure` (visible in the DevTools
Performance panel too), which lightbringer collects and converts into an
OpenTelemetry-style span, nested inside the operation span by time containment:

```ts
import { withSpan } from "lightbringer";

const stats = await withSpan("loadStats", () => fetchStats(id), { id });
```

Nothing is sent to a server. The `toOtelSpans` output is where an OTLP exporter
could plug in later.

### Custom settle

After an action, lightbringer waits for the page to "settle" before closing the
span. The default waits for two animation frames. Override it per call or per
controller for app-specific readiness (e.g. waiting for a map's `idle` event):

```ts
await perf.measure("pan-map", async () => { /* ... */ }, {
  settle: (page) =>
    page.evaluate(() => new Promise<void>((r) => myMap.once("idle", r))),
});
```

Settle is bounded by `PERF_SETTLE_TIMEOUT` (default 5000ms). If it times out the
span is flagged `capped` and its `durationMs` should not be trusted (read the
network / CPU / render breakdown instead).

## Caveats

- **Default headless Chromium uses SwiftShader (software GL).** WebGL / ReadPixels
  / `gpuMs` and the `cpu.block` of GPU-heavy steps balloon far beyond real
  hardware and can mask real JS cost. Measure with **`PERF_GPU=1`** to use
  hardware GL (ANGLE Metal on macOS). Verify via the WebGL renderer string; on
  CI without a real GPU it stays SwiftShader, so don't trust map/canvas GPU/CPU
  numbers there.
- **Dev servers differ from production.** A dev server that serves unbundled ES
  modules inflates request counts and transfer size. Measure a production build
  for network/bundle decisions. Runtime responsiveness (INP) is build-independent.
- **`cpu.block` is the sum of long tasks.** Very short synchronous work, or work
  that doesn't cross a task boundary, may not register as a long task (it shows
  in LoAF instead). Use the trace for fine-grained attribution.
- **`logSummary` warns automatically** when the WebGL renderer is SwiftShader
  (software GL → fake GPU numbers) or when uncaught page errors occurred during
  the run (a broken / stale build makes the measurement invalid). The report
  carries `glRenderer` and `pageErrors`.
- The drilldown's **self** time comes from the V8 CPU profiler (sampling), so it
  is approximate at very short durations; the **total** view and event-name view
  complement it.

## License

MIT
