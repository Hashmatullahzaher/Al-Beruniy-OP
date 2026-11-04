import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The figures, reconciliation and masking are proven by the
// PostgreSQL suite shareholder-summary (0058).
const partyA = "7b000000-0000-4000-8000-000000000001";
const partyB = "7b000000-0000-4000-8000-000000000002";
const safeId = "7b000000-0000-4000-8000-000000000003";
const yearId = "7b000000-0000-4000-8000-000000000004";
const journalId = "7b000000-0000-4000-8000-000000000005";
const auth = (permissions: string[]) => ({ userAccountId: "7b000000-0000-4000-8000-000000000009", loginIdentifier: "ui.reports", displayName: "UI test Accountant",
  jobTitle: "Accountant", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const range = { mode: "AS_OF", from: "2026-01-01", to: "2026-09-30", period: null, periods: [],
  fiscalYear: { id: yearId, calendarKind: "GREGORIAN", label: "FY 2026", labelFa: "سال مالی ۲۰۲۶", startsOn: "2026-01-01", endsOn: "2026-12-31", closed: false },
  fiscalYears: [{ id: yearId, label: "FY 2026", labelFa: "سال مالی ۲۰۲۶", startsOn: "2026-01-01", endsOn: "2026-12-31", closed: false }] };
const figures = { opening: "0", closing: "5080.00", capitalReceived: "1700.00", loansReceived: "600.00", otherReceipts: "1200.00", moneyReceived: "3500.00", expensesPaid: "250.00",
  paymentsMade: "420.00", loanRepayments: "250.00", moneyPaid: "920.00", openingBalancesRecorded: "2500.00", transfersIn: "300.00", transfersOut: "300.00", unclassified: "0",
  reversalsIn: "150.00", reversalsOut: "320.00", reversalCount: 5, flowsClosing: "5080.00" };
const summary = { legalEntityId: "e", baseCurrency: "USD", range, base: figures,
  currencies: { USD: figures, AFN: { ...figures, closing: "5600.00", otherReceipts: "7000.00", moneyReceived: "7000.00", paymentsMade: "1400.00", moneyPaid: "1400.00", capitalReceived: "0", loansReceived: "0", expensesPaid: "0", loanRepayments: "0", openingBalancesRecorded: "0" } },
  accounts: [{ id: safeId, nameEn: "Main Safe", nameFa: "صندوق اصلی", accountType: "SAFE", currency: "USD", status: "ACTIVE", opening: "0", closing: "5000.00", baseOpening: "0", baseClosing: "5000.00" }],
  profit: { income: "1200.00", expenses: "400.00", netResult: "800.00" }, reconciliation: { treasuryClosing: "5080.00", flowsClosing: "5080.00", ledgerClosing: "5080.00", matches: true } };
const source = { type: "DIRECT_SHAREHOLDER_CAPITAL", id: "s", label: { en: "Capital received", fa: "سرمایه دریافت‌شده" }, route: "/shareholders?shareholder=p", counterparty: null, reference: "CAP-REF-1", description: "First payment" };
const transaction = (extra: object) => ({ id: "t1", date: "2026-09-06", kind: "CAPITAL_RECEIVED", section: "CAPITAL", amount: "700.00", effect: "700.00", balance: "700.00", currency: "USD", baseAmount: "700.00",
  restricted: false, source, journalId, journalReference: "CAP-20260906-AAA", safe: { id: safeId, nameEn: "Main Safe", nameFa: "صندوق اصلی" }, reversedBy: null, reverses: null, ...extra });
const list = { legalEntityId: "e", baseCurrency: "USD", range, canReadCapital: true, canReadLoans: true,
  totals: { capital: [{ currency: "USD", effective: "1700.00", baseEffective: "1700.00" }], loans: [{ currency: "USD", outstanding: "500.00", baseOutstanding: "500.00" }] },
  people: [{ partyId: partyA, name: "Holder One", isShareholder: true, capital: [{ currency: "USD", effective: "700.00", baseEffective: "700.00" }], loans: [{ currency: "USD", outstanding: "350.00", baseOutstanding: "350.00" }] },
    { partyId: partyB, name: "Holder Two", isShareholder: true, capital: [{ currency: "USD", effective: "1000.00", baseEffective: "1000.00" }], loans: [] }],
  reconciliation: { capital: { subledgerBase: "1700.00", ledgerBase: "1700.00", matches: true }, loans: { subledgerBase: "500.00", ledgerBase: "500.00", matches: true } }, statement: null };
const person = { ...list, statement: { party: { id: partyA, name: "Holder One", shareholderProfileId: "p" }, canOpenLedger: true,
  capital: [{ currency: "USD", agreed: "5000.00", opening: "0", received: "1000.00", reversed: "300.00", effective: "700.00", baseEffective: "700.00", outstanding: "4300.00" }],
  loans: [{ currency: "USD", opening: "0", received: "600.00", repaid: "250.00", outstanding: "350.00", baseOutstanding: "350.00" }],
  transactions: [transaction({}), transaction({ id: "t2", kind: "LOAN_RECEIVED", section: "LOAN", amount: "600.00", balance: "600.00", journalReference: "TF-1", source: { ...source, type: "TEMPORARY_FUNDING", label: { en: "Funding received", fa: "تمویل دریافت‌شده" }, reference: "LOAN-1", description: null } })] } };

async function mock(page: Page, permissions: string[], data: { summary?: object; shareholders?: (partyId: string | null) => object } = {}) {
  const asked: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(permissions) } }));
  await page.route("**/api/v1/finance/financial-summary*", async (route) => { asked.push(new URL(route.request().url()).search); await route.fulfill({ json: { ok: true, data: data.summary ?? summary } }); });
  await page.route("**/api/v1/finance/shareholder-statement*", async (route) => {
    const partyId = new URL(route.request().url()).searchParams.get("partyId"); asked.push(new URL(route.request().url()).search);
    await route.fulfill({ json: { ok: true, data: data.shareholders?.(partyId) ?? (partyId ? person : list) } });
  });
  return asked;
}
const ALL = ["finance.report.operational.read", "shareholder.read", "finance.temporary-funding.read"];

