import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Operational Finance through the real UI, identity and database boundaries: role-aware navigation,
 * Record expense (approval OFF), Daily transactions and the Daily financial report, in English and
 * Dari. It resets only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-operational-finance --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TECHNICAL_TERMS = [
  "POSTED", "PENDING_APPROVAL", "VALIDATED", "OPERATIONAL_V1", "LEGACY_E1", "finance.expense",
  "SECURITY DEFINER", "processing model", "idempotency", "V1 operations"
];

test.describe("V1 operational finance", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("a Finance user records an expense and sees it in daily transactions and the daily report; others do not see the work", async ({ page }) => {
    test.setTimeout(240_000);
    const accounts = seedPreview();
    await configureSyntheticOperationalFinance();

    // Someone without expense responsibilities is not offered the pages, and the server refuses them.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    const cashierNav = page.getByRole("navigation", { name: "Operations" });
    await expect(cashierNav.getByRole("link", { name: "Record expense" })).toHaveCount(0);
    await expect(cashierNav.getByRole("link", { name: "Daily transactions" })).toHaveCount(0);
    await page.goto("/finance/record-expense");
    await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
    await signOut(page);

    // The Finance user sees daily work and reports in business language.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    const nav = page.getByRole("navigation", { name: "Operations" });
    await expect(nav.getByText("Daily work", { exact: true })).toBeVisible();
    await expect(nav.getByText("Reports", { exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Record expense" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Record expense" })).toBeVisible();

    const form = page.getByRole("form", { name: "Record expense" });
    await form.getByLabel("Date *").fill("2026-09-22");
    await form.getByLabel("Paid from *").selectOption({ label: "Synthetic Main Safe · USD" });
    await form.getByLabel("Expense type *").selectOption({ label: "Synthetic Office Supplies" });
    await form.getByLabel("Amount (USD) *").fill("125.50");
    await form.getByLabel("Receipt or reference number *").fill("SYN-RCPT-001");
    await form.getByLabel("What was it for? *").fill("Synthetic printer paper");
    await form.getByRole("button", { name: "Record expense" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense recorded" }))
      .toContainText("Expense recorded: 125.50 USD from Synthetic Main Safe.");
    await expectNoTechnicalTerms(page);

    // Daily transactions shows it as recorded, with who recorded it.
    await page.getByRole("link", { name: "See daily transactions" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Daily transactions" })).toBeVisible();
    await page.getByLabel("From", { exact: true }).fill("2026-09-01");
    await page.getByLabel("To", { exact: true }).fill("2026-09-30");
    const row = page.locator(".register-table tbody tr").filter({ hasText: "SYN-RCPT-001" });
    await expect(row).toContainText("125.50 USD");
    await expect(row).toContainText("Recorded");
    await expect(row).toContainText("Synthetic Intent Creator");
    await expect(page.locator(".register-totals")).toContainText("125.50 USD");
    await expectNoTechnicalTerms(page);

    // The daily report takes its figures from the recorded transaction.
    await nav.getByRole("link", { name: "Daily financial report" }).click();
    await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
    await expect(page.locator(".register-totals")).toContainText("Expenses in USD (1)");
    await expect(page.locator(".register-totals")).toContainText("125.50 USD");
    const movement = page.locator("tr").filter({ hasText: "Synthetic Main Safe" });
    await expect(movement).toContainText("−125.50 USD");
    await expectNoTechnicalTerms(page);

    // Dari is complete on the same pages.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "گزارش مالی روزانه" })).toBeVisible();
    await page.getByRole("navigation", { name: "عملیات" }).getByRole("link", { name: "ثبت مصرف" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "ثبت مصرف" })).toBeVisible();
    await expectNoTechnicalTerms(page);
  });
});

test.describe("V1 operational finance setup", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("Finance sets up a Treasury account, an expense type and an open period in the app, then records an expense", async ({ page }) => {
    test.setTimeout(240_000);
    const accounts = seedPreview();
    await configureSyntheticOperationalFinance({ setupInTheApp: true });

    // Role editor explains the operational permissions in plain language, never as codes.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    for (const label of ["Record expenses", "View expenses and the daily report", "Approve expenses",
      "Set up Treasury accounts for daily Finance", "Set up expense types", "Open accounting periods"]) {
      await expect(editor.locator(".permission-row", { hasText: label })).toHaveCount(1);
    }
    await expect(editor).not.toContainText("finance.expense.create");
    await signOut(page);

    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    const nav = page.getByRole("navigation", { name: "Operations" });
    await expect(nav.getByText("Setup", { exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Finance setup" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Finance setup" })).toBeVisible();
    await expect(page.locator(".setup-checklist")).toContainText("Expense approval: OFF");
    await expect(page.locator(".setup-checklist li.missing")).toHaveCount(2);

    // Treasury account.
    await page.getByRole("button", { name: "Add account" }).click();
    const account = page.getByRole("form", { name: "Treasury account" });
    await account.getByLabel("Name (English) *").fill("Synthetic Main Safe");
    await account.getByLabel("Name (Dari)").fill("صندوق اصلی آزمایشی");
    await account.getByLabel("Type *").selectOption({ label: "Safe" });
    await account.getByLabel("Currency *").selectOption("USD");
    await account.getByLabel("Chart of Accounts account *").selectOption({ index: 1 });
    await account.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Treasury account saved" })).toBeVisible();

    // Expense type.
    await page.getByRole("button", { name: "Add expense type" }).click();
    const type = page.getByRole("form", { name: "Expense type" });
    await type.getByLabel("Code *").fill("SYN-OFFICE");
    await type.getByLabel("Name (English) *").fill("Synthetic Office Supplies");
    await type.getByLabel("Expense account in the Chart of Accounts *").selectOption({ label: "SYN-6100 · Synthetic Office Supplies Expense" });
    await type.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense type saved" })).toBeVisible();

    // Open the pending period.
    const pending = page.locator("tr").filter({ hasText: "Synthetic 2026-10" });
    await expect(pending).toContainText("Not open yet");
    await pending.getByRole("button", { name: "Open" }).click();
    await pending.getByLabel("Reason").fill("Synthetic: October opens for recording");
    await pending.getByRole("button", { name: "Open period" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Accounting period opened" })).toBeVisible();
    await expect(page.locator("tr").filter({ hasText: "Synthetic 2026-10" })).toContainText("Open");
    await expect(page.locator(".setup-checklist li.missing")).toHaveCount(0);
    await expectNoTechnicalTerms(page);

    // The configuration is immediately usable for recording.
    await nav.getByRole("link", { name: "Record expense" }).click();
    const form = page.getByRole("form", { name: "Record expense" });
    await form.getByLabel("Date *").fill("2026-10-05");
    await form.getByLabel("Paid from *").selectOption({ label: "Synthetic Main Safe · USD" });
    await form.getByLabel("Expense type *").selectOption({ label: "Synthetic Office Supplies" });
    await form.getByLabel("Amount (USD) *").fill("42.00");
    await form.getByLabel("Receipt or reference number *").fill("SYN-OCT-001");
    await form.getByLabel("What was it for? *").fill("Synthetic stationery");
    await form.getByRole("button", { name: "Record expense" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense recorded" }))
      .toContainText("Expense recorded: 42.00 USD from Synthetic Main Safe.");

    // Dari on the setup page.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await page.getByRole("navigation", { name: "عملیات" }).getByRole("link", { name: "تنظیمات مالی" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "تنظیمات مالی" })).toBeVisible();
    await expect(page.locator("tr").filter({ hasText: "صندوق اصلی آزمایشی" })).toContainText("صندوق");
    await expectNoTechnicalTerms(page);
  });
});

async function expectNoTechnicalTerms(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const term of TECHNICAL_TERMS) expect(text, `page shows "${term}"`).not.toContain(term);
}

/** Test-only operational configuration inside the disposable preview database. */
async function configureSyntheticOperationalFinance(options: { readonly setupInTheApp?: boolean } = {}): Promise<void> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    const one = async (sql: string, params: unknown[] = []) => (await client.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const entity = await one("SELECT id FROM abos.legal_entities ORDER BY created_at LIMIT 1");
    const bootstrap = await one("SELECT id FROM abos.user_accounts WHERE display_name = 'Synthetic Super Admin'");
    const preparer = await one("SELECT id FROM abos.user_accounts WHERE login_identifier = 'demo.finance.preparer'");
    const cash = await one(
      `SELECT id FROM abos.ledger_accounts WHERE legal_entity_id = $1 AND control_account_type = 'CASH'
         AND account_currency_code = 'USD' AND status = 'ACTIVE' AND posting_allowed ORDER BY account_code LIMIT 1`, [entity]);
    const expenseLedger = randomUUID();
    await client.query(
      `INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type,
         posting_allowed, account_currency_code, status)
       VALUES ($1,$2,'SYN-6100','Synthetic Office Supplies Expense','EXPENSE',true,'USD','ACTIVE')`, [expenseLedger, entity]);
    if (options.setupInTheApp === true) {
      // Only what other screens own: the approval policy (Workflow approvals), a pending period
      // (Financial calendar) and the setup and expense permissions (Roles). Treasury accounts, expense
      // types and opening the period are done through the Finance setup page.
      await client.query(
        `INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on)
         VALUES ($1,$2,'Synthetic 2026-10','2026-10-01','2026-10-31')`, [randomUUID(), entity]);
      await client.query(
        `INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version, approval_required,
           configured_by_user_account_id, change_reason)
         VALUES ($1,$2,'EXPENSE',1,false,$3,'Synthetic preview: approval OFF.')`, [randomUUID(), entity, bootstrap]);
      for (const permission of ["finance.expense.create", "finance.expense.read", "treasury.operational-account.manage",
        "finance.expense-category.manage", "finance.period.manage"]) {
        await client.query(
          `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1,$2,$3,$4)`, [preparer, entity, permission, bootstrap]);
      }
      return;
    }
    await client.query(
      `INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, name_fa, account_type, currency_code,
         ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
       VALUES ($1,$2,'Synthetic Main Safe','صندوق اصلی آزمایشی','SAFE','USD',$3,'ACTIVE',1,$4,$4)`, [randomUUID(), entity, cash, bootstrap]);
    await client.query(
      `INSERT INTO abos.operational_expense_categories (id, legal_entity_id, category_code, name_en, name_fa,
         ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
       VALUES ($1,$2,'SYN-OFFICE','Synthetic Office Supplies','لوازم دفتر آزمایشی',$3,'ACTIVE',1,$4,$4)`,
      [randomUUID(), entity, expenseLedger, bootstrap]);
    await client.query(
      `INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version, approval_required,
         configured_by_user_account_id, change_reason)
       VALUES ($1,$2,'EXPENSE',1,false,$3,'Synthetic preview: approval OFF.')`, [randomUUID(), entity, bootstrap]);
    for (const permission of ["finance.expense.create", "finance.expense.read"]) {
      await client.query(
        `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1,$2,$3,$4)`, [preparer, entity, permission, bootstrap]);
    }
  } finally {
    await client.end();
  }
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

function seedPreview(): Record<string, string> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}

function assertDisposablePreviewDatabase(ownerUrl: string | undefined, identityUrl: string | undefined): void {
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  expect(identityUrl, "ABOS_IDENTITY_DATABASE_URL for the same isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  const identityDatabase = new URL(identityUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  expect(identityDatabase).toBe(ownerDatabase);
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
