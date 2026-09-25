import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * WP-C: daily exchange rates, AFN capital requests with rate snapshots, and shareholder capital
 * requests, through the real sign-in, administration and restricted runtime login.
 * Reseeds the disposable dev database:
 *   ABOS_E2E_PORT=3193 ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-currency --workers=1
 */
const SHOTS = resolve(__dirname, "../test-results/v1-currency");
const ROOT = resolve(__dirname, "../../..");

test.use({ viewport: { width: 1440, height: 900 } });

function kabulDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86_400_000));
}

test.describe("V1 currency and shareholder capital", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run this.");

  test("rates are recorded exactly, AFN requests keep their day's rate, and currencies stay separate", async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();

    // The Super Administrator creates a role and gives it to the Finance preparer.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await editor.getByLabel("Role name").fill("Currency and Capital Clerk");
    for (const permission of ["Record daily exchange rates", "Open capital requests from installments", "View Finance inbox and journals"]) {
      await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
    }
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");
    await page.goto("/admin/users");
    await page.locator(".admin-list > button", { hasText: "Synthetic Intent Creator" }).click();
    await page.locator(".admin-role-picker label", { hasText: "Currency and Capital Clerk" }).locator("input").check();
    await page.getByRole("button", { name: "Save roles" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Roles saved");
    await signOut(page);

    // Record today's market rate exactly as quoted, then correct it with a reason.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.getByRole("link", { name: "Exchange rates" }).click();
    await expect(page).toHaveURL(/\/finance\/exchange-rates/);
    const entry = page.getByRole("form", { name: "Record exchange rate" });
    await entry.getByLabel(/^Rate \(/).fill("71.2540");
    await expect(entry).toContainText("1 USD = 71.2540 AFN");
    await entry.getByRole("button", { name: "Record rate" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("exactly as entered");
    const table = page.locator(".rates-table");
    await expect(table.locator("tbody tr").first()).toContainText("1 USD = 71.2540 AFN");
    await entry.getByLabel(/^Rate \(/).fill("72");
    await entry.getByRole("button", { name: "Record rate" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("record a correction instead");
    await table.getByRole("button", { name: "Correct" }).click();
    const correction = page.getByRole("form", { name: "Correct exchange rate" });
    await correction.getByLabel("Correct rate").fill("71.264");
    await correction.getByLabel("Reason").fill("Synthetic demonstration: quoted 71.264");
    await correction.getByRole("button", { name: "Save correction" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Correction recorded");
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.locator("tr.superseded")).toContainText("71.2540");
    await expect(table.locator("tbody tr").first()).toContainText("1 USD = 71.264 AFN");
    await page.screenshot({ path: resolve(SHOTS, "01-exchange-rates.png"), fullPage: true });

    // Shareholder capital: a USD request, then an AFN request that keeps today's rate.
    await page.getByRole("link", { name: "Shareholder capital" }).click();
    await expect(page).toHaveURL(/\/shareholders/);
    const totals = page.locator(".shareholder-total");
    await expect(totals).toHaveCount(2);
    await expect(totals.nth(0)).toContainText("AFN");
    await expect(totals.nth(1)).toContainText("USD");
    const usd = page.locator(".shareholder-agreement", { hasText: "USD" }).filter({ hasText: "SYN-CAP-" });
    await usd.getByRole("button", { name: "Create request" }).first().click();
    const usdForm = page.getByRole("form", { name: "Create capital request" });
    await expect(usdForm.locator("fieldset.shareholder-rates")).toHaveCount(0);
    await usdForm.getByRole("button", { name: "Create capital request" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Capital request created");

    const afn = page.locator(".shareholder-agreement").filter({ hasText: "SYN-AFN-" });
    // A day without a recorded rate is refused; no other day's rate is used.
    await afn.getByRole("button", { name: "Create request" }).first().click();
    const afnForm = page.getByRole("form", { name: "Create capital request" });
    await afnForm.getByLabel("Business date").fill(kabulDate(-2));
    await expect(afnForm.locator(".shareholder-rate-missing")).toBeVisible();
    await afnForm.getByRole("button", { name: "Create capital request" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("record that day's rate first");
    await afnForm.getByLabel("Business date").fill(kabulDate());
    await expect(afnForm).toContainText("1 USD = 71.264 AFN");
    await afnForm.getByRole("button", { name: "Create capital request" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("rate kept as its snapshot");
    await expect(afn.locator(".shareholder-snapshot").first()).toContainText("1 USD = 71.264 AFN");
    await expect(afn).toContainText("AFN 1,782,500");
    await expect(totals.nth(0)).toContainText("AFN 1,782,500");
    await expect(totals.nth(1)).toContainText("USD");
    await page.screenshot({ path: resolve(SHOTS, "02-shareholder-capital.png"), fullPage: true });

    // Dari and phone width.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.getByRole("heading", { name: "سرمایه سهامداران" })).toBeVisible();
    await page.screenshot({ path: resolve(SHOTS, "03-shareholder-dari.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/finance/exchange-rates");
    await expect(page.locator(".rates-table")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "04-rates-phone-dari.png"), fullPage: true });
    await page.getByRole("button", { name: "Switch to English" }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await signOut(page);

    // Someone without the permissions: rates are read-only, shareholder capital is refused by the server.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/exchange-rates");
    await expect(page.getByText("You can view rates but not record them.")).toBeVisible();
    await page.goto("/shareholders");
    await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
    const refused = await page.evaluate(async () => (await fetch("/api/v1/finance/exchange-rates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rateDate: new Date().toISOString().slice(0, 10), source: "MARKET", unitCurrency: "USD", quoteCurrency: "AFN", rate: "70" })
    })).status);
    expect(refused).toBe(403);
    const refusedRequest = await page.evaluate(async () => (await fetch("/api/v1/shareholder/capital-requests", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ installmentId: crypto.randomUUID() })
    })).status);
    expect(refusedRequest).toBe(403);
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
  const env = { ...process.env, ...environment };
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: ROOT, env, encoding: "utf8", shell: process.platform === "win32"
  });
  execFileSync("node", ["--experimental-strip-types", "packages/e1-integration/src/currency-preview-fixture.ts"], {
    cwd: ROOT, env, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}