test("@smoke the Financial summary is reachable from the menu and shows money in, out, the closing position and the result", async ({ page }) => {
  await mock(page, ALL);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Financial summary" }).click();
  const treasury = page.getByRole("region", { name: "Treasury", exact: true });
  await expect(treasury.getByRole("row", { name: /Shareholder capital received/ })).toContainText("1,700.00 USD");
  await expect(treasury.getByRole("row", { name: /Total money received/ })).toContainText("3,500.00 USD");
  await expect(treasury.getByRole("row", { name: /Total money paid/ })).toContainText("920.00 USD");
  await expect(treasury.getByRole("row", { name: /Closing Treasury position/ })).toContainText("5,080.00 USD");
  await expect(treasury.getByRole("status")).toContainText("agrees with the Treasury accounts and the General Ledger");
  await expect(treasury.getByText("FY 2026 · Open")).toBeVisible();
  await expect(page.getByRole("region", { name: "Result" }).getByRole("definition").filter({ hasText: "800.00 USD" })).toBeVisible();
  await expect(page.getByText("Net profit")).toBeVisible();
});

test("transfers and reversals are apart from money in and out, and each account opens its statement", async ({ page }) => {
  await mock(page, ALL);
  await page.goto("/finance/financial-summary?asOf=2026-09-30");
  const moved = page.getByRole("region", { name: "Transfers and reversals" });
  await expect(moved.getByText("Moved between the company's own accounts")).toBeVisible();
  await expect(moved.getByRole("definition").filter({ hasText: "300.00 USD" })).toBeVisible();
  await expect(moved.getByText("already net of reversals")).toBeVisible();
  const accounts = page.getByRole("region", { name: "Treasury accounts" });
  await expect(accounts.getByRole("link", { name: "Main Safe" })).toHaveAttribute("href", `/finance/safe-statement?accountId=${safeId}&asOf=2026-09-30`);
});

test("a net loss says so, a mismatch is impossible to miss, and AFN has its own section", async ({ page }) => {
  await mock(page, ALL, { summary: { ...summary, profit: { income: "100.00", expenses: "400.00", netResult: "-300.00" }, reconciliation: { ...summary.reconciliation, matches: false } } });
  await page.goto("/finance/financial-summary?asOf=2026-09-30");
  await expect(page.getByText("Net loss")).toBeVisible();
  await expect(page.getByRole("region", { name: "Treasury", exact: true }).getByRole("status")).toContainText("does not agree with the General Ledger");
  await expect(page.getByRole("region", { name: "AFN" }).getByRole("row", { name: /Closing Treasury position/ })).toContainText("5,600.00 AFN");
});

