import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Migration 0035: the simple Shareholders view (shareholder → contributions → add contribution),
 * through the real sign-in, role administration, API and restricted runtime login, in English and
 * Dari, on desktop and phone. DECLARATION ONLY: the test proves no money, Treasury or ledger table
 * changes, "None yet" sends nothing, and the legacy capital agreement stays visible and unchanged.
 * It reseeds only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-shareholder-contributions --workers=1
 */
const SHOTS = resolve(__dirname, "../test-results/v1-shareholder-contributions");
const ROOT = resolve(__dirname, "../../..");

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 shareholder contributions", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("a permitted person records cash, land and credit contributions in a simple view; nothing is posted", async ({ page }) => {
    test.setTimeout(480_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();
    const moneyBefore = await moneyFootprint();
    const legacyBefore = await legacyFingerprint();

    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await editor.getByLabel("Role name").fill("Shareholder Contributions Clerk");
    await editor.getByLabel("Description").fill("Records shareholder contributions (synthetic preview).");
    await editor.locator(".permission-row", { hasText: "Set up shareholders and capital agreements" }).locator("input").check();
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");
    await page.goto("/admin/users");
    await page.locator(".admin-list > button", { hasText: "Synthetic Treasury Manager" }).click();
    await page.locator(".admin-role-picker label", { hasText: "Shareholder Contributions Clerk" }).locator("input").check();
    await page.getByRole("button", { name: "Save roles" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Roles saved");
    await signOut(page);

    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await page.goto("/shareholders");
    const simple = page.getByRole("region", { name: "Shareholders and contributions" });
    await expect(simple).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Shareholder areas" })).toHaveCount(0, { timeout: 2_000 });

    // A shareholder with only a legacy cash agreement shows it as a legacy cash commitment, never "None yet".
    const legacyHolder = page.locator("article.contribution-card", { hasText: "Synthetic Shareholder One" });
    await expect(legacyHolder.getByTestId("legacy-commitment-chip")).toHaveText("Legacy cash commitment: USD 100,000.00 · Eligible");
    await expect(legacyHolder.getByTestId("legacy-cash-agreements")).toContainText("Legacy cash commitment");
    await expect(legacyHolder.getByTestId("legacy-cash-agreements")).toContainText("SYN-CAP-");
    await expect(legacyHolder.locator(".contribution-none")).toHaveCount(0);
    await expect(legacyHolder.locator("table.contribution-table")).toHaveCount(0, { timeout: 2_000 });
    expect(await occurrences(legacyHolder, "100,000.00"), "the legacy amount is shown exactly once").toBe(1);

    // A new shareholder starts with no contribution.
    await page.getByRole("button", { name: "Add shareholder" }).click();
    const newHolder = page.getByRole("form", { name: "New shareholder" });
    await newHolder.getByLabel("Full name").fill("Synthetic Shareholder Gamma");
    await newHolder.getByRole("button", { name: "Add shareholder" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("was added");
    const card = page.locator("article.contribution-card", { hasText: "Synthetic Shareholder Gamma" });
    await expect(card.locator(".contribution-none")).toHaveText("None yet");

    // None yet: nothing is sent and nothing is stored.
    const writes: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/v1/shareholder/")) writes.push(request.url()); });
    await card.getByRole("button", { name: "Add contribution" }).click();
    let form = card.getByRole("form", { name: "Add contribution" });
    await form.getByLabel("None yet").check();
    await expect(form.getByTestId("none-yet-note")).toContainText("Nothing is saved");
    await expect(form.getByLabel("Amount")).toHaveCount(0);
    await form.getByRole("button", { name: "Done" }).click();
    await expect(form).toHaveCount(0);
    expect(writes, "None yet sends no request").toEqual([]);
    expect(await contributionCount("Synthetic Shareholder Gamma")).toBe(0);

    // Cash: only cash fields.
    await card.getByRole("button", { name: "Add contribution" }).click();
    form = card.getByRole("form", { name: "Add contribution" });
    await form.getByLabel("Cash").check();
    await expect(form.locator('[data-fields="CASH"]')).toBeVisible();
    await expect(form.getByLabel("Item name")).toHaveCount(0);
    await form.getByLabel("Amount").fill("25000");
    await form.getByLabel("Currency").selectOption("USD");
    await form.getByLabel("Description (optional)").fill("Synthetic cash pledge");
    await form.getByRole("button", { name: "Save contribution" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("recorded as declared. Nothing was posted.");

    // Asset: land, with an informational estimate.
    await card.getByRole("button", { name: "Add contribution" }).click();
    form = card.getByRole("form", { name: "Add contribution" });
    await form.getByLabel("Asset").check();
    await expect(form.locator('[data-fields="IN_KIND"]')).toBeVisible();
    await expect(form.getByLabel("Amount", { exact: true })).toHaveCount(0);
    await form.getByLabel("Category").selectOption("LAND_PROPERTY");
    await form.getByLabel("Item name").fill("Synthetic plot for Block C");
    await form.getByLabel("Description", { exact: true }).fill("Synthetic land for one block of the mall");
    await form.getByLabel("Quantity (optional)").fill("1200");
    await form.getByLabel("Unit (optional)").fill("m2");
    await form.getByLabel("Estimated value (optional)").fill("350000");
    await form.getByLabel("Valuation currency").selectOption("USD");
    await form.getByLabel("Ownership / evidence note (optional)").fill("Synthetic deed SYN-DEED-7");
    await expect(form).toContainText("An estimated value is information only");
    await form.getByRole("button", { name: "Save contribution" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("recorded as declared");

    // Credit: unclassified by default.
    await card.getByRole("button", { name: "Add contribution" }).click();
    form = card.getByRole("form", { name: "Add contribution" });
    await form.getByLabel("Credit").check();
    await expect(form.locator('[data-fields="CREDIT"]')).toBeVisible();
    await form.getByLabel("Amount").fill("10000");
    await form.getByLabel("Currency").selectOption("AFN");
    await form.getByLabel("Description", { exact: true }).fill("Synthetic credit; Finance will decide its nature");
    await expect(form).toContainText("Classification: not yet classified");
    await form.getByRole("button", { name: "Save contribution" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("recorded as declared");

    const rows = card.locator("table.contribution-table tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(row(card, "CASH")).toContainText("USD 25,000");
    await expect(row(card, "CASH")).toContainText("Declared");
    await expect(row(card, "CASH")).toContainText("Not received");
    await expect(row(card, "IN_KIND")).toContainText("Land / property · Synthetic plot for Block C · 1,200 m2");
    await expect(row(card, "IN_KIND")).toContainText("USD 350,000 (estimate)");
    await expect(row(card, "IN_KIND")).toContainText("Not valued");
    await expect(row(card, "CREDIT")).toContainText("Not yet classified");
    await expect(row(card, "CREDIT")).toContainText("AFN 10,000");
    await expect(card.locator(".contribution-none")).toHaveCount(0);
    // Summary chips carry declaration semantics, so a total never reads as money received.
    await expect(card.locator('[data-total="CASH-USD"]')).toHaveText("Cash declared: USD 25,000 · Not received");
    await expect(card.locator('[data-total="CREDIT-AFN"]')).toContainText("Credit declared: AFN 10,000");
    await expect(card.locator(".contribution-total.estimate")).toContainText("Estimated asset value (information only)");
    await page.screenshot({ path: resolve(SHOTS, "01-contributions-en.png"), fullPage: true });

    // Edit the cash declaration; cancel the credit with a reason (it stays visible).
    await row(card, "CASH").getByRole("button", { name: "Edit" }).click();
    const edit = card.getByRole("form", { name: "Edit contribution" });
    await edit.getByLabel("Amount").fill("30000");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("updated");
    await expect(card.locator('[data-total="CASH-USD"]')).toHaveText("Cash declared: USD 30,000 · Not received");
    await row(card, "CREDIT").getByRole("button", { name: "Cancel contribution" }).click();
    const cancel = card.getByRole("form", { name: "Cancel contribution" });
    await cancel.getByLabel("Reason for cancelling").fill("Synthetic credit withdrawn");
    await cancel.getByRole("button", { name: "Cancel contribution" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("stays visible in the history");
    await expect(row(card, "CREDIT")).toContainText("Cancelled");
    await expect(card.locator('[data-total="CREDIT-AFN"]')).toHaveCount(0);

    // Mixed: a new cash contribution for the shareholder with a legacy commitment is counted on its own.
    await legacyHolder.getByRole("button", { name: "Add contribution" }).click();
    form = legacyHolder.getByRole("form", { name: "Add contribution" });
    await form.getByLabel("Cash").check();
    await form.getByLabel("Amount").fill("7500");
    await form.getByLabel("Currency").selectOption("USD");
    await form.getByRole("button", { name: "Save contribution" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("recorded as declared");
    await expect(legacyHolder.locator('[data-total="CASH-USD"]')).toHaveText("Cash declared: USD 7,500 · Not received");
    await expect(legacyHolder.getByTestId("legacy-commitment-chip")).toHaveText("Legacy cash commitment: USD 100,000.00 · Eligible");
    await expect(legacyHolder.locator(".contribution-total")).toHaveCount(2, { timeout: 2_000 });
    expect(await occurrences(legacyHolder, "100,000.00"), "legacy amount still shown once, never added to the cash total").toBe(1);
    expect(await occurrences(legacyHolder, "107,500"), "no combined total of legacy and new contributions").toBe(0);
    await expect(legacyHolder.locator(".contribution-none")).toHaveCount(0);

    // Advanced still exposes agreements, installments and capital requests.
    await page.getByRole("button", { name: "Advanced" }).click();
    const tabs = page.getByRole("tablist", { name: "Shareholder areas" });
    for (const name of ["Shareholders", "Capital Agreements", "Installments", "Capital Requests"]) {
      await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await tabs.getByRole("tab", { name: /^Capital Agreements/ }).click();
    await expect(page.locator(".shareholder-agreement", { hasText: "SYN-CAP-" }).first()).toBeVisible();
    await tabs.getByRole("tab", { name: "Installments" }).click();
    await expect(page.locator(".shareholder-agreement", { hasText: "SYN-CAP-" }).first()).toBeVisible();
    await tabs.getByRole("tab", { name: "Capital Requests" }).click();
    await expect(page.locator(".shareholder-request-note")).toBeVisible();

    // On company data the synthetic capital-request gate is closed. Close it here (disposable preview
    // database only) and check that it reads as "not operational", never as a sign-in problem.
    const gateExpiry = await query("SELECT expires_at::text AS value FROM abos.sandbox_authorizations WHERE singleton");
    expect(gateExpiry, "the preview sandbox gate exists").toBeTruthy();
    // The gate's own CHECK requires expires_at > authorized_at; one millisecond after it is already past.
    await query("UPDATE abos.sandbox_authorizations SET expires_at = authorized_at + interval '1 millisecond' WHERE singleton RETURNING 1 AS value");
    try {
      const refused = await page.evaluate(async () => {
        const response = await fetch("/api/v1/shareholder/capital-requests");
        return { status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code };
      });
      expect(refused).toEqual({ status: 403, code: "NOT_OPERATIONAL" });
      await tabs.getByRole("tab", { name: "Installments" }).click();
      await tabs.getByRole("tab", { name: "Capital Requests" }).click();
      const unavailable = page.getByTestId("capital-requests-not-operational");
      await expect(unavailable).toContainText("Capital Requests is not operational yet.");
      await expect(page.getByText("Sign in first")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
      await page.getByRole("button", { name: "Switch to Dari" }).click();
      await expect(unavailable).toContainText("درخواست سرمایه هنوز عملیاتی نشده است.");
      await expect(page.getByText("ابتدا وارد شوید")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "ورود" })).toHaveCount(0);
      await page.getByRole("button", { name: "Switch to English" }).click();
    } finally {
      await query("UPDATE abos.sandbox_authorizations SET expires_at = $1::timestamptz WHERE singleton RETURNING 1 AS value", [gateExpiry]);
    }
    await page.getByRole("button", { name: "Back to shareholders view" }).click();
    await expect(simple).toBeVisible();

    // Dari, desktop and phone.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await expect(legacyHolder.getByTestId("legacy-commitment-chip")).toHaveText("تعهد نقدی قبلی: USD 100,000.00 · واجد شرایط");
    await expect(legacyHolder.getByTestId("legacy-cash-agreements")).toContainText("تعهد نقدی قبلی");
    await expect(legacyHolder.locator('[data-total="CASH-USD"]')).toHaveText("پول نقد اعلام‌شده: USD 7,500 · دریافت‌نشده");
    // Dari money uses the same "USD 20,000" order as English, including the Advanced totals.
    await page.getByRole("button", { name: "جزئیات پیشرفته" }).click();
    await page.getByRole("tablist").getByRole("tab", { name: /^قراردادهای سرمایه/ }).click();
    const faTotals = await page.locator(".shareholder-totals").innerText();
    expect(faTotals, "Dari totals show the currency code first").toMatch(/USD [0-9]/);
    expect(faTotals, "no amount-first money in Dari").not.toMatch(/[0-9] USD/);
    await page.getByRole("button", { name: /بازگشت/ }).click();
    const faCard = page.locator("article.contribution-card", { hasText: "Synthetic Shareholder Gamma" });
    await expect(row(faCard, "CASH")).toContainText("اعلام‌شده");
    await expect(row(faCard, "IN_KIND")).toContainText("زمین / ملک");
    await faCard.getByRole("button", { name: "افزودن آورده" }).click();
    const faForm = faCard.getByRole("form", { name: "افزودن آورده" });
    for (const label of ["پول نقد", "جنس یا دارایی", "اعتبار", "فعلاً هیچ آورده‌ای ندارد"]) {
      await expect(faForm.getByLabel(label)).toBeVisible();
    }
    await faForm.getByLabel("جنس یا دارایی").check();
    await expect(faForm.getByLabel("نوع دارایی")).toBeVisible();
    await page.screenshot({ path: resolve(SHOTS, "02-contributions-dari.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    // At phone width the navigation slides off-canvas (180 ms); measure and capture only once it has settled.
    await expect(page.locator("#primary-sidebar")).toBeHidden();
    expect(await overflow(page), "no sideways scrolling, Dari phone with the form open").toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "03-contributions-phone-dari.png"), fullPage: true });
    await faForm.getByRole("button", { name: "لغو" }).click();
    await page.getByRole("button", { name: "Switch to English" }).click();
    expect(await overflow(page), "no sideways scrolling, English phone").toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "04-contributions-phone-en.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Nothing reached Treasury, posting, journals or the subledger; the legacy agreement is untouched.
    expect(await moneyFootprint()).toEqual(moneyBefore);
    expect(await legacyFingerprint()).toEqual(legacyBefore);
    expect(await contributionCount("Synthetic Shareholder Gamma")).toBe(3);
    expect(await contributionCount("Synthetic Shareholder One"), "the legacy agreement was never copied into contributions").toBe(1);
    await signOut(page);

    // Someone without the permission cannot read or write contributions.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    const status = await page.evaluate(async () => ({
      read: (await fetch("/api/v1/shareholder/contributions")).status,
      write: (await fetch("/api/v1/shareholder/setup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-contribution", shareholderProfileId: crypto.randomUUID(), contributionType: "CASH",
          businessDate: "2026-09-01", amount: "1", currencyCode: "USD" }) })).status
    }));
    expect(status).toEqual({ read: 403, write: 403 });
  });
});

/** How many times a text occurs in the visible text of a card. */
async function occurrences(card: Locator, text: string): Promise<number> {
  return (await card.innerText()).split(text).length - 1;
}

function row(card: Locator, type: "CASH" | "IN_KIND" | "CREDIT"): Locator {
  return card.locator(`tr[data-contribution-type="${type}"]`);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function moneyFootprint(): Promise<unknown> {
  return query(`SELECT jsonb_build_object(
    'cashReceipts', (SELECT count(*) FROM abos.cash_receipts), 'handoffs', (SELECT count(*) FROM abos.treasury_finance_handoffs),
    'requests', (SELECT count(*) FROM abos.capital_receipt_intents), 'postingIntents', (SELECT count(*) FROM abos.posting_intents),
    'journals', (SELECT count(*) FROM abos.journals), 'lines', (SELECT count(*) FROM abos.journal_lines),
    'subledger', (SELECT count(*) FROM abos.subledger_entries), 'expenses', (SELECT count(*) FROM abos.operational_expenses),
    'consumed', (SELECT coalesce(sum(consumed_amount), 0) FROM abos.capital_agreement_commitment_usage)) AS value`);
}

async function legacyFingerprint(): Promise<unknown> {
  return query(`SELECT jsonb_build_object(
    'agreements', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM abos.capital_agreements t),
    'installments', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM abos.capital_installments t),
    'requests', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM abos.capital_receipt_intents t)) AS value`);
}

async function contributionCount(name: string): Promise<number> {
  return Number(await query(`SELECT count(*)::int AS value FROM abos.shareholder_contributions c
    JOIN abos.shareholder_profiles p ON p.id = c.shareholder_profile_id JOIN abos.business_parties b ON b.id = p.business_party_id
   WHERE b.display_name = $1`, [name]));
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
