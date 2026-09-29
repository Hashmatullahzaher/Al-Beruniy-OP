import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * The company dashboard at "/" needs company.dashboard.read, so the public Stage 0 shell is exercised
 * on /projects. The old presentation figures once shown at "/" must never come back as company facts.
 */
const RETIRED_DEMO_FIGURES = [
  "1,284", "$243.1M", "$186.4M", "$60.2M", "$54.2M", "$6.8M", "$28.6M", "246 team members",
  "72% sell-through", "68% average progress", "DEMO DATA", "Units Sold Value", "Portfolio fixture"
];

test("@smoke the company dashboard source holds no hard-coded business figures", async () => {
  const sources = ["../src/app/page.tsx", "../src/components/CompanyDashboardWorkspace.tsx"]
    .map((file) => readFileSync(resolve(__dirname, file), "utf8"));
  for (const source of sources) {
    for (const figure of RETIRED_DEMO_FIGURES) expect(source, `retired demo figure ${figure}`).not.toContain(figure);
    // A KPI value is computed from the read model, never written as a literal.
    expect(source).not.toMatch(/value:\s*["'`][$\d]/);
    expect(source).not.toMatch(/(demoKpis|projectProgress|aiItems|departments|alerts)\s*[:=]/);
  }
});

test("@smoke signed-out visitors to the company dashboard are sent to sign-in and see no company figures", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const text = await page.locator("body").innerText();
  for (const figure of RETIRED_DEMO_FIGURES) expect(text).not.toContain(figure);
  const api = await page.request.get("/api/v1/company/dashboard");
  expect(api.status()).toBe(401);
});

test("@smoke renders the public Stage 0 shell", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByText("No operational services connected")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  const hasHorizontalOverflow = await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(hasHorizontalOverflow).toBeFalsy();
});

test("@smoke routes to each approved Stage 0 workspace", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: /Finance/ }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();
  await expect(page.getByText("INTERFACE PREVIEW ONLY")).toBeVisible();
  await expect(page.getByText(/No real balances, capital receipts, vouchers, journals, posting, or treasury actions/)).toBeVisible();
});

test("health and readiness endpoints expose release metadata", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  const healthBody = await health.json();
  expect(healthBody).toMatchObject({ status: "ok", service: "web" });
  expect(healthBody.release.gitSha).toMatch(/^[0-9a-f]{40}$/);

  const ready = await request.get("/api/ready");
  expect(ready.ok()).toBeTruthy();
  expect(await ready.json()).toMatchObject({ status: "ready", checks: { applicationShell: "ready" } });
});

test("keyboard skip link and English/Dari switching work", async ({ page }) => {
  await page.goto("/projects");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "مالی" })).toBeVisible();
});

test("tablet navigation remains operable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/finance");
  const menu = page.getByRole("button", { name: "Toggle navigation" });
  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  const projectsLink = primaryNavigation.getByRole("link", { name: "Projects", exact: true });
  await expect(menu).toBeVisible();
  await expect(projectsLink).toBeHidden();
  await menu.click();
  await expect(primaryNavigation).toBeVisible();
  await expect(projectsLink).toBeVisible();
  await projectsLink.click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
});

test("desktop shell frame is complete and free of horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/projects");

  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  const layout = await page.locator("html").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test("interactive shell controls expose accessible names and explicit states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/projects");

  const unnamedControls = await page.locator("a, button, input").evaluateAll((elements) => elements
    .filter((element) => {
      const label = element.getAttribute("aria-label") ?? "";
      const text = element.textContent ?? "";
      const placeholder = element.getAttribute("placeholder") ?? "";
      return !(label.trim() || text.trim() || placeholder.trim());
    })
    .map((element) => element.outerHTML));
  expect(unnamedControls).toEqual([]);
  await expect(page.locator("img:not([alt])")).toHaveCount(0);

  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Notifications are not connected");

  const search = page.getByRole("textbox", { name: "Search workspaces" });
  await search.fill("Finance");
  await expect(page.getByRole("navigation", { name: "Workspace search results" }).getByRole("link", { name: "Finance" })).toBeVisible();
});