test("a financial year can be chosen and stays in the address", async ({ page }) => {
  const asked = await mock(page, ALL);
  await page.goto("/finance/financial-summary?asOf=2026-09-30");
  await page.getByLabel("Report for").selectOption("year");
  await page.getByRole("combobox", { name: "Financial year" }).selectOption({ label: "FY 2026" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(new RegExp(`fiscalYearId=${yearId}`));
  await expect.poll(() => asked.at(-1)).toContain(`fiscalYearId=${yearId}`);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Financial year" })).toHaveValue(yearId);
});

test("@smoke the Shareholder statement keeps equity and debt apart, with the agreement as information", async ({ page }) => {
  await mock(page, ALL);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Shareholder statement" }).click();
  const totals = page.getByRole("region", { name: "Company totals" });
  await expect(totals.getByRole("definition").filter({ hasText: "1,700.00 USD" })).toBeVisible();
  await expect(totals.getByRole("status")).toContainText("Agrees with the General Ledger.");
  await totals.getByRole("button", { name: "Holder One" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Holder One" })).toBeVisible();
  const capital = page.getByRole("region", { name: "Capital (equity)" });
  await expect(capital.getByText("Agreed capital")).toBeVisible();
  await expect(capital.getByRole("definition").filter({ hasText: "4,300.00 USD" })).toBeVisible();
  await expect(capital.getByText("The agreed figure is for information")).toBeVisible();
  const loans = page.getByRole("region", { name: "Loans (debt)" });
  await expect(loans.getByRole("definition").filter({ hasText: "350.00 USD" })).toBeVisible();
  await expect(capital.getByText("LOAN-1")).toHaveCount(0);
  await expect(loans.getByText("CAP-REF-1")).toHaveCount(0);
});

test("a transaction drills down to its journal and its Safe movement", async ({ page }) => {
  await mock(page, ALL);
  await page.goto(`/finance/shareholder-statement?partyId=${partyA}&asOf=2026-09-30`);
  const row = page.getByRole("region", { name: "Capital (equity)" }).getByRole("row").filter({ hasText: "CAP-REF-1" });
  await expect(row.getByRole("link", { name: "CAP-20260906-AAA" })).toHaveAttribute("href", `/finance/general-ledger?journalId=${journalId}`);
  await expect(row.getByRole("link", { name: "Main Safe" })).toHaveAttribute("href", `/finance/safe-statement?accountId=${safeId}&asOf=2026-09-30`);
  await expect(row).toContainText("First payment");
});

test("a report-only reader sees totals, nobody named, and is told why", async ({ page }) => {
  await mock(page, ["finance.report.operational.read"], { shareholders: () => ({ ...list, canReadCapital: false, canReadLoans: false, people: [] }) });
  await page.goto("/finance/shareholder-statement?asOf=2026-09-30");
  await expect(page.getByRole("region", { name: "Company totals" }).getByRole("definition").filter({ hasText: "500.00 USD" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("needs permission to read shareholders or loans");
  await expect(page.getByLabel("Person")).toHaveCount(0);
  await expect(page.getByText("Holder One")).toHaveCount(0);
});

test("a capital reader has no loan section", async ({ page }) => {
  await mock(page, ["shareholder.read"], { shareholders: (id) => (id ? { ...person, canReadLoans: false, totals: { ...list.totals, loans: null }, reconciliation: { ...list.reconciliation, loans: null },
    statement: { ...person.statement, loans: null, canOpenLedger: false, transactions: person.statement.transactions.filter((t) => t.section === "CAPITAL").map((t) => ({ ...t, journalId: null, safe: null })) } } : list) });
  await page.goto(`/finance/shareholder-statement?partyId=${partyA}&asOf=2026-09-30`);
  await expect(page.getByRole("region", { name: "Capital (equity)" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Loans (debt)" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "CAP-20260906-AAA" })).toHaveCount(0);
});

test("without permission the menu items are hidden and the pages refuse", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.expense.create"]) } }));
  for (const path of ["financial-summary", "shareholder-statement"]) {
    await page.route(`**/api/v1/finance/${path}*`, (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Not allowed." } } }));
  }
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Operations" });
  await expect(nav.getByRole("link", { name: "My dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Financial summary" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Shareholder statement" })).toHaveCount(0);
  await page.goto("/finance/financial-summary");
  await expect(page.getByText("The Financial summary needs permission to read Finance reports.")).toBeVisible();
  await page.goto("/finance/shareholder-statement");
  await expect(page.getByText("Shareholder statements need permission to read shareholders, loans or Finance reports.")).toBeVisible();
});

test("Dari, RTL, phone width and print", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, ALL);
  await page.goto("/finance/financial-summary?asOf=2026-09-30");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "خلاصهٔ مالی" })).toBeVisible();
  await expect(page.getByRole("region", { name: "نقدینگی" }).getByRole("row", { name: /موجودی پایان دوره/ })).toContainText("5,080.00 USD");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.goto(`/finance/shareholder-statement?partyId=${partyA}&asOf=2026-09-30`);
  await expect(page.getByRole("region", { name: "قرض (بدهی)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".report-filters")).toBeHidden();
});
