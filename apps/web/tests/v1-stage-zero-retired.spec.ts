import { expect, test, type Page } from "@playwright/test";

import { PRODUCTION_ONLY, productionBuild } from "./support/build-mode";

// Owner decision, 2026-11-11: Stage 0 and demo screens are not product surfaces in production. On a production build their addresses answer
// Not Found, the shell lists none of them, and nobody is shown DEMO or Stage 0 wording. Development access is tested in stage-zero-routes.spec.ts.
const RETIRED = ["/projects", "/sales-crm", "/finance", "/construction", "/procurement", "/human-resources", "/reports-analytics", "/ai-insights", "/settings"];
const DEMO_WORDING = /DEMO DATA|Stage 0|INTERFACE PREVIEW|Public preview|synthetic/i;
const auth = { userAccountId: "7a000000-0000-4000-8000-000000000009", loginIdentifier: "ui.retired", displayName: "UI test Accountant", jobTitle: "Accountant",
  legalEntityName: "UI test company", permissions: ["finance.report.operational.read"], sessionExpiresAt: "2099-01-01T00:00:00Z" };

test.beforeEach(async ({ request }) => { test.skip(!(await productionBuild(request)), PRODUCTION_ONLY); });

/**
 * The Not Found page, exactly as for an address that never existed. The shell streams, so the HTTP status is 200 for every unknown address
 * in this application; what a person gets is the Not Found page, with no heading or content of the retired screen.
 */
async function expectNotFound(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Workspace not found" }), path).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(DEMO_WORDING);
}

test("@smoke every Stage 0 address answers Not Found on a production build, signed out", async ({ page }) => {
  for (const path of RETIRED) await expectNotFound(page, path);
  // A deeper address under a retired screen is not found either.
  await expectNotFound(page, "/projects/anything");
  // The same page as an address that was never a screen.
  await expectNotFound(page, "/never-a-screen");
});

test("the signed-out shell offers sign-in and nothing else, with no demo wording, in English and Dari", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/finance/trial-balance");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation.getByRole("link")).toHaveText(["Employee sign-in"]);
  await expect(page.locator(".sidebar-boundary")).toContainText("Sign-in required");
  await expect(page.locator(".shell-badge")).toHaveText("V1");
  await expect(page.locator("body")).not.toContainText(DEMO_WORDING);
  // Searching finds no demo screen.
  await page.getByRole("textbox", { name: "Search workspaces" }).fill("Projects");
  await expect(page.getByRole("navigation", { name: "Workspace search results" })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("navigation", { name: "ناوبری اصلی" }).getByRole("link")).toHaveText(["ورود کارمندان"]);
  await expect(page.locator(".sidebar-boundary")).toContainText("ورود لازم است");
  await expect(page.locator("body")).not.toContainText(/پیش‌نمایش عمومی|مرحله صفر/);
});

test("a signed-in person is not offered a Stage 0 screen and cannot open one by its address", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNotFound(page, "/sales-crm");
  const operations = page.getByRole("navigation", { name: "Operations" });
  await expect(operations).toBeVisible();
  for (const name of ["Projects", "Sales & CRM", "Construction", "Procurement", "Human Resources", "Reports & Analytics", "AI Insights", "Settings"]) {
    await expect(operations.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  await page.getByRole("textbox", { name: "Search workspaces" }).fill("Sales");
  await expect(page.getByRole("navigation", { name: "Workspace search results" }).getByRole("link", { name: /Sales & CRM/ })).toHaveCount(0);
  // The real Documents page stays: it is the V1 guide, not the Stage 0 prototype.
  const documents = await page.goto("/documents");
  expect(documents?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
});
