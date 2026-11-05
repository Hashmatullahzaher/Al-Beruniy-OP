import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The figures and proofs are in the PostgreSQL suite
// report-reconciliation (0059).
const revenue = "7c000000-0000-4000-8000-000000000001";
const expense = "7c000000-0000-4000-8000-000000000002";
const cash = "7c000000-0000-4000-8000-000000000003";
const saraf = "7c000000-0000-4000-8000-000000000004";
const obe = "7c000000-0000-4000-8000-000000000005";
const capital = "7c000000-0000-4000-8000-000000000006";
const loan = "7c000000-0000-4000-8000-000000000007";
const yearId = "7c000000-0000-4000-8000-000000000008";
const auth = (permissions: string[]) => ({ userAccountId: "7c000000-0000-4000-8000-000000000009", loginIdentifier: "ui.statements", displayName: "UI test Accountant",
  jobTitle: "Accountant", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const year = { id: yearId, calendarKind: "GREGORIAN", label: "FY 2026", labelFa: "سال مالی ۲۰۲۶", startsOn: "2026-01-01", endsOn: "2026-12-31", closed: false };
const range = (mode: string) => ({ mode, from: "2026-09-01", to: "2026-09-30", period: null, periods: [], fiscalYear: year, fiscalYears: [year] });
const row = (accountId: string, code: string, name: string, cls: string, amount: string, extra: object = {}) => ({ accountId, code, name, class: cls, status: "ACTIVE", parent: null, amount, bookAmount: amount, reclassified: false, ...extra });
const income = { legalEntityId: "e", baseCurrency: "USD", range: range("RANGE"), income: [row(revenue, "4100", "Rent", "REVENUE", "1200.00")],
  expenses: [row(expense, "5100", "Office Expense", "EXPENSE", "400.00", { parent: { id: "p", code: "5000", name: "Operating" } })], totalIncome: "1200.00", totalExpenses: "400.00", netResult: "800.00",
  yearToDate: { from: "2026-01-01", to: "2026-09-30", income: "2000.00", expenses: "900.00", netResult: "1100.00" } };
const sheet = { legalEntityId: "e", baseCurrency: "USD", range: range("AS_OF"), asOf: "2026-09-30", yearStart: "2026-01-01",
  accounts: [row(cash, "1100", "Main Safe", "ASSET", "5380.00", { group: "TREASURY", control: "CASH" }), row(saraf, "1200", "Kabul Saraf", "ASSET", "300.00", { group: "SARAF_PAYABLE", control: "SARAF", bookAmount: "-300.00", reclassified: true }),
    row(loan, "2150", "Temporary funding", "LIABILITY", "500.00", { group: "LOANS", control: "TEMPORARY_FUNDING_PAYABLE" }),
    row(capital, "3100", "Paid in capital", "EQUITY", "1700.00", { group: "SHAREHOLDER_CAPITAL", control: "SHAREHOLDER_CAPITAL" }),
    row(obe, "3900", "Opening balance equity", "EQUITY", "2500.00", { group: "OPENING_BALANCE_EQUITY", control: "OPENING_BALANCE_EQUITY" })],
  totalAssets: "5380.00", totalLiabilities: "380.00", reclassifiedSaraf: "300.00", equityAccounts: "4200.00", earlierYearsResult: "0", currentYearResult: "800.00", totalEquity: "5000.00", totalLiabilitiesAndEquity: "5380.00",
  validation: { difference: "0.00", balanced: true, unbalancedJournals: 0 }, treasury: { treasuryBase: "5080.00", ledgerBase: "5080.00", matches: true } };

async function mock(page: Page, data: { income?: object; sheet?: object } = {}, permissions = ["finance.report.operational.read"]) {
  const asked: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(permissions) } }));
  await page.route("**/api/v1/finance/income-statement*", async (route) => { asked.push(new URL(route.request().url()).search); await route.fulfill({ json: { ok: true, data: data.income ?? income } }); });
  await page.route("**/api/v1/finance/balance-sheet*", async (route) => { asked.push(new URL(route.request().url()).search); await route.fulfill({ json: { ok: true, data: data.sheet ?? sheet } }); });
  return asked;
}

