import { expect, test } from "@playwright/test";

test("@smoke renders the operational shell and explicit empty data states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText("No verified financial data")).toBeVisible();
  await expect(page.getByText("No operational services connected")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

test("@smoke routes to each approved Stage 0 workspace", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Finance/ }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();
  await expect(page.getByText("This module is not operational yet")).toBeVisible();
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

test("keyboard skip link and RTL readiness work", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("button", { name: "Toggle English and Dari layout direction" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
});

test("tablet navigation remains operable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Toggle navigation" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await page.getByRole("link", { name: /Projects/ }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
});
