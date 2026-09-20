import { expect, test } from "@playwright/test";

test("@smoke renders the operational shell and explicit demonstration data labels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "Mazar Mall & Al-Beruniy District" })).toBeVisible();
  await expect(page.getByText("DEMO DATA", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Synthetic demonstration metrics")).toBeVisible();
  await expect(page.getByText("Total Projects", { exact: true })).toBeVisible();
  await expect(page.getByText("No operational services connected")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  const hasHorizontalOverflow = await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(hasHorizontalOverflow).toBeFalsy();
});

test("@smoke routes to each approved Stage 0 workspace", async ({ page }) => {
  await page.goto("/");
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
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
  await expect(page.getByRole("heading", { level: 2, name: "مزار مال و ناحیه البرونی" })).toBeVisible();
});

test("tablet navigation remains operable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
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

test("desktop reference frame is complete and free of horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Mazar Mall & Al-Beruniy District" })).toBeVisible();
  await expect(page.getByLabel("Synthetic demonstration metrics")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /Sales Performance/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /AI Insights/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /Department Overview/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /Latest Alerts/ })).toBeVisible();

  const layout = await page.locator("html").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test("interactive shell controls expose accessible names and explicit states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

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