test("@smoke the Income statement is reachable from the menu, with income, expenses, the result and a drill-down", async ({ page }) => {
  await mock(page);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Income statement" }).click();
  const report = page.getByRole("region", { name: "Income statement" });
  await expect(report.getByRole("row", { name: /Total income/ })).toContainText("1,200.00 USD");
  await expect(report.getByRole("row", { name: /Total expenses/ })).toContainText("400.00 USD");
  await expect(report.getByRole("row", { name: /Net profit/ })).toContainText("800.00 USD");
  await expect(report.getByText("Year to date:")).toContainText("1,100.00 USD");
  await expect(report.getByRole("link", { name: /5100 Office Expense/ })).toHaveAttribute("href", `/finance/account-statement?accountId=${expense}&from=2026-09-01&to=2026-09-30`);
  await expect(report.getByText("FY 2026 · Open")).toBeVisible();
});

test("a net loss is named as one", async ({ page }) => {
  await mock(page, { income: { ...income, netResult: "-50.00" } });
  await page.goto("/finance/income-statement?from=2026-09-01&to=2026-09-30");
  await expect(page.getByRole("region", { name: "Income statement" }).getByRole("row", { name: /Net loss/ })).toContainText("−50.00 USD");
});

test("@smoke the Balance sheet shows its proof, its groups and a visible Opening Balance Equity", async ({ page }) => {
  await mock(page);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Balance sheet" }).click();
  const report = page.getByRole("region", { name: "Balance sheet" });
  await expect(report.getByRole("status")).toHaveText("Assets − Liabilities − Equity = 0.00 (balanced)");
  await expect(report.getByRole("row", { name: /Total assets/ })).toContainText("5,380.00 USD");
  await expect(report.getByRole("row", { name: /Total liabilities and equity/ })).toContainText("5,380.00 USD");
  await expect(report.getByText("Treasury and cash")).toBeVisible();
  await expect(report.getByText("Shareholder and provider loans")).toBeVisible();
  await expect(report.getByRole("row", { name: /3900 Opening balance equity/ })).toContainText("2,500.00 USD");
  await expect(report.getByRole("link", { name: "Result of the current year" })).toHaveAttribute("href", "/finance/income-statement?from=2026-01-01&to=2026-09-30");
  await expect(report.getByText("no closing journal has been posted")).toBeVisible();
  await expect(report.getByRole("link", { name: /1100 Main Safe/ })).toHaveAttribute("href", `/finance/account-statement?accountId=${cash}&asOf=2026-09-30`);
});

test("a negative Saraf is a liability, explained, and still opens its own account", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/balance-sheet?asOf=2026-09-30");
  const report = page.getByRole("region", { name: "Balance sheet" });
  await expect(report.getByRole("row", { name: /1200 Kabul Saraf/ })).toBeVisible();
  const position = (text: string) => report.locator("tbody tr").evaluateAll((all, wanted) => all.findIndex((r) => r.textContent?.includes(wanted)), text);
  expect(await position("Owed to Saraf")).toBeGreaterThan(await position("Total assets"));
  expect(await position("Kabul Saraf")).toBeGreaterThan(await position("Owed to Saraf"));
  expect(await position("Kabul Saraf")).toBeLessThan(await position("Total liabilities"));
  await expect(report.getByRole("row", { name: /1200 Kabul Saraf/ })).toContainText("300.00 USD");
  await expect(report.getByRole("row", { name: /1200 Kabul Saraf/ })).not.toContainText("-300");
  await expect(report.getByRole("link", { name: /1200 Kabul Saraf/ })).toHaveAttribute("href", `/finance/account-statement?accountId=${saraf}&asOf=2026-09-30`);
  await expect(report.getByRole("note")).toContainText("A negative Saraf balance is shown under liabilities as an amount owed");
  await expect(report.getByRole("note")).toContainText("300.00 USD");
  await expect(report.getByRole("note")).toContainText("no journal was posted");
  await expect(report.getByRole("row", { name: /Total assets/ })).toContainText("5,380.00 USD");
  await expect(report.getByRole("status")).toContainText("(balanced)");
});

