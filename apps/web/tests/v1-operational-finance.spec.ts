import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { seedAccounts } from "./support/seed-credentials";

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

  test("a single Finance operator sets up a new company, funds the Safe, spends, corrects and reports", async ({ page, browser }) => {
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
    // The status shows what happens today, never an assumed OFF; saving needs an explicit choice.
    await expect(chartCard.locator(".treasury-chip")).toHaveText("Not configured — approval is currently required by default");
    await expect(capitalCard.locator(".treasury-chip")).toHaveText("Not configured — capital cannot be recorded until this setting is saved");
    for (const [card, reason] of [[chartCard, "Single operator: no second reviewer"], [capitalCard, "Single operator records capital directly"]] as const) {
      await expect(card).not.toContainText("Approval required: OFF");
      await card.getByLabel("Reason for this change").fill(reason);
      await expect(card.getByRole("button", { name: "Save new version" })).toBeDisabled();
      await card.getByRole("radio", { name: /Approval OFF/ }).check();
      await card.getByRole("button", { name: "Save new version" }).click();
      await expect(card.locator(".treasury-chip")).toHaveText("Approval OFF");
      await expect(card.locator("footer")).toContainText("Version 1");
    }

    // 4. The waiting account is released under the explicit OFF policy; later accounts need no review.
    // The Accounts tab says why 1100 still waits and leads to the release; nothing is released automatically.
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await expect(tree.locator("button", { hasText: "1100" })).toContainText("Awaiting review");
    const releaseNote = page.locator(".coa-release-note");
    await expect(releaseNote).toContainText("Chart of Accounts approval is now OFF, but 1 account saved while approval was required is still “Awaiting review”");
    await releaseNote.getByRole("button", { name: "Open the accounts to release" }).click();
    const waiting = page.getByRole("article", { name: "Review 1100" });
    await expect(waiting).toContainText("Approval is currently OFF");
    await expect(waiting).not.toContainText("another reviewer must review it");
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
    await expect(page.locator("tr").filter({ hasText: "Reversed: RV-" }).first()).toContainText(/Expense · \S+ — /);
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
    // 0055: the expense names its receipt and type; the journal reference stays; capital opens the shareholder's record.
    await expect(statement.nth(1)).toContainText("Expense · EXP-001 — Office supplies");
    await expect(statement.nth(1)).toContainText("OPX-");
    await statement.nth(0).getByRole("link", { name: "Capital received" }).click();
    await expect(page).toHaveURL(/\/shareholders\?shareholder=[0-9a-f-]{36}$/);
    await expect(page.getByRole("button", { name: /Ahmad Test Shareholder/ })).toHaveAttribute("aria-pressed", "true");
    await nav.getByRole("link", { name: "General Ledger" }).click();
    const ledgerExpense = page.locator("li").filter({ hasText: "OPX-" }).filter({ hasText: "5100 · Office Expense" });
    await expect(ledgerExpense).toContainText("Expense · EXP-001 — Office supplies");
    await expect(ledgerExpense).not.toContainText("OPERATIONAL_EXPENSE");

    // 12. Every financial report, read through the screens from what was really posted, and each drill-down followed.
    const usd = (amount: string) => new RegExp(`${amount}(\\.00)? USD`);
    await nav.getByRole("link", { name: "Safe / Saraf statement" }).click();
    await page.getByLabel("Safe or Saraf").selectOption({ label: "Main USD Safe · USD" });
    const safeReport = page.getByRole("region", { name: "Statement" });
    await expect(safeReport.getByRole("status")).toContainText("Agrees with the General Ledger.");
    await expect(safeReport.locator("tbody tr")).toHaveCount(3);
    await expect(safeReport.locator("tbody tr").nth(0)).toContainText("Capital received · Ahmad Test Shareholder");
    await expect(safeReport.locator("tbody tr").nth(1)).toContainText("Expense · EXP-001 — Office supplies");
    await expect(safeReport.locator("tbody tr").nth(1)).toContainText("reversed");
    await expect(safeReport.locator("tbody tr").nth(2)).toContainText("Reversal");
    await expect(safeReport.locator("tbody tr").nth(2).getByRole("cell").nth(5)).toContainText(usd("50,000"));
    await safeReport.getByRole("link", { name: /Ledger account/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "1100 · Main Cash Safe - USD" })).toBeVisible();

    await nav.getByRole("link", { name: "Financial summary" }).click();
    const treasuryReport = page.getByRole("region", { name: "Treasury", exact: true });
    await expect(treasuryReport.getByRole("row", { name: /Shareholder capital received/ })).toContainText(usd("50,000"));
    await expect(treasuryReport.getByRole("row", { name: /Expenses paid/ })).toContainText(/\D0(\.00)? USD/);
    await expect(treasuryReport.getByRole("row", { name: /Closing Treasury position/ })).toContainText(usd("50,000"));
    await expect(treasuryReport.getByRole("status")).toContainText("agrees with the Treasury accounts and the General Ledger");
    await page.getByRole("region", { name: "Treasury accounts" }).getByRole("link", { name: "Main USD Safe" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Main USD Safe" })).toBeVisible();

    await nav.getByRole("link", { name: "Shareholder statement" }).click();
    await page.getByRole("region", { name: "Company totals" }).getByRole("button", { name: "Ahmad Test Shareholder" }).click();
    const equity = page.getByRole("region", { name: "Capital (equity)" });
    await expect(equity.getByRole("definition").filter({ hasText: usd("50,000") }).first()).toBeVisible();
    await expect(equity.getByRole("link", { name: "Main USD Safe" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Loans (debt)" }).getByText("No loans recorded.")).toBeVisible();

    await nav.getByRole("link", { name: "Income statement" }).click();
    const incomeReport = page.getByRole("region", { name: "Income statement" });
    await expect(incomeReport.getByRole("row", { name: /5100 Office Expense/ })).toBeVisible();
    await expect(incomeReport.getByRole("row", { name: /Net profit/ })).toContainText(/\D0(\.00)? USD/);

    await nav.getByRole("link", { name: "Balance sheet" }).click();
    const sheetReport = page.getByRole("region", { name: "Balance sheet" });
    await expect(sheetReport.getByRole("status")).toContainText("(balanced)");
    await expect(sheetReport.getByRole("row", { name: /Total assets/ })).toContainText(usd("50,000"));
    await expect(sheetReport.getByRole("row", { name: /3100 Shareholder Capital/ })).toContainText(usd("50,000"));
    await sheetReport.getByRole("link", { name: /1100 Main Cash Safe - USD/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "1100 · Main Cash Safe - USD" })).toBeVisible();
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("region", { name: "Journal", exact: true })).toBeVisible();

    // Dari is complete on the daily pages.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await page.getByRole("navigation", { name: "عملیات" }).getByRole("link", { name: "ثبت مصرف" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "ثبت مصرف" })).toBeVisible();
    await expectNoTechnicalTerms(page);
    await page.getByRole("button", { name: "Switch to English" }).click();

    // Source confidentiality on the reversal list, against the real database: what a person sees depends on what they hold.
    const reversals = "/api/v1/finance/journal-reversals";
    const fullListText = (await browserGet(page, reversals)).text;
    expect(fullListText).toContain("EXP-001");
    expectNoSourceMetadata(fullListText);
    await signOut(page);
    await signIn(page, "super.admin", accounts["super.admin"]);

    // May ask for a reversal, cannot read Finance reports: the list still works, with no source at all.
    const requester = await employeeHolding(page, browser, "reversal.requester", ["Request journal reversals"]);
    const noReports = await browserGet(requester, reversals);
    expect(noReports.status).toBe(200);
    const noReportsText = noReports.text;
    expect(noReportsText).not.toContain("EXP-001");
    expect(noReportsText, "a capital reference embeds the receipt id").not.toContain("CAP-");
    expect(noReportsText).not.toContain("Office supplies");
    expectNoSourceMetadata(noReportsText);
    const noReportsView = JSON.parse(noReportsText) as { data: { journals: { source: unknown }[] } };
    expect(noReportsView.data.journals.length).toBeGreaterThan(0);
    expect(noReportsView.data.journals.every((journal) => journal.source === null)).toBe(true);
    await requester.goto("/finance/reversals");
    const requesterRow = requester.locator("tr").filter({ hasText: "1,000 USD" }).first();
    await expect(requesterRow).toContainText("Expense");
    await expect(requesterRow).toContainText("JRN-");
    await expect(requesterRow).not.toContainText("EXP-001");
    await requester.context().close();

    // Reads Finance reports but not expenses: the generic type shows, the expense's detail does not.
    const reader = await employeeHolding(page, browser, "reversal.reader", ["Request journal reversals", "View Finance reports and journals"]);
    const withheld = (await browserGet(reader, reversals)).text;
    expect(withheld).not.toContain("EXP-001");
    expect(withheld, "a capital reference embeds the receipt id").not.toContain("CAP-");
    expect(withheld).not.toContain("Office supplies");
    expectNoSourceMetadata(withheld);
    const withheldView = JSON.parse(withheld) as { data: { journals: { source: { id: unknown; route: unknown; counterparty: unknown; detail: unknown } | null }[] } };
    expect(withheldView.data.journals.length).toBeGreaterThan(0);
    for (const { source } of withheldView.data.journals) expect(source).toMatchObject({ id: null, route: null, counterparty: null, detail: null });
    await reader.goto("/finance/reversals");
    const readerRow = reader.locator("tr").filter({ hasText: "1,000 USD" }).first();
    await expect(readerRow).toContainText("Expense");
    await expect(readerRow).not.toContainText("EXP-001");
    await reader.context().close();

    // 13. Loans: one person is both shareholder and lender, and the two positions never merge.
    const lawReader = await employeeHolding(page, browser, "loan.report.reader", ["View Finance reports and journals"]);
    await signOut(page);
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await createAccount(page, { code: "2510", name: "Shareholder Loans", type: "LIABILITY", control: "SHAREHOLDER_LOAN" });
    await createAccount(page, { code: "2520", name: "Loans Payable", type: "LIABILITY", control: "LOAN_PAYABLE" });
    await nav.getByRole("link", { name: "Add money" }).click();
    await page.getByRole("button", { name: /Shareholder loan/ }).click();
    let loanForm = page.getByRole("form", { name: "Record loan" });
    await loanForm.getByLabel("Which shareholder?").selectOption({ label: "Ahmad Test Shareholder" });
    await loanForm.getByLabel("Which Safe did it go into?").selectOption({ label: "Main USD Safe · USD" });
    await loanForm.getByLabel(/^Amount/).fill("20000");
    await loanForm.getByRole("button", { name: "Record loan" }).click();
    await expect(page.getByText("Loan recorded.")).toBeVisible();
    await page.goto("/finance/add-money");
    await page.getByRole("button", { name: /Other loan/ }).click();
    loanForm = page.getByRole("form", { name: "Record loan" });
    await loanForm.getByLabel("Who lent the money?").selectOption({ label: "A company" });
    await loanForm.getByRole("textbox", { name: "Name" }).fill("Outside Lender Ltd");
    await loanForm.getByLabel("Which Safe did it go into?").selectOption({ label: "Main USD Safe · USD" });
    await loanForm.getByLabel(/^Amount/).fill("30000");
    await loanForm.getByLabel("Reference (optional)").fill("LOAN-PRIVATE-REF");
    await loanForm.getByRole("button", { name: "Record loan" }).click();
    await expect(page.getByText("Loan recorded.")).toBeVisible();
    await page.getByRole("link", { name: "View the loan" }).click();
    await page.getByRole("button", { name: "Repay" }).click();
    const repayForm = page.getByRole("form", { name: "Repay loan" });
    await repayForm.getByLabel("From which Safe?").selectOption({ label: "Main USD Safe" });
    await repayForm.getByLabel("Amount (USD)").fill("40000");
    await repayForm.getByRole("button", { name: "Record repayment" }).click();
    await expect(repayForm.getByRole("alert")).toContainText("more than is outstanding");
    await repayForm.getByLabel("Amount (USD)").fill("5000");
    await repayForm.getByRole("button", { name: "Record repayment" }).click();
    await expect(page.getByText("Repayment recorded.")).toBeVisible();
    const loanReport = page.getByRole("region", { name: "Loan statement" });
    await expect(loanReport.getByRole("status")).toContainText("Agrees with the liability account.");
    await expect(loanReport.getByRole("row", { name: /^Outstanding/ })).toContainText(usd("25,000"));
    await nav.getByRole("link", { name: "Safes" }).click();
    await expect(safeBalance(page, "Main USD Safe")).toContainText("95,000 USD");

    // The standard reversal: the repayment goes back, and the amount owed follows from the journals.
    await nav.getByRole("link", { name: "Journal reversals" }).click();
    await page.locator("tr").filter({ hasText: "Loan repaid" }).getByRole("button", { name: "Reverse" }).click();
    await page.locator(".reversal-form").getByLabel("Reason *").fill("Repayment entered in error");
    await page.locator(".reversal-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Reversal posted.")).toBeVisible();
    await nav.getByRole("link", { name: "Loans" }).click();
    await expect(page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /Outside Lender Ltd/ })).toContainText(usd("30,000"));

    // Capital and loans on one person's screen, each its own figure.
    await nav.getByRole("link", { name: "Shareholders" }).click();
    await page.getByRole("button", { name: /Ahmad Test Shareholder/ }).click();
    const holderCard = page.getByRole("article", { name: "Ahmad Test Shareholder" });
    await expect(holderCard.getByRole("region", { name: "USD capital" }).getByText("Capital put in", { exact: true }).locator("..")).toContainText("USD 50,000");
    await expect(holderCard.getByRole("region", { name: "Loans" }).getByText("Outstanding loan").locator("..")).toContainText("USD 20,000");
    await expect(holderCard).not.toContainText("70,000");

    // The reports: liabilities rise and no income appears.
    await nav.getByRole("link", { name: "Balance sheet" }).click();
    const loanSheet = page.getByRole("region", { name: "Balance sheet" });
    await expect(loanSheet.getByRole("status")).toContainText("(balanced)");
    await expect(loanSheet.getByRole("row", { name: /^Total liabilities[^a]*$/ })).toContainText(usd("50,000"));
    await expect(loanSheet.getByRole("row", { name: /Total assets/ })).toContainText(usd("100,000"));
    await nav.getByRole("link", { name: "Income statement" }).click();
    await expect(page.getByRole("region", { name: "Income statement" }).getByRole("row", { name: /Net profit/ }).getByRole("cell")).toHaveText(/^0(\.00)? USD$/);

    // A report-only reader, raw responses: the totals and nothing about the lender.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul" }).format(new Date());
    for (const path of [`/api/v1/finance/trial-balance?asOf=${today}`, `/api/v1/finance/balance-sheet?asOf=${today}`, `/api/v1/finance/general-ledger?from=2026-01-01&to=${today}`, `/api/v1/finance/shareholder-statement?asOf=${today}`]) {
      const answer = (await browserGet(lawReader, path)).text;
      for (const word of ["Outside Lender Ltd", "Ahmad Test Shareholder", "LOAN-PRIVATE-REF", "LN-2", "LR-2", "RV-2", "/finance/loans", "Repayment entered in error"]) expect(answer, `${path} must not carry ${word}`).not.toContain(word);
    }
    expect((await browserGet(lawReader, `/api/v1/finance/balance-sheet?asOf=${today}`)).text).toContain("50000");
    await lawReader.context().close();
  });
});

