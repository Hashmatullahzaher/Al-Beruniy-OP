import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Operational Finance from a brand-new company, through the real UI, identity and database boundaries.
 *
 * The database starts with only the installation shell, a Super Administrator and one single-operator
 * Finance user (scripts/first-run-seed.ts). Everything else is set up in the app, in the order a new
 * company meets it: financial year → Chart of Accounts → Workflow approvals → Safe and expense type →
 * shareholder → capital into the Safe → expense → reversal → reports. Nothing is spent before the Safe is
 * funded. SQL is used only to read and verify. It resets only an explicitly disposable preview database
 * and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-operational-finance --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TECHNICAL_TERMS = [
  "POSTED", "PENDING_APPROVAL", "VALIDATED", "OPERATIONAL_V1", "LEGACY_E1", "finance.expense",
  "SECURITY DEFINER", "processing model", "idempotency", "V1 operations"
];

test.describe("V1 operational finance from a new company", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("a single Finance operator sets up a new company, funds the Safe, spends, corrects and reports", async ({ page }) => {
    test.setTimeout(420_000);
    const accounts = seedFirstRun();
    const year = new Date().getFullYear();
    await expectBusinessCounts({ fiscal_years: 0, ledger_accounts: 0, workflow_policies: 0, treasury_accounts: 0,
      shareholders: 0, journals: 0 });

    // The administrator has no Finance access and is not offered the work; the server refuses it too.
    await signIn(page, "super.admin", accounts["super.admin"]);
    const adminNav = page.getByRole("navigation", { name: "Operations" });
    await expect(adminNav.getByRole("link", { name: "Record expense" })).toHaveCount(0);
    await expect(page.getByRole("note").filter({ hasText: "nobody can give access to themselves" })).toBeVisible();
    await page.goto("/finance/record-expense");
    await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
    await signOut(page);

    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    const nav = page.getByRole("navigation", { name: "Operations" });

    // 1. Financial year: Gregorian, this calendar year.
    await nav.getByRole("link", { name: "Financial calendar" }).click();
    const settings = page.getByRole("form", { name: "Financial calendar settings" });
    await settings.locator("label", { hasText: "Gregorian" }).first().locator("input[type=radio]").check();
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("settings saved");
    const generator = page.getByRole("form", { name: "Generate fiscal year" });
    await generator.getByLabel("Starting Gregorian year").fill(String(year));
    await generator.getByRole("button", { name: "Generate fiscal year" }).click();
    await expect(page.locator(".calendar-year").filter({ hasText: String(year) }).locator("tbody tr")).toHaveCount(12);

    // 2. Chart of Accounts under the protective default: a new account waits for another person's review.
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await expect(page.getByText("In a one-person company, turn Chart of Accounts approval OFF in Workflow approvals")).toBeVisible();
    await createAccount(page, { code: "1100", name: "Main Cash Safe - USD", type: "ASSET", control: "CASH" });
    const tree = page.getByLabel("Accounts", { exact: true });
    await expect(tree.locator("button", { hasText: "1100" })).toContainText("Awaiting review");

    // 3. Workflow approvals: each note states what happens before anything is saved; one operator saves OFF.
    await nav.getByRole("link", { name: "Workflow approvals" }).click();
    const chartCard = policyCard(page, "Chart of Accounts");
    const capitalCard = policyCard(page, "Shareholder capital receipt");
    await expect(chartCard.getByRole("note")).toContainText("In a one-person company, save approval OFF");
    await expect(capitalCard.getByRole("note")).toContainText("Until a setting is saved, shareholder capital cannot be recorded");
    for (const [card, reason] of [[chartCard, "Single operator: no second reviewer"], [capitalCard, "Single operator records capital directly"]] as const) {
      await card.getByLabel("Reason for this change").fill(reason);
      await card.getByRole("button", { name: "Save new version" }).click();
      await expect(card.locator(".treasury-chip")).toHaveText("Approval OFF");
      await expect(card.locator("footer")).toContainText("Version 1");
    }

    // 4. The waiting account is released under the explicit OFF policy; later accounts need no review.
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await page.getByRole("tab", { name: /Review list/ }).click();
    const waiting = page.getByRole("article", { name: "Review 1100" });
    await expect(waiting).toContainText("Approval is currently OFF");
    await waiting.getByLabel("Reason for policy-based release").fill("Single operator; approval OFF");
    await waiting.getByRole("button", { name: "Re-evaluate under current policy" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("released under approval OFF");
    await page.getByRole("tab", { name: /^Accounts/ }).click();
    await createAccount(page, { code: "3100", name: "Shareholder Capital", type: "EQUITY", control: "SHAREHOLDER_CAPITAL" });
    await createAccount(page, { code: "5100", name: "Office Expense", type: "EXPENSE" });
    for (const code of ["1100", "3100", "5100"]) await expect(tree.locator("button", { hasText: code })).toContainText("Approval not required");

    // 5. Finance setup: the Safe and the expense type.
    await nav.getByRole("link", { name: "Finance setup" }).click();
    await page.getByRole("button", { name: "Add account" }).click();
    const treasury = page.getByRole("form", { name: "Treasury account" });
    await treasury.getByLabel("Name (English) *").fill("Main USD Safe");
    await treasury.getByLabel("Type *").selectOption({ label: "Safe" });
    await treasury.getByLabel("Currency *").selectOption("USD");
    await treasury.getByLabel("Chart of Accounts account *").selectOption({ label: "1100 · Main Cash Safe - USD" });
    await treasury.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Treasury account saved" })).toBeVisible();
    await page.getByRole("button", { name: "Add expense type" }).click();
    const type = page.getByRole("form", { name: "Expense type" });
    await type.getByLabel("Code *").fill("OFFICE");
    await type.getByLabel("Name (English) *").fill("Office supplies");
    await type.getByLabel("Expense account in the Chart of Accounts *").selectOption({ label: "5100 · Office Expense" });
    await type.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense type saved" })).toBeVisible();
    await expect(page.locator(".setup-checklist li.missing")).toHaveCount(0);
    await nav.getByRole("link", { name: "Safes" }).click();
    await expect(safeBalance(page, "Main USD Safe")).toContainText("0 USD");

    // 6. Nothing can be spent before the Safe is funded: the form stops it and the server refuses it.
    await nav.getByRole("link", { name: "Record expense" }).click();
    const expense = page.getByRole("form", { name: "Record expense" });
    await fillExpense(expense, { amount: "1000", reference: "EXP-000", purpose: "Attempt before funding" });
    await expect(expense.getByRole("alert")).toContainText("A Safe, cash box or petty cash can never go below zero");
    await expect(expense.getByRole("button", { name: "Record expense" })).toBeDisabled();
    expect(await postExpenseDirectly(page, "1000")).toEqual({ status: 422, code: "INSUFFICIENT_FUNDS" });
    await expectBusinessCounts({ journals: 0 });

    // 7. The shareholder is added with an agreed total only: no money, no journal.
    await nav.getByRole("link", { name: "Shareholders" }).click();
    await page.getByRole("button", { name: "Add shareholder" }).click();
    const add = page.getByRole("form", { name: "Add shareholder" });
    await add.getByLabel("Name").fill("Ahmad Test Shareholder");
    await add.getByLabel("What are they putting in?").selectOption({ label: "Nothing yet" });
    await add.getByLabel("Agreed total (optional)").fill("100000");
    await add.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Shareholder saved.")).toBeVisible();
    await expect(page.getByText("No capital has been recorded yet.")).toBeVisible();
    await expectBusinessCounts({ shareholders: 1, journals: 0 });

    // 8. Capital: 50,000 USD cash into the Safe posts one balanced journal.
    await page.getByRole("button", { name: "Add money" }).click();
    const money = page.getByRole("form", { name: "Add money" });
    await money.getByLabel("What are they putting in?").selectOption({ label: "Cash into a Safe" });
    await money.getByLabel("Amount").fill("50000");
    await money.getByLabel("Which Safe did it go into?").selectOption({ label: "Main USD Safe · USD" });
    await money.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Capital recorded · CAP-/)).toBeVisible();
    await expect(page.getByText("Capital put in", { exact: true }).first().locator("..")).toContainText("USD 50,000");
    await expect(page.getByText("Still to come", { exact: true }).first().locator("..")).toContainText("USD 50,000");
    expect(await journalLines()).toEqual([
      { source: "DIRECT_SHAREHOLDER_CAPITAL", account: "1100", debit: "50000", credit: "0" },
      { source: "DIRECT_SHAREHOLDER_CAPITAL", account: "3100", debit: "0", credit: "50000" }
    ]);
    await nav.getByRole("link", { name: "Safes" }).click();
    await expect(safeBalance(page, "Main USD Safe")).toContainText("50,000 USD");

    // 9. The expense: more than the Safe holds is refused; 1,000 is recorded.
    await nav.getByRole("link", { name: "Record expense" }).click();
    await fillExpense(expense, { amount: "60000", reference: "EXP-001", purpose: "Office supplies" });
    await expect(expense.getByRole("alert")).toContainText("This account holds only 50,000 USD on record");
    await expect(expense.getByRole("button", { name: "Record expense" })).toBeDisabled();
    expect(await postExpenseDirectly(page, "60000")).toEqual({ status: 422, code: "INSUFFICIENT_FUNDS" });
    await expense.getByLabel("Amount (USD) *").fill("1000");
    await expect(expense.getByRole("alert")).toHaveCount(0);
    await expense.getByRole("button", { name: "Record expense" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense recorded" }))
      .toContainText("Expense recorded: 1,000 USD from Main USD Safe.");
    await expect(expense).toContainText("Recorded in this account: 49,000 USD");
    await expectNoTechnicalTerms(page);
    expect((await journalLines()).slice(2)).toEqual([
      { source: "OPERATIONAL_EXPENSE", account: "5100", debit: "1000", credit: "0" },
      { source: "OPERATIONAL_EXPENSE", account: "1100", debit: "0", credit: "1000" }
    ]);

    // Daily transactions and the daily report take their figures from the recorded expense.
    await page.getByRole("link", { name: "See daily transactions" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Daily transactions" })).toBeVisible();
    const row = page.locator(".register-table tbody tr").filter({ hasText: "EXP-001" });
    await expect(row).toContainText("1,000 USD");
    await expect(row).toContainText("Synthetic Finance Manager");
    await expectNoTechnicalTerms(page);
    await nav.getByRole("link", { name: "Daily financial report" }).click();
    await expect(page.locator(".register-totals")).toContainText("Expenses in USD (1)");
    // The Safe opened the day at 0, took in 50,000 and paid out 1,000.
    await expect(page.locator("tr").filter({ hasText: "Main USD Safe" }).first().getByRole("cell"))
      .toHaveText(["Main USD Safe · USD", "0 USD", "49,000 USD", "49,000 USD"]);
    await expectNoTechnicalTerms(page);

    // 10. Correction: the expense is reversed with a reason; the original stays posted and linked.
    await nav.getByRole("link", { name: "Journal reversals" }).click();
    await page.locator("tr").filter({ hasText: "Expense" }).getByRole("button", { name: "Reverse" }).click();
    const reversal = page.locator(".reversal-form");
    await expect(reversal).toContainText("recorded in the audit trail as a self-correction");
    await reversal.getByLabel("Reason *").fill("First-run E2E correction test");
    await reversal.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Reversal posted.")).toBeVisible();
    await expect(page.locator("tr").filter({ hasText: "Expense" })).toContainText("Reversed: RV-");
    const lines = await journalLines();
    expect(lines.slice(4)).toEqual([
      { source: "REVERSAL", account: "5100", debit: "0", credit: "1000" },
      { source: "REVERSAL", account: "1100", debit: "1000", credit: "0" }
    ]);
    expect(await reversalLink()).toEqual({ originalStatus: "POSTED", reason: "First-run E2E correction test", mode: "DIRECT", selfReversal: true });
    await expectBusinessCounts({ journals: 3 });
    await nav.getByRole("link", { name: "Safes" }).click();
    await expect(safeBalance(page, "Main USD Safe")).toContainText("50,000 USD");

    // 11. Reports: the Trial balance balances and the Safe's account statement runs 50,000 → 49,000 → 50,000.
    await nav.getByRole("link", { name: "Trial balance" }).click();
    await expect(page.getByText("Balanced: total debits equal total credits (USD).")).toBeVisible();
    const total = page.locator("tr").filter({ hasText: "Total (USD)" });
    await expect(total).toContainText("52,000");
    await expect(total).toContainText("50,000");
    await page.getByRole("link", { name: "1100", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "1100 · Main Cash Safe - USD" })).toBeVisible();
    const statement = page.locator("table tbody tr");
    await expect(statement).toHaveCount(3);
    await expect(statement.nth(0)).toContainText("Capital received · Ahmad Test Shareholder");
    await expect(statement.nth(0).locator("td").nth(5)).toHaveText("50,000");
    await expect(statement.nth(1).locator("td").nth(5)).toHaveText("49,000");
    await expect(statement.nth(2).locator("td").nth(5)).toHaveText("50,000");
    await expect(page.getByText("Closing", { exact: true }).locator("..")).toContainText("50,000 Dr");

    // Dari is complete on the daily pages.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await page.getByRole("navigation", { name: "عملیات" }).getByRole("link", { name: "ثبت مصرف" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "ثبت مصرف" })).toBeVisible();
    await expectNoTechnicalTerms(page);
    await page.getByRole("button", { name: "Switch to English" }).click();
  });
});

function policyCard(page: Page, heading: string) {
  return page.locator(".policy-card").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

function safeBalance(page: Page, safe: string) {
  return page.locator(".safe-card").filter({ has: page.getByRole("heading", { name: safe }) }).getByLabel("Book balance");
}

async function createAccount(page: Page, account: { code: string; name: string; type: string; control?: string }): Promise<void> {
  await page.getByRole("button", { name: "New account" }).click();
  const form = page.getByRole("form", { name: "Account form" });
  await form.getByLabel("Account code").fill(account.code);
  await form.getByLabel("Account type").selectOption(account.type);
  await form.getByLabel("Account name").fill(account.name);
  if (account.control !== undefined) await form.getByLabel("Control type").selectOption(account.control);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Account created under the current approval policy.");
}

async function fillExpense(form: ReturnType<Page["getByRole"]>, values: { amount: string; reference: string; purpose: string }): Promise<void> {
  await form.getByLabel("Paid from *").selectOption({ label: "Main USD Safe · USD" });
  await form.getByLabel("Expense type *").selectOption({ label: "Office supplies" });
  await form.getByLabel("Amount (USD) *").fill(values.amount);
  await form.getByLabel("Receipt or reference number *").fill(values.reference);
  await form.getByLabel("What was it for? *").fill(values.purpose);
}

/** The same request the form would send, sent directly: the server, not only the form, refuses an overdraft. */
async function postExpenseDirectly(page: Page, amount: string): Promise<{ status: number; code: string | undefined }> {
  return page.evaluate(async (originalAmount) => {
    const businessDate = (document.querySelector("form[aria-label='Record expense'] input[type=date]") as HTMLInputElement).value;
    const options = await (await fetch(`/api/v1/finance/operations/expense-options?date=${businessDate}`)).json() as {
      data: { treasuryAccounts: { id: string }[]; expenseCategories: { id: string }[] } };
    const response = await fetch("/api/v1/finance/operations/expenses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        treasuryAccountId: options.data.treasuryAccounts[0]?.id, expenseCategoryId: options.data.expenseCategories[0]?.id,
        payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null,
        reference: "EXP-DIRECT", description: "Direct overdraft attempt", note: null, businessDate, originalAmount,
        currencyCode: "USD", exchangeRateId: null, idempotencyKey: `expense-${crypto.randomUUID()}`, correlationId: crypto.randomUUID()
      })
    });
    const body = await response.json() as { error?: { code?: string } };
    return { status: response.status, code: body.error?.code };
  }, amount);
}

