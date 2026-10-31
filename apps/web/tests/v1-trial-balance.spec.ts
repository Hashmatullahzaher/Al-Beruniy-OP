import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database or financial writes. The arithmetic (ledger truth, balance proof, masking)
// is proven by the PostgreSQL suite reporting-trial-balance (0053).
const cashId = "78000000-0000-4000-8000-000000000001";
const incomeId = "78000000-0000-4000-8000-000000000002";
const afnId = "78000000-0000-4000-8000-000000000003";
const periodId = "78000000-0000-4000-8000-000000000010";
const paymentJournal = "78000000-0000-4000-8000-000000000020";
const reversalJournal = "78000000-0000-4000-8000-000000000021";
const auth = { userAccountId: "78000000-0000-4000-8000-000000000009", loginIdentifier: "ui.reports", displayName: "UI test Accountant",
  jobTitle: "Accountant", legalEntityName: "UI test company", permissions: ["finance.report.operational.read"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
const range = (mode: string) => ({ mode, from: "2026-09-01", to: "2026-09-30",
  period: mode === "PERIOD" ? { id: periodId, name: "September 2026", nameFa: "سپتمبر ۲۰۲۶" } : null, fiscalYear: null,
  periods: [{ id: periodId, name: "September 2026", nameFa: "سپتمبر ۲۰۲۶", startsOn: "2026-09-01", endsOn: "2026-09-30" }] });
const row = (accountId: string, accountCode: string, accountName: string, accountType: string, dr: string, cr: string, native: object[] = []) => ({
  accountId, accountCode, accountName, accountType, controlType: null, accountCurrency: "USD", status: "ACTIVE", parentId: null,
  openingDebit: "0", openingCredit: "0", periodDebit: dr, periodCredit: cr, endingDebit: dr, endingCredit: cr, native });
const trialBalance = (mode: string) => ({ legalEntityId: "e", baseCurrency: "USD", range: range(mode), includeZero: false, balanced: true, unbalancedJournals: 0,
  accounts: [row(cashId, "C-01", "Cash", "ASSET", "1100.00", "0"), row(afnId, "C-02", "Cash AFN", "ASSET", "100.00", "0",
    [{ currency: "AFN", openingNet: "0", periodDebit: "7000.00", periodCredit: "0", endingNet: "7000.00" }]), row(incomeId, "R-01", "Income", "REVENUE", "0", "1200.00")],
  totals: { openingDebit: "0", openingCredit: "0", periodDebit: "1200.00", periodCredit: "1200.00", endingDebit: "1200.00", endingCredit: "1200.00" } });
const statement = { legalEntityId: "e", range: range("PERIOD"),
  account: { id: cashId, code: "C-01", name: "Cash", type: "ASSET", controlType: "CASH", currency: "USD", status: "ACTIVE" },
  opening: { debit: "0", credit: "0", net: "0" }, periodDebit: "1200.00", periodCredit: "100.00", closing: { debit: "1100.00", credit: "0", net: "1100.00" },
  lines: [
    { journalId: "j1", lineNumber: 1, date: "2026-09-06", postedAt: "x", debit: "700.00", credit: "0", balance: "700.00", originalAmount: "700.00", originalCurrency: "USD",
      rate: null, restricted: false, journalReference: "DC-1", reversedBy: null, reverses: null,
      source: { type: "DIRECT_SHAREHOLDER_CAPITAL", id: null, label: { en: "Capital received", fa: "سرمایه دریافت‌شده" }, route: null, counterparty: null, detailRestricted: true } },
    { journalId: "j2", lineNumber: 1, date: "2026-09-11", postedAt: "x", debit: "0", credit: "50.00", balance: "650.00", originalAmount: "50.00", originalCurrency: "USD",
      rate: null, restricted: true, journalReference: null, reversedBy: null, reverses: null,
      source: { type: "RESTRICTED", id: null, label: { en: "Restricted movement", fa: "حرکت محدود" }, route: null, counterparty: null } },
    { journalId: paymentJournal, lineNumber: 2, date: "2026-09-12", postedAt: "x", debit: "0", credit: "100.00", balance: "550.00", originalAmount: "100.00",
      originalCurrency: "USD", rate: null, restricted: false, journalReference: "PY-1", reverses: null,
      reversedBy: { journalId: reversalJournal, reference: "RV-1", date: "2026-09-12" },
      source: { type: "PAYMENT", id: "p1", label: { en: "Payment", fa: "پرداخت" }, route: "/finance/safes", counterparty: "Synthetic supplier" } },
    { journalId: reversalJournal, lineNumber: 1, date: "2026-09-12", postedAt: "x", debit: "100.00", credit: "0", balance: "650.00", originalAmount: "100.00",
      originalCurrency: "USD", rate: null, restricted: false, journalReference: "RV-1", reversedBy: null,
      reverses: { journalId: paymentJournal, reference: "PY-1", date: "2026-09-12" },
      source: { type: "REVERSAL", id: "r1", label: { en: "Reversal", fa: "برگشت" }, route: "/finance/reversals", counterparty: null } }] };
const journal = { journalId: paymentJournal, reference: "PY-1", restricted: false, date: "2026-09-12", postedAt: "x", baseCurrency: "USD", postedBy: "UI test Cashier",
  period: { id: periodId, name: "September 2026", nameFa: null },
  source: { type: "PAYMENT", id: "p1", label: { en: "Payment", fa: "پرداخت" }, route: "/finance/safes", counterparty: "Synthetic supplier" },
  lines: [{ lineNumber: 1, accountId: "x", accountCode: "L-1", accountName: "Payable", accountType: "LIABILITY", debit: "100.00", credit: "0", originalAmount: "100.00", originalCurrency: "USD" },
    { lineNumber: 2, accountId: cashId, accountCode: "C-01", accountName: "Cash", accountType: "ASSET", debit: "0", credit: "100.00", originalAmount: "100.00", originalCurrency: "USD" }],
  fx: null, reversedBy: { journalId: reversalJournal, reference: "RV-1", date: "2026-09-12", reason: "Duplicate supplier payment" }, reverses: null };

async function mock(page: Page) {
  const asked: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth } }));
  await page.route("**/api/v1/finance/trial-balance*", async (route) => {
    const query = new URL(route.request().url()).searchParams; asked.push(query.toString());
    await route.fulfill({ json: { ok: true, data: trialBalance(query.get("periodId") ? "PERIOD" : query.get("asOf") ? "AS_OF" : "RANGE") } });
  });
  await page.route("**/api/v1/finance/account-statement*", async (route) => { asked.push(new URL(route.request().url()).search); await route.fulfill({ json: { ok: true, data: statement } }); });
  await page.route(`**/api/v1/finance/journals/${paymentJournal}`, (route) => route.fulfill({ json: { ok: true, data: journal } }));
  await page.route("**/api/v1/finance/general-ledger*", (route) => route.fulfill({ json: { ok: true, data: { syntheticOnly: false, legalEntityId: "e", from: "2026-01-01",
    to: "2026-12-31", accountId: null, accounts: [], currencyTotals: [], lines: [], totals: [], returnedLineCount: 0, hasMore: false, nextCursor: null, pageLimit: 100,
    order: "", basis: "POSTED_ACTIVITY_IN_RANGE", isBalance: false, openingBalancesIncluded: false } } }));
  await page.route("**/api/v1/finance/accounts*", (route) => route.fulfill({ json: { ok: true, data: { accounts: [] } } }));
  return asked;
}

