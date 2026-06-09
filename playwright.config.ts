import { defineConfig, devices } from "@playwright/test";

// PERF_GPU=1 uses hardware GL (mac: ANGLE Metal). Default headless Chromium runs
// SwiftShader (software GL), which makes WebGL / ReadPixels / GPU numbers diverge
// wildly from real hardware. Turn it on when measuring GPU-heavy pages.
const perfGpu = process.env.PERF_GPU === "1";
const gpuArgs = ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"];

export default defineConfig({
  testDir: "./examples",
  // perf measurement must be serial; parallel workers contend for CPU/GPU.
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    // bench specs use relative URLs against the fixture app; external-URL specs
    // (example.com, react.dev) pass absolute URLs and ignore this.
    baseURL: "http://localhost:5173",
    ...(perfGpu ? { launchOptions: { args: gpuArgs } } : {}),
  },
  // serves fixtures/app for the bench specs (rerender / reflow / input)
  webServer: {
    command: "pnpm exec vite",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
