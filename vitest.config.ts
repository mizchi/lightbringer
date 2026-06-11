import { defineConfig } from "vitest/config";

// In-source tests live in src/**/*.ts behind `if (import.meta.vitest)`.
export default defineConfig({
  // Only files that carry `if (import.meta.vitest)` blocks. collector.ts imports
  // @playwright/test at module load, which must not run under the vitest runner.
  test: {
    includeSource: ["src/otel.ts", "src/trace.ts"],
    // examples/*.spec.ts are Playwright tests; keep the vitest runner out of them.
    // .direnv holds a Nix-materialized copy of the repo (incl. examples) — exclude it too.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**", "examples/**"],
  },
});