async function expectNoTechnicalTerms(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const term of TECHNICAL_TERMS) expect(text, `page shows "${term}"`).not.toContain(term);
}

/** Read-only verification of the disposable preview database. Nothing is written. */
async function readOnly<Row extends pg.QueryResultRow>(sql: string): Promise<Row[]> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = (await client.query<Row>(sql)).rows;
    await client.query("ROLLBACK");
    return rows;
  } finally {
    await client.end();
  }
}

const COUNTS: Readonly<Record<string, string>> = {
  fiscal_years: "abos.fiscal_years", ledger_accounts: "abos.ledger_accounts", workflow_policies: "abos.finance_workflow_policy_versions",
  treasury_accounts: "abos.operational_treasury_accounts", shareholders: "abos.shareholder_profiles", journals: "abos.journals"
};

async function expectBusinessCounts(expected: Readonly<Record<string, number>>): Promise<void> {
  const sql = Object.keys(expected).map((key) => `SELECT '${key}' AS k, count(*)::int AS n FROM ${COUNTS[key]}`).join(" UNION ALL ");
  const rows = await readOnly<{ k: string; n: number }>(sql);
  expect(Object.fromEntries(rows.map((row) => [row.k, row.n]))).toEqual(expected);
}

async function journalLines(): Promise<{ source: string; account: string; debit: string; credit: string }[]> {
  return readOnly(
    `SELECT jl.source_type AS source, la.account_code AS account, jl.base_debit::text AS debit, jl.base_credit::text AS credit
       FROM abos.journal_lines jl JOIN abos.journals j ON j.id = jl.journal_id JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
      ORDER BY j.created_at, jl.line_number`);
}

async function reversalLink(): Promise<{ originalStatus: string; reason: string; mode: string; selfReversal: boolean }> {
  const rows = await readOnly<{ originalStatus: string; reason: string; mode: string; selfReversal: boolean }>(
    `SELECT o.status AS "originalStatus", l.reason, l.reversal_mode AS mode, l.self_reversal AS "selfReversal"
       FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id`);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of (existsSync(resolve(__dirname, "../.env.local")) ? readFileSync(resolve(__dirname, "../.env.local"), "utf8") : "").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

function seedFirstRun(): Record<string, string> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:first-run"], {
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
