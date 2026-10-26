import { defineConfig, devices } from "@playwright/test";

/** A separately started, disposable-only operational-password preview; never localhost:3200. */
export default defineConfig({
  testDir: "./tests",
  testMatch: "direct-shareholder-capital-operational.spec.ts",
  outputDir: "./test-results/direct-capital-operational",
  expect: { timeout: 30_000 },
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3191", trace: "retain-on-failure", ...devices["Desktop Chrome"] }
});