test("a Saraf in credit stays in Treasury, with no reclassification note", async ({ page }) => {
  const accounts = sheet.accounts.map((account) => account.accountId === saraf ? { ...account, bookAmount: "300.00", group: "TREASURY", reclassified: false } : account);
  await mock(page, { sheet: { ...sheet, accounts, reclassifiedSaraf: "0" } });
  await page.goto("/finance/balance-sheet?asOf=2026-09-30");
  const report = page.getByRole("region", { name: "Balance sheet" });
  await expect(report.getByRole("row", { name: /1200 Kabul Saraf/ })).toBeVisible();
  await expect(report.getByText("Owed to Saraf")).toHaveCount(0);
  await expect(report.getByRole("note")).toHaveCount(0);
});

test("an earlier year's result appears, and an imbalance cannot be missed", async ({ page }) => {
  await mock(page, { sheet: { ...sheet, earlierYearsResult: "300.00", validation: { difference: "12.00", balanced: false, unbalancedJournals: 1 }, treasury: { ...sheet.treasury, matches: false } } });
  await page.goto("/finance/balance-sheet?asOf=2026-09-30");
  const report = page.getByRole("region", { name: "Balance sheet" });
  await expect(report.getByRole("row", { name: /Result of earlier years/ })).toContainText("300.00 USD");
  await expect(report.getByRole("status")).toContainText("12.00 (not balanced)");
  await expect(report.getByText("The Treasury accounts do not agree with the General Ledger.")).toBeVisible();
});

test("a balance sheet is at a date: no date range is offered, and a financial year can be chosen", async ({ page }) => {
  const asked = await mock(page);
  await page.goto("/finance/balance-sheet?asOf=2026-09-30");
  await expect(page.getByLabel("Report for").locator("option")).toHaveText(["As of a date", "A financial year"]);
  await page.getByLabel("Report for").selectOption("year");
  await page.getByRole("combobox", { name: "Financial year" }).selectOption({ label: "FY 2026" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect.poll(() => asked.at(-1)).toContain(`fiscalYearId=${yearId}`);
});

test("without report permission the menu items are hidden and the pages refuse", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.expense.create"]) } }));
  for (const path of ["income-statement", "balance-sheet"]) {
    await page.route(`**/api/v1/finance/${path}*`, (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Not allowed." } } }));
  }
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Operations" });
  await expect(nav.getByRole("link", { name: "My dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Income statement" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Balance sheet" })).toHaveCount(0);
  await page.goto("/finance/balance-sheet");
  await expect(page.getByText("This statement needs permission to read Finance reports.")).toBeVisible();
});

test("every report is in the Finance menu for a Finance reader", async ({ page }) => {
  await mock(page, {}, ["finance.report.operational.read", "treasury.safe.read", "shareholder.read"]);
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Operations" });
  for (const name of ["Trial balance", "General Ledger", "Account statement", "Safe / Saraf statement", "Shareholder statement", "Financial summary", "Income statement", "Balance sheet"]) {
    await expect(nav.getByRole("link", { name, exact: true }), name).toBeVisible();
  }
});

test("Dari, RTL, phone width and print", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/balance-sheet?asOf=2026-09-30");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "بیلانس" })).toBeVisible();
  await expect(page.getByRole("region", { name: "بیلانس" }).getByRole("status")).toContainText("متوازن");
  await expect(page.getByRole("region", { name: "بیلانس" }).getByText("قابل پرداخت به صراف")).toBeVisible();
  await expect(page.getByRole("region", { name: "بیلانس" }).getByRole("note")).toContainText("هیچ ژورنالی ثبت نشده است");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.goto("/finance/income-statement?from=2026-09-01&to=2026-09-30");
  await expect(page.getByRole("region", { name: "صورت عاید و مصرف" }).getByRole("row", { name: /مفاد خالص/ })).toContainText("800.00 USD");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".report-filters")).toBeHidden();
  await expect(page.getByRole("region", { name: "صورت عاید و مصرف" })).toBeVisible();
});
