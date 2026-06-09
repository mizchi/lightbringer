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
    ...(perfGpu ? { launchOptions: { args: gpuArgs } } : {}),
  },
});