test.describe("V1 Getting started from a new company", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("Getting started takes a new company from first sign-in to a posted, balanced capital receipt; daily work then spends, corrects and reports", async ({ page }) => {
    test.setTimeout(420_000);
    const accounts = seedFirstRun();
    await expectBusinessCounts({ fiscal_years: 0, ledger_accounts: 0, workflow_policies: 0, treasury_accounts: 0, shareholders: 0, journals: 0 });

    // The administrator is told what Finance access needs and is offered the role template; nothing is granted implicitly.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Getting started" }).click();
    await page.getByRole("button", { name: /^2\. Finance access/ }).click();
    await expect(page.getByText("The System Administrator is not a Finance user automatically")).toBeVisible();
    await expect(page.getByRole("link", { name: "1. Create the Finance Manager role" })).toHaveAttribute("href", "/admin/roles?template=finance-manager");
    await signOut(page);

    // The Finance operator: first sign-in to first capital receipt, through Getting started only. Every user action is counted.
    let actions = 0;
    const act = async (step: Promise<void>) => { actions += 1; await step; };
    const started = Date.now();
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    await act(page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Getting started" }).click());
    const progress = page.getByRole("progressbar");
    await expect(page.getByText("1 of 8 steps done")).toBeVisible();

    // 1. How the company works: Simple, with the exact settings shown before saving.
    await act(page.getByRole("radio", { name: /Simple \/ Single Operator/ }).check());
    const plan = page.locator(".gs-plan");
    for (const line of ["Chart of Accounts: approval OFF", "Shareholder capital receipt: approval OFF", "Expense: approval OFF", "Journal reversal: approval OFF"]) {
      await expect(plan).toContainText(line);
    }
    await act(page.getByRole("button", { name: "Use Simple / Single Operator" }).click());
    await expect(page.getByText("2 of 8 steps done")).toBeVisible();

    // 2. Financial year: the current year is suggested (never next year) and becomes active at once.
    const year = new Date().getFullYear();
    await expect(page.getByLabel("Year", { exact: true })).toHaveValue(String(year));
    await act(page.getByRole("button", { name: "Create the financial year" }).click());
    await expect(page.getByText("3 of 8 steps done")).toBeVisible();

    // 3. Chart of Accounts: the optional starter chart, offered only because there is no account yet.
    await act(page.getByRole("button", { name: "Create the starter accounts" }).click());
    await expect(page.getByText("4 of 8 steps done")).toBeVisible();

    // 4. Safe and expense type, prefilled from the ready accounts.
    await expect(page.getByLabel("Name", { exact: true }).first()).toHaveValue("Main USD Safe");
    await act(page.getByRole("button", { name: "Create the Safe" }).click());
    await expect(page.getByText("Safe created with a balance of zero.")).toBeVisible();
    await act(page.getByRole("button", { name: "Save the expense type" }).click());
    await expect(page.getByText("5 of 8 steps done")).toBeVisible();

    // 5-6. The first money: shareholder capital, confirmed before anything is posted.
    await expect(page.getByText("Opening balance", { exact: true })).toBeVisible();
    await act(page.getByRole("button", { name: "Record shareholder capital" }).click());
    await act(page.getByLabel("Shareholder name").fill("Ahmad Test Shareholder"));
    await act(page.getByLabel("Agreed capital (optional)").fill("100000"));
    await act(page.getByLabel("Amount received now (USD)").fill("50000"));
    await act(page.getByRole("button", { name: "Review" }).click());
    await expect(page.getByText("Record 50,000 USD of shareholder capital from Ahmad Test Shareholder into Main USD Safe")).toBeVisible();
    await expectBusinessCounts({ journals: 0 });
    await act(page.getByRole("button", { name: "Confirm and record" }).click());
    await expect(page.getByText("Your first transaction is posted and balanced.")).toBeVisible();
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: "first-run", description: `first sign-in to posted capital: ${Math.round(elapsed / 1000)} s, ${actions} user actions` });
    console.log(`[first-run] first sign-in to posted capital: ${(elapsed / 1000).toFixed(1)} s, ${actions} user actions`);
    const facts = page.locator(".gs-facts");
    await expect(facts).toContainText("Main USD Safe: 50,000 USD");
    await expect(facts).toContainText("50,000 USD");
    await expect(facts).toContainText(/CAP-\d{8}-/);
    await expect(facts).toContainText("Balanced: debits equal credits");
    await expect(page.getByText("8 of 8 steps done")).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", "8");

    // The accounting result, read from the database: four audited policy versions, one balanced capital journal.
    const reasons = await readOnly<{ workflow: string; required: boolean }>(
      `SELECT workflow_type AS workflow, approval_required AS required FROM abos.finance_workflow_policy_versions
        WHERE change_reason = 'Configured by Getting Started — Simple / Single Operator' ORDER BY 1`);
    expect(reasons).toEqual([{ workflow: "CHART_OF_ACCOUNTS", required: false }, { workflow: "EXPENSE", required: false },
      { workflow: "JOURNAL_REVERSAL", required: false }, { workflow: "SHAREHOLDER_CAPITAL_RECEIPT", required: false }]);
    expect(await journalLines()).toEqual([
      { source: "DIRECT_SHAREHOLDER_CAPITAL", account: "1100", debit: "50000", credit: "0" },
      { source: "DIRECT_SHAREHOLDER_CAPITAL", account: "3100", debit: "0", credit: "50000" }
    ]);
    await expectBusinessCounts({ fiscal_years: 1, ledger_accounts: 4, workflow_policies: 4, treasury_accounts: 1, shareholders: 1, journals: 1 });

    // Ready: every check, and the daily actions.
    await page.getByRole("button", { name: /^8\. Ready/ }).click();
    await expect(page.getByText("Setup is complete. Your company is ready for daily work.")).toBeVisible();
    for (const check of ["Financial year", "Chart of Accounts", "Safe", "Finance permissions", "Posting policy", "First transaction", "General Ledger balanced"]) {
      await expect(page.locator(".gs-checklist li.ready").filter({ hasText: check }).first()).toBeVisible();
    }

    // Daily work takes over: an overdraft is refused, an expense is recorded and reversed, the reports agree.
    await page.getByRole("link", { name: "Record expense" }).first().click();
    const expense = page.getByRole("form", { name: "Record expense" });
    await fillExpense(expense, { amount: "60000", reference: "EXP-001", purpose: "Office supplies" });
    await expect(expense.getByRole("button", { name: "Record expense" })).toBeDisabled();
    expect(await postExpenseDirectly(page, "60000")).toEqual({ status: 422, code: "INSUFFICIENT_FUNDS" });
    await expense.getByLabel("Amount (USD) *").fill("1000");
    await expense.getByRole("button", { name: "Record expense" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expense recorded" })).toContainText("Expense recorded: 1,000 USD from Main USD Safe.");
    const nav = page.getByRole("navigation", { name: "Operations" });
    await nav.getByRole("link", { name: "Journal reversals" }).click();
    await page.locator("tr").filter({ hasText: "Expense" }).getByRole("button", { name: "Reverse" }).click();
    await page.locator(".reversal-form").getByLabel("Reason *").fill("Getting started E2E correction");
    await page.locator(".reversal-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Reversal posted.")).toBeVisible();
    expect((await journalLines()).map((line) => [line.source, line.account, line.debit, line.credit])).toEqual([
      ["DIRECT_SHAREHOLDER_CAPITAL", "1100", "50000", "0"], ["DIRECT_SHAREHOLDER_CAPITAL", "3100", "0", "50000"],
      ["OPERATIONAL_EXPENSE", "5100", "1000", "0"], ["OPERATIONAL_EXPENSE", "1100", "0", "1000"],
      ["REVERSAL", "5100", "0", "1000"], ["REVERSAL", "1100", "1000", "0"]]);
    await nav.getByRole("link", { name: "Trial balance" }).click();
    await expect(page.getByText("Balanced: total debits equal total credits (USD).")).toBeVisible();
    await page.getByRole("link", { name: "1100", exact: true }).click();
    const statement = page.locator("table tbody tr");
    await expect(statement).toHaveCount(3);
    await expect(statement.nth(2).locator("td").nth(5)).toHaveText("50,000");
    await nav.getByRole("link", { name: "Safes" }).click();
    await expect(safeBalance(page, "Main USD Safe")).toContainText("50,000 USD");
  });

  test("Getting started progress is only real state: work outside /setup counts, leaving keeps it, and nothing posts without confirmation", async ({ page }) => {
    test.setTimeout(420_000);
    const accounts = seedFirstRun();
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    const nav = page.getByRole("navigation", { name: "Operations" });
    const openSetup = async (done: string) => { await nav.getByRole("link", { name: "Getting started" }).click(); await expect(page.getByText(`${done} of 8 steps done`)).toBeVisible(); };
    await openSetup("1");
    await expect(page.getByRole("button", { name: /^3\. Financial year — To do/ })).toBeVisible();

    // The financial year is created on the ordinary calendar page: the step completes without touching Getting started.
    await nav.getByRole("link", { name: "Financial calendar" }).click();
    const settings = page.getByRole("form", { name: "Financial calendar settings" });
    await settings.locator("label", { hasText: "Gregorian" }).first().locator("input[type=radio]").check();
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("settings saved");
    const generator = page.getByRole("form", { name: "Generate fiscal year" });
    await expect(generator.getByLabel("Starting Gregorian year")).toHaveValue(String(new Date().getFullYear()));
    await generator.getByRole("button", { name: "Generate fiscal year" }).click();
    await expect(page.locator(".calendar-year").first().locator("tbody tr")).toHaveCount(12);
    await openSetup("2");
    await expect(page.getByRole("button", { name: /^3\. Financial year — Done/ })).toBeVisible();

    // One policy saved outside Getting started: the mode is mixed, and Simple then saves only the three still needed.
    await nav.getByRole("link", { name: "Workflow approvals" }).click();
    const chart = policyCard(page, "Chart of Accounts");
    await chart.getByRole("radio", { name: /Approval OFF/ }).check();
    await chart.getByLabel("Reason for this change").fill("Saved outside Getting started");
    await chart.getByRole("button", { name: "Save new version" }).click();
    await expect(chart.locator(".treasury-chip")).toHaveText("Approval OFF");
    await openSetup("2");
    await expect(page.getByText("Some approval settings are already saved.")).toBeVisible();
    await page.getByRole("radio", { name: /Simple \/ Single Operator/ }).check();
    await expect(page.locator(".gs-plan li")).toHaveCount(3);
    await page.getByRole("button", { name: "Use Simple / Single Operator" }).click();
    await expect(page.getByText("3 of 8 steps done")).toBeVisible();

    // Leaving and returning, and a full reload, keep the same progress: it is read, not remembered.
    await nav.getByRole("link", { name: "My dashboard" }).click();
    await openSetup("3");
    await page.reload();
    await expect(page.getByText("3 of 8 steps done")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Chart of Accounts" })).toBeVisible();

    // Accounts, Safe and expense type on the ordinary pages also complete their steps.
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await createAccount(page, { code: "1100", name: "Main Cash Safe - USD", type: "ASSET", control: "CASH" });
    await createAccount(page, { code: "3100", name: "Shareholder Capital", type: "EQUITY", control: "SHAREHOLDER_CAPITAL" });
    await createAccount(page, { code: "5100", name: "Office Expense", type: "EXPENSE" });
    await openSetup("4");
    await nav.getByRole("link", { name: "Finance setup" }).click();
    await page.getByRole("button", { name: "Add account" }).click();
    const treasury = page.getByRole("form", { name: "Treasury account" });
    await treasury.getByLabel("Name (English) *").fill("Main USD Safe");
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
    await openSetup("5");

    // Reviewing capital and walking away records nothing: no journal, no shareholder.
    await page.getByRole("button", { name: /^7\. First transaction/ }).click();
    await page.getByLabel("Shareholder name").fill("Unconfirmed Shareholder");
    await page.getByLabel("Amount received now (USD)").fill("50000");
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("button", { name: "Confirm and record" })).toBeVisible();
    await nav.getByRole("link", { name: "My dashboard" }).click();
    await expectBusinessCounts({ shareholders: 0, journals: 0 });
    await openSetup("5");

    // Capital recorded on the Shareholders page, not in Getting started: the last steps complete from the books.
    await nav.getByRole("link", { name: "Shareholders" }).click();
    await page.getByRole("button", { name: "Add shareholder" }).click();
    const add = page.getByRole("form", { name: "Add shareholder" });
    await add.getByLabel("Name").fill("Ahmad Test Shareholder");
    await add.getByLabel("Amount").fill("50000");
    await add.getByLabel("Which Safe did it go into?").selectOption({ label: "Main USD Safe · USD" });
    await add.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Capital recorded|saved/).first()).toBeVisible();
    await openSetup("8");
    await expectBusinessCounts({ shareholders: 1, journals: 1 });

    // No wizard-only state exists anywhere: no table holds it, and the schema is the deployed one.
    const stateTables = await readOnly<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'abos' AND (table_name ILIKE '%wizard%' OR table_name ILIKE '%getting_started%' OR table_name ILIKE '%setup_progress%' OR table_name ILIKE '%onboarding%')`);
    expect(stateTables).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /wizard|setup|getting/i.test(key)))).toEqual([]);
  });
});

/** A request from the signed-in page, as the app makes it. Under next start the session cookie is Secure, which Playwright's own request client will not send over http. */
async function browserGet(page: Page, url: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (path) => { const response = await fetch(path); return { status: response.status, text: await response.text() }; }, url);
}

/** The reversal list names no shareholder, and carries no deep link or source record, for anyone. */
function expectNoSourceMetadata(body: string): void {
  expect(body).not.toContain("Ahmad Test Shareholder");
  expect(body).not.toContain("/shareholders");
  expect(body).not.toContain("/finance/transactions");
  expect(body).not.toMatch(/"(id|route|counterparty)":"[^"]*"[^{}]*"label"/);
}

/** A new employee holding only the named permissions, signed in on their own browser context. */
async function employeeHolding(admin: Page, browser: Browser, login: string, permissions: readonly string[]): Promise<Page> {
  await admin.goto("/admin/roles");
  await admin.getByRole("button", { name: "New role" }).click();
  const editor = admin.getByRole("form", { name: "Role editor" });
  await editor.getByLabel("Role name").fill(`Role of ${login}`);
  await editor.getByLabel("Description").fill("Synthetic confidentiality check.");
  for (const permission of permissions) await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
  await editor.getByRole("button", { name: "Create role" }).click();
  await expect(admin.locator(".treasury-message.success")).toContainText("Role created");
  await admin.goto("/admin/users");
  await admin.getByRole("button", { name: "New employee" }).click();
  const create = admin.getByRole("form", { name: "New employee" });
  await create.getByLabel("Username").fill(login);
  await create.getByLabel("Full name").fill(`Synthetic ${login}`);
  await create.getByLabel("Job title").fill("Synthetic");
  await create.locator(".admin-role-picker label", { hasText: `Role of ${login}` }).locator("input").check();
  await create.getByRole("button", { name: "Create account" }).click();
  const temporaryPassword = (await admin.locator(".admin-secret-value").textContent())?.trim() ?? "";
  const person = await (await browser.newContext()).newPage();
  await person.goto("/login");
  await person.getByLabel("Username").fill(login);
  await person.getByLabel("Password", { exact: true }).fill(temporaryPassword);
  await person.getByRole("button", { name: "Sign in" }).click();
  await person.getByLabel("New password", { exact: true }).fill("Synthetic confidentiality check passphrase 2026");
  await person.getByLabel("Repeat the new password").fill("Synthetic confidentiality check passphrase 2026");
  await person.getByRole("button", { name: "Save password and continue" }).click();
  await expect(person).toHaveURL(/\/dashboard/);
  return person;
}

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
  return seedAccounts("preview:first-run", environment);
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
