import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ABOS_E2E_PORT ?? 3187);

export default defineConfig({
  testDir: "./tests",
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
