import { test } from "../src/index";

// Observation-only specs against noisy, ad-heavy production sites. Unlike the
// synthetic fixtures these have huge request counts, third-party scripts, and
// run-to-run variance — a stress test for the harness (use --repeat-each + median).
const sites = [
  { name: "nicovideo", url: "https://www.nicovideo.jp/" },
  { name: "goal", url: "https://www.goal.com/en" },
];

for (const site of sites) {
  test.describe(`real: ${site.name}`, () => {
    test.setTimeout(120_000);

    test("load and scroll", async ({ page, perf }) => {
      await perf.measure("initial-load", async () => {
        await page.goto(site.url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        // let post-DCL work (hydration, ads, lazy content) run
        await page.waitForTimeout(3000);
      });

      await perf.measure("scroll", async () => {
        await page.mouse.wheel(0, 5000);
        await page.waitForTimeout(2000);
      });
    });
  });
}