test("@smoke the trial balance shows debit and credit columns, the balance proof, native AFN detail and a statement link", async ({ page }) => {
  const asked = await mock(page);
  await page.goto("/finance/trial-balance");
  const report = page.getByRole("region", { name: "Trial balance" });
  await expect(report.getByRole("status")).toContainText("Balanced: total debits equal total credits (USD).");
  await expect(report.getByRole("row", { name: /C-01/ })).toContainText("1,100.00");
  await expect(report.getByRole("row", { name: /Native AFN/ })).toContainText("AFN 7,000.00");
  await expect(report.locator("tfoot")).toContainText("1,200.00");
  await page.getByLabel("Report for").selectOption("period");
  await page.getByRole("combobox", { name: /^Accounting month/ }).selectOption(periodId);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(report.getByRole("heading", { level: 2 })).toContainText("September 2026");
  expect(asked).toContain(`periodId=${periodId}`);
  await expect(report.getByRole("link", { name: "C-01" })).toHaveAttribute("href", `/finance/account-statement?accountId=${cashId}&periodId=${periodId}`);
});

test("the account statement shows the running balance, masks a restricted movement, and links reversals and journals", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/account-statement?accountId=${cashId}&periodId=${periodId}`);
  const report = page.getByRole("region", { name: "Account statement" });
  await expect(report).toContainText("1,100.00 Dr");
  await expect(report.getByRole("row").filter({ hasText: "Restricted movement" })).toContainText("50.00");
  await expect(report.getByRole("row").filter({ hasText: "Capital received" })).toContainText("(details restricted)");
  await expect(report.getByRole("row").filter({ hasText: "PY-1" }).first()).toContainText("reversed");
  await expect(report.getByRole("link", { name: "PY-1" })).toHaveAttribute("href", `/finance/general-ledger?journalId=${paymentJournal}`);
});

test("the General Ledger opens a journal from ?journalId= with its lines, source and reversal", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/general-ledger?journalId=${paymentJournal}`);
  const panel = page.getByRole("region", { name: "Journal" });
  await expect(panel.getByRole("heading", { name: "PY-1" })).toBeVisible();
  await expect(panel).toContainText("Synthetic supplier");
  await expect(panel).toContainText("Duplicate supplier payment");
  await expect(panel.getByRole("link", { name: "RV-1" })).toHaveAttribute("href", `/finance/general-ledger?journalId=${reversalJournal}`);
});

test("Dari labels and RTL remain usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/trial-balance");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("region", { name: "بیلانس آزمایشی" }).getByRole("status")).toContainText("متوازن");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
