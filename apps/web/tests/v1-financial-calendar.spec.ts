import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V1 financial calendar through the real sign-in, administration and restricted Finance login.
 * Reseeds the disposable dev database: ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-financial-calendar --workers=1
 */
const SHOTS = resolve(__dirname, "../test-results/v1-calendar");

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 financial calendar", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run this.");

  test("a permitted Finance user chooses Solar Hijri and generates a year of pending periods", async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();

    // The Super Administrator creates a calendar role and gives it to the Finance approver.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await editor.getByLabel("Role name").fill("Finance Calendar Manager");
    for (const permission of ["Manage financial calendar", "View Finance inbox and journals"]) {
      await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
    }
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");
    await page.goto("/admin/users");
    await page.locator(".admin-list > button", { hasText: "Synthetic Finance Approver" }).click();
    await page.locator(".admin-role-picker label", { hasText: "Finance Calendar Manager" }).locator("input").check();
    await page.getByRole("button", { name: "Save roles" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Roles saved");
    await signOut(page);

    // A Finance user without the calendar permission can look but not change anything.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.goto("/finance/calendar");
    await expect(page.getByText("You can view the calendar but not change it.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
    const refused = await page.evaluate(async () => (await fetch("/api/v1/finance/calendar", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendarKind: "GREGORIAN", reportingCalendars: ["GREGORIAN"], expectedVersion: 0 })
    })).status);
    expect(refused).toBe(403);
    await signOut(page);

    // The calendar manager chooses Solar Hijri and generates FY 1406.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/calendar");
    const settings = page.getByRole("form", { name: "Financial calendar settings" });
    await settings.locator("label", { hasText: "Solar Hijri" }).first().locator("input[type=radio]").check();
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("settings saved");
    const generator = page.getByRole("form", { name: "Generate fiscal year" });
    await generator.getByLabel("Solar Hijri year").fill("1406");
    await expect(generator).toContainText("FY 1406 SH");
    await generator.getByRole("button", { name: "Generate fiscal year" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("twelve pending periods");
    const year = page.locator(".calendar-year", { hasText: "FY 1406 SH" });
    await expect(year.locator("tbody tr")).toHaveCount(12);
    await expect(year.locator("tbody tr").first()).toContainText("Hamal 1406");
    await expect(year.locator("tbody tr").first()).toContainText("21 March 2027");
    await expect(year.locator("tbody tr").last()).toContainText("Hut 1406");
    await expect(year.getByText("Pending · not open for posting")).toHaveCount(12);
    // The year type is now fixed.
    await expect(settings.locator(".calendar-kinds input[type=radio]").first()).toBeDisabled();
    await page.screenshot({ path: resolve(SHOTS, "01-calendar-generated.png") });

    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator(".calendar-year").first().locator("tbody tr").first()).toContainText("حمل ۱۴۰۶");
    await page.screenshot({ path: resolve(SHOTS, "02-calendar-dari.png") });
    await page.getByRole("button", { name: "Switch to English" }).click();
  });
});

async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function signOut(page: Page): Promise<void> {
  await page.locator(".account-control > button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

function seedPreview(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) environment[match[1]] = match[2];
  }
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: { ...process.env, ...environment }, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}
