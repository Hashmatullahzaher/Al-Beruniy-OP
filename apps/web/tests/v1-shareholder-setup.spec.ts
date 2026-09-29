import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Migration 0031: shareholder master data and DRAFT capital agreement setup, through the real
 * sign-in, role administration, API and restricted runtime login, in English and Dari, on desktop
 * and phone. It reseeds only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-shareholder-setup --workers=1
 */
const SHOTS = resolve(__dirname, "../test-results/v1-shareholder-setup");
const ROOT = resolve(__dirname, "../../..");
const HASH = "4f9c2d1e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f10";

test.use({ viewport: { width: 1440, height: 900 } });

function kabulDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86_400_000));
}

test.describe("V1 shareholder setup", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("a permitted person sets up a shareholder, a draft agreement, its document and installments; no money moves", async ({ page }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();
    const before = await moneyFootprint();

    // The Super Administrator creates a role with the new permission (labelled in English and Dari).
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await expect(editor.locator(".permission-row", { hasText: "Set up shareholders and capital agreements" })).toHaveCount(1);
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator(".permission-row", { hasText: "تنظیم سهامداران و قراردادهای سرمایه" })).toHaveCount(1);
    await page.getByRole("button", { name: "Switch to English" }).click();
    await editor.getByLabel("Role name").fill("Shareholder Setup Clerk");
    await editor.getByLabel("Description").fill("Sets up shareholders and draft capital agreements (synthetic preview).");
    await editor.locator(".permission-row", { hasText: "Set up shareholders and capital agreements" }).locator("input").check();
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");
    await page.goto("/admin/users");
    await page.locator(".admin-list > button", { hasText: "Synthetic Treasury Manager" }).click();
    await page.locator(".admin-role-picker label", { hasText: "Shareholder Setup Clerk" }).locator("input").check();
    await page.getByRole("button", { name: "Save roles" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Roles saved");
    await signOut(page);

    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Shareholder capital" }).click();
    await expect(page).toHaveURL(/\/shareholders$/);
    const tabs = page.getByRole("tablist", { name: "Shareholder areas" });
    for (const name of ["Shareholders", "Capital Agreements", "Installments", "Capital Requests"]) {
      await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(page.getByTestId("receipt-not-operational")).toContainText("not operational on real company data yet");

    // Shareholders: add one; the same reference in another case is refused company-wide.
    await page.getByRole("button", { name: "Add shareholder" }).click();
    let form = page.getByRole("form", { name: "New shareholder" });
    await form.getByLabel("Full name").fill("Synthetic Shareholder Beta");
    await form.getByLabel(/^Reference/).fill("SH-BETA");
    await form.getByLabel("Shareholder since").fill(kabulDate(-10));
    await form.getByRole("button", { name: "Add shareholder" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("was added as an active shareholder");
    const row = page.locator(".shareholder-list tbody tr", { hasText: "Synthetic Shareholder Beta" });
    await expect(row).toContainText("SH-BETA");
    await expect(row).toContainText("Active");
    await page.getByRole("button", { name: "Add shareholder" }).click();
    form = page.getByRole("form", { name: "New shareholder" });
    await form.getByLabel("Full name").fill("Synthetic Duplicate");
    await form.getByLabel(/^Reference/).fill(" sh-beta ");
    await form.getByRole("button", { name: "Add shareholder" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("already used by another business party");
    await form.getByRole("button", { name: "Cancel" }).click();
    // Corrections while nothing is posted.
    await row.getByRole("button", { name: "Correct" }).click();
    const correction = page.getByRole("form", { name: "Correct shareholder" });
    await correction.getByLabel("Full name").fill("Synthetic Shareholder Beta (checked)");
    await correction.getByRole("button", { name: "Save correction" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("corrected");
    await expect(page.locator(".shareholder-list")).toContainText("Synthetic Shareholder Beta (checked)");

    // Capital agreement: created as a draft; the reasons no capital can be received are listed.
    await tabs.getByRole("tab", { name: /^Capital Agreements/ }).click();
    await page.getByRole("button", { name: "New capital agreement" }).click();
    form = page.getByRole("form", { name: "New capital agreement" });
    await form.getByLabel("Shareholder").selectOption({ label: "Synthetic Shareholder Beta (checked) · SH-BETA" });
    await form.getByLabel("Agreement reference").fill("SYN-AGR-BETA");
    await form.getByLabel("Committed capital").fill("50000");
    await form.getByLabel("Currency").selectOption("USD");
    await form.getByLabel("Effective on").fill(kabulDate(-5));
    await form.getByRole("button", { name: "Create draft agreement" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Draft agreement SYN-AGR-BETA was created");
    const card = page.locator(".shareholder-agreement[data-agreement='SYN-AGR-BETA']");
    await expect(card).toContainText("Draft");
    await expect(card.locator(".shareholder-figures")).toContainText("USD 50,000");
    const why = card.locator(".shareholder-why");
    await expect(why).toContainText("The agreement is still a draft");
    await expect(why).toContainText("No signed agreement document is recorded");
    await expect(why).toContainText("Receiving capital is not operational on company data yet");

    // The signed agreement document: reference, date and fingerprint only.
    await card.getByRole("button", { name: "Record agreement document" }).click();
    form = card.getByRole("form", { name: "Record agreement document" });
    await form.getByLabel("Document reference").fill("Signed agreement SYN-AGR-BETA (synthetic)");
    await form.getByLabel("Signing date").fill(kabulDate(-6));
    await form.getByLabel(/^SHA-256/).fill(HASH);
    await form.getByRole("button", { name: "Record document" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("recorded for this agreement");
    await expect(card.locator(".shareholder-documents")).toContainText(`Document date ${kabulDate(-6)}`);
    await expect(why).not.toContainText("No signed agreement document");

    // Installments: the plan can never exceed the commitment; cancelling releases its share.
    await tabs.getByRole("tab", { name: "Installments" }).click();
    await page.getByRole("button", { name: "Add installment" }).click();
    form = page.getByRole("form", { name: "New installment" });
    await form.getByLabel("Draft agreement").selectOption({ label: "SYN-AGR-BETA · Synthetic Shareholder Beta (checked) · USD" });
    await form.getByLabel(/^Installment amount/).fill("30000");
    await form.getByRole("button", { name: "Add installment" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("added to the plan");
    const plan = page.locator(".shareholder-agreement", { hasText: "SYN-AGR-BETA" });
    await page.getByRole("button", { name: "Add installment" }).click();
    form = page.getByRole("form", { name: "New installment" });
    await form.getByLabel("Draft agreement").selectOption({ label: "SYN-AGR-BETA · Synthetic Shareholder Beta (checked) · USD" });
    await expect(form).toContainText("Still available to plan: USD 20,000");
    await form.getByLabel(/^Installment amount/).fill("25000");
    await form.getByRole("button", { name: "Add installment" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("more than the committed capital");
    await form.getByRole("button", { name: "Cancel" }).click();
    await plan.getByRole("button", { name: "Cancel installment" }).click();
    const cancel = page.getByRole("form", { name: "Cancel installment" });
    await cancel.getByLabel("Reason for cancelling").fill("Synthetic schedule change");
    await cancel.getByRole("button", { name: "Cancel installment" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("no longer counts toward the plan");
    await page.getByRole("button", { name: "Add installment" }).click();
    form = page.getByRole("form", { name: "New installment" });
    await form.getByLabel("Draft agreement").selectOption({ label: "SYN-AGR-BETA · Synthetic Shareholder Beta (checked) · USD" });
    await form.getByLabel(/^Installment amount/).fill("50000");
    await form.getByRole("button", { name: "Add installment" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("added to the plan");
    await expect(plan.locator("tbody tr")).toHaveCount(2);
    await expect(plan.locator("tr.shareholder-cancelled")).toContainText("Cancelled");
    await expect(plan).toContainText("USD 50,000 / USD 50,000");
    await page.screenshot({ path: resolve(SHOTS, "01-installments-en.png"), fullPage: true });

    // Capital requests: the existing workflow, with the receipt boundary stated.
    await tabs.getByRole("tab", { name: "Capital Requests" }).click();
    await expect(page.locator(".shareholder-request-note")).toContainText("works for synthetic sandbox data only");

    // Dari, desktop and phone.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    for (const name of ["سهامداران", "قراردادهای سرمایه", "اقساط", "درخواست‌های سرمایه"]) {
      await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(page.getByTestId("receipt-not-operational")).toContainText("هنوز هیچ پولی دریافت نمی‌شود");
    await page.getByRole("tab", { name: /^قراردادهای سرمایه/ }).click();
    await expect(card).toContainText("پیش‌نویس");
    await expect(card.locator(".shareholder-why")).toContainText("دریافت سرمایه هنوز روی داده‌های شرکت فعال نیست");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await page.screenshot({ path: resolve(SHOTS, "02-agreements-dari.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["سهامداران", "قراردادهای سرمایه", "اقساط"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no sideways scrolling on ${tab}`).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: resolve(SHOTS, "03-installments-phone-dari.png"), fullPage: true });
    await page.getByRole("button", { name: "Switch to English" }).click();
    await page.getByRole("tab", { name: /^Capital Agreements/ }).click();
    const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(phoneOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "04-agreements-phone-en.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Nothing reached Treasury, posting, journals or the subledger.
    expect(await moneyFootprint()).toEqual(before);
    await signOut(page);

    // Someone without the permission: the API refuses reads and writes; the page says so.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    const status = await page.evaluate(async () => ({
      read: (await fetch("/api/v1/shareholder/setup")).status,
      write: (await fetch("/api/v1/shareholder/setup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-shareholder", displayName: "Refused", shareholderSince: "2026-01-01" }) })).status
    }));
    expect(status).toEqual({ read: 403, write: 403 });
    await page.goto("/shareholders");
    await expect(page.getByRole("heading", { name: "You do not have access" }).first()).toBeVisible();
    expect(await partyCount("Refused")).toBe(0);
  });
});

async function moneyFootprint(): Promise<unknown> {
  return query(`SELECT jsonb_build_object(
    'cashReceipts', (SELECT count(*) FROM abos.cash_receipts), 'handoffs', (SELECT count(*) FROM abos.treasury_finance_handoffs),
    'requests', (SELECT count(*) FROM abos.capital_receipt_intents), 'postingIntents', (SELECT count(*) FROM abos.posting_intents),
    'journals', (SELECT count(*) FROM abos.journals), 'lines', (SELECT count(*) FROM abos.journal_lines),
    'subledger', (SELECT count(*) FROM abos.subledger_entries), 'consumed', (SELECT coalesce(sum(consumed_amount), 0) FROM abos.capital_agreement_commitment_usage)) AS value`);
}

async function partyCount(name: string): Promise<number> {
  return Number(await query("SELECT count(*)::int AS value FROM abos.business_parties WHERE display_name = $1", [name]));
}

async function query(sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<{ value: unknown }>(sql, [...parameters])).rows[0]?.value;
  } finally {
    await client.end();
  }
}

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
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: ROOT, env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

/** Refuses to run unless the owner and every restricted login point at one disposable preview database. */
function assertDisposablePreviewDatabase(environment: Record<string, string | undefined>): void {
  const ownerUrl = environment.ABOS_DATABASE_URL;
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  for (const name of ["ABOS_IDENTITY_DATABASE_URL", "ABOS_FINANCE_DATABASE_URL", "ABOS_TREASURY_DATABASE_URL"]) {
    const url = environment[name];
    expect(url, name).toBeTruthy();
    expect(new URL(url ?? "").pathname.slice(1), `${name} database`).toBe(ownerDatabase);
  }
}
