import { test, expect, type Page } from "@playwright/test";
import { test as perfTest } from "../src/index";

// TEMPORARY dogfood — bacuri production build on :4173. Multiple real scenarios so
// coverage.mjs can union them into suite-wide dead code. Not committed.
const APP = "http://localhost:4173/";
const settle = (page: Page) => page.waitForLoadState("networkidle").catch(() => {});
void test;
void expect;

async function loadMap(page: Page) {
  await page.goto(APP);
  await page.locator(".maplibregl-canvas").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
}
async function panZoom(page: Page) {
  const box = await page.locator(".maplibregl-canvas").first().boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 200, cy - 140, { steps: 10 });
  await page.mouse.up();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
}
const click = (page: Page, name: string) =>
  page.getByRole("button", { name }).click({ timeout: 6000 }).catch(() => {});
const clickTestId = (page: Page, id: string) =>
  page.getByTestId(id).click({ timeout: 6000 }).catch(() => {});

perfTest.describe("df: bacuri", () => {
  perfTest("load", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
  });

  perfTest("pan-zoom", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
    await perf.measure("pan-zoom", () => panZoom(page), { settle });
  });

  perfTest("layer-toggle", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
    await perf.measure("toggle-ndvi", () => clickTestId(page, "satellite-layer-toggle-ndvi"), { settle });
    await perf.measure("toggle-ndmi", () => clickTestId(page, "satellite-layer-toggle-ndmi"), { settle });
    await perf.measure("toggle-scl", () => clickTestId(page, "satellite-layer-toggle-scl"), { settle });
  });

  perfTest("date-nav", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
    await perf.measure("next-date", () => click(page, "Next date"), { settle });
    await perf.measure("prev-sunny", () => click(page, "Previous sunny day"), { settle });
  });

  perfTest("ndvi-chart", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
    await perf.measure(
      "open-chart",
      async () => {
        await click(page, "Batch NDVI chart");
        await page.waitForTimeout(800);
      },
      { settle },
    );
  });

  perfTest("pan-repeat", async ({ page, perf }) => {
    await perf.measure("initial-load", () => loadMap(page), { settle });
    await perf.measureRepeat("pan", () => panZoom(page), { times: 5, settle });
  });
});
