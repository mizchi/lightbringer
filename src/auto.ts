// Auto-span fixture: measure an EXISTING Playwright spec with (almost) no edits.
// Swap `import { test, expect } from "@playwright/test"` for
// `import { test, expect } from "lightbringer/auto"` and every page navigation /
// interaction (page.goto, and Locator actions like getByRole(...).click()) becomes
// a measured span automatically — no perf.measure() calls in the spec body.
//
// It works by wrapping page.goto / page.<action> and the Locator prototype's action
// methods to run inside controller.measure(). A reentrancy guard prevents
// double-counting when a Page convenience method delegates to a Locator.
//
// Caveat vs. explicit perf.measure: each span covers one action's own cost (action
// + a short settle), NOT "until your next assertion". For "until settled" windows,
// use the explicit `test` from "lightbringer" and perf.measure().
import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import {
  startSession,
  logSummary,
  checkBudgets,
  type PerfController,
  PERF_OUT_DIR,
  CPU_RATE,
  NET_PROFILE,
  CSS_STATS,
  TRACE_ENABLED,
  COV_ENABLED,
  MEM_GC,
} from "./collector";

// Locator/Page action methods worth a span (navigations + interactions).
const ACTION_METHODS = [
  "click",
  "dblclick",
  "fill",
  "press",
  "type",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "setInputFiles",
  "tap",
  "hover",
  "dragTo",
  "clear",
] as const;

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function locatorLabel(loc: unknown): string {
  // Locator.toString() → e.g. `locator('#run')` / `getByTestId('x')`; trim wrapper.
  const s = String(loc);
  return s.replace(/^[A-Za-z]+\(['"]?/, "").replace(/['"]?\)$/, "").slice(0, 50);
}

export const test = base.extend<{ perf: PerfController }>({
  page: async ({ page }, use, testInfo) => {
    const slug = testInfo.titlePath
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}_]+/gu, "_");
    const runTag = `run${testInfo.repeatEachIndex}`;
    const tracePath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.trace.json`);
    if (TRACE_ENABLED) fs.mkdirSync(PERF_OUT_DIR, { recursive: true });

    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client, {
      cpuRate: CPU_RATE,
      netProfile: NET_PROFILE,
      cssStats: CSS_STATS,
      trace: TRACE_ENABLED,
      tracePath,
      coverage: COV_ENABLED,
      memGc: MEM_GC,
    });
    if (CPU_RATE > 1 && testInfo.timeout > 0) {
      testInfo.setTimeout(testInfo.timeout * CPU_RATE);
    }
    const controller = session.controller;

    // Reentrancy guard: page.click(sel) internally drives a Locator action (also
    // wrapped); only the outermost call should open a span.
    let active = false;
    const wrap =
      (orig: AnyFn, label: (self: unknown, args: unknown[]) => string) =>
      function (this: unknown, ...args: unknown[]) {
        if (active) return orig.apply(this, args);
        active = true;
        return controller
          .measure(label(this, args), () => orig.apply(this, args))
          .finally(() => {
            active = false;
          });
      };

    // Patch page.goto + page-level action convenience methods (on the instance).
    const restore: Array<() => void> = [];
    const p = page as unknown as Record<string, AnyFn>;
    const origGoto = p.goto.bind(page);
    p.goto = wrap(origGoto, (_s, a) => `goto ${String(a[0] ?? "")}`) as AnyFn;
    restore.push(() => {
      p.goto = origGoto;
    });
    for (const m of ACTION_METHODS) {
      if (typeof p[m] !== "function") continue;
      const orig = p[m].bind(page);
      p[m] = wrap(orig, (_s, a) => `${m} ${String(a[0] ?? "")}`.slice(0, 56)) as AnyFn;
      restore.push(() => {
        p[m] = orig;
      });
    }

    // Patch the Locator prototype's action methods (covers getByRole/locator/...).
    const proto = Object.getPrototypeOf(page.locator("html")) as Record<string, AnyFn>;
    for (const m of ACTION_METHODS) {
      if (typeof proto[m] !== "function") continue;
      const orig = proto[m];
      proto[m] = wrap(orig, (self) => `${m} ${locatorLabel(self)}`) as AnyFn;
      restore.push(() => {
        proto[m] = orig;
      });
    }

    try {
      await use(page);
    } finally {
      for (const r of restore) r();
    }

    const { report, covArtifact } = await session.finish(testInfo.title);

    fs.mkdirSync(PERF_OUT_DIR, { recursive: true });
    const jsonPath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    if (covArtifact) {
      fs.writeFileSync(
        path.join(PERF_OUT_DIR, `${slug}.${runTag}.coverage.json`),
        JSON.stringify(covArtifact),
      );
    }
    await testInfo.attach("perf-report", {
      path: jsonPath,
      contentType: "application/json",
    });

    logSummary(report, MEM_GC);

    if (process.env.PERF_ASSERT === "1") {
      const violations = checkBudgets(report);
      if (violations.length > 0) {
        throw new Error(`perf budget exceeded:\n  ${violations.join("\n  ")}`);
      }
    }
  },
});

export { expect } from "@playwright/test";
