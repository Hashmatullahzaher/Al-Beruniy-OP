import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ABOS_CAPITAL_E2E_PORT ?? 3190);

/**
 * Dedicated authenticated 0038 suite. It deliberately disables the memory-only review flag and
 * never reuses an arbitrary development server, so a green result proves the operational routes.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: ["v1-shareholder-capital-activation.spec.ts", "v1-temporary-funding.spec.ts", "v1-workflow-policy.spec.ts"],
  outputDir: "./test-results/capital",
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/capital" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure"
  },
  projects: [{ name: "capital-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/ready`,
    env: { ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE: "0" },
    reuseExistingServer: false,
    timeout: 120_000
  }
});
