import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only: what the screens offer, what they ask the server for, and how they print. What the file holds, the audit event and
// every refusal are proven against PostgreSQL (packages/e1-integration report-export-audit, 0068) and through the real server
// (v1-operational-finance, ABOS_V1_PREVIEW_E2E).
const cashId = "79000000-0000-4000-8000-000000000001";
const safeId = "79000000-0000-4000-8000-000000000002";
const periodId = "79000000-0000-4000-8000-000000000010";
const auth = { userAccountId: "79000000-0000-4000-8000-000000000009", loginIdentifier: "ui.export", displayName: "UI test Accountant", jobTitle: "Accountant",
  legalEntityName: "UI test company", permissions: ["finance.report.operational.read", "treasury.safe.read"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
const range = (mode: string) => ({ mode, from: "2026-09-01", to: "2026-09-30", period: mode === "PERIOD" ? { id: periodId, name: "September 2026", nameFa: "سپتمبر ۲۰۲۶" } : null,
  fiscalYear: null, periods: [{ id: periodId, name: "September 2026", nameFa: "سپتمبر ۲۰۲۶", startsOn: "2026-09-01", endsOn: "2026-09-30" }], fiscalYears: [] });
const trialBalance = { legalEntityId: "e", baseCurrency: "USD", range: range("AS_OF"), includeZero: false, balanced: true, unbalancedJournals: 0,
  accounts: [{ accountId: cashId, accountCode: "C-01", accountName: "Cash", accountType: "ASSET", controlType: null, accountCurrency: "USD", status: "ACTIVE", parentId: null,
    openingDebit: "0", openingCredit: "0", periodDebit: "100.00", periodCredit: "0", endingDebit: "100.00", endingCredit: "0", native: [] }],
  totals: { openingDebit: "0", openingCredit: "0", periodDebit: "100.00", periodCredit: "0", endingDebit: "100.00", endingCredit: "0" } };
const statement = { legalEntityId: "e", range: range("PERIOD"), account: { id: cashId, code: "C-01", name: "Cash", type: "ASSET", controlType: "CASH", currency: "USD", status: "ACTIVE" },
  opening: { debit: "0", credit: "0", net: "0" }, periodDebit: "100.00", periodCredit: "0", closing: { debit: "100.00", credit: "0", net: "100.00" }, lines: [] };
const safe = { legalEntityId: "e", baseCurrency: "USD", accounts: [{ id: safeId, nameEn: "Main USD Safe", nameFa: "صندوق اصلی", accountType: "SAFE", currencyCode: "USD", status: "ACTIVE" }],
  statement: { range: range("RANGE"), canOpenLedger: true, carryingStatus: "OK",
    account: { id: safeId, nameEn: "Main USD Safe", nameFa: "صندوق اصلی", accountType: "SAFE", currencyCode: "USD", status: "ACTIVE", ledgerAccount: null },
    opening: { native: "0", base: "0" }, closing: { native: "0", base: "0" },
    totals: { moneyIn: "0", moneyOut: "0", transfersIn: "0", transfersOut: "0", reversalsIn: "0", reversalsOut: "0", movementCount: 0 }, lines: [],
    reconciliation: { treasuryBase: "0", ledgerBase: "0", difference: "0", matches: true } } };
const ledger = { syntheticOnly: false, legalEntityId: "e", from: "2026-01-01", to: "2026-09-30", accountId: null, accounts: [], currencyTotals: [], lines: [], totals: [],
  returnedLineCount: 0, hasMore: false, nextCursor: null, pageLimit: 100, order: "", basis: "POSTED_ACTIVITY_IN_RANGE", isBalance: false, openingBalancesIncluded: false };
const FILE = "\uFEFF\"Report\",\"Trial balance\"\r\n\"Confidential / محرمانه\"\r\n\r\n\"Code\",\"Account\"\r\n\"C-01\",\"Cash\"\r\n";

/** Mocks the reports and records every export request. */
async function mock(page: Page) {
  const exports: URL[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth } }));
  await page.route("**/api/v1/finance/trial-balance*", (route) => route.fulfill({ json: { ok: true, data: trialBalance } }));
  await page.route("**/api/v1/finance/account-statement*", (route) => route.fulfill({ json: { ok: true, data: statement } }));
  await page.route("**/api/v1/finance/safe-statement*", (route) => route.fulfill({ json: { ok: true, data: safe } }));
  await page.route(/\/api\/v1\/finance\/general-ledger(\/activity)?\?/, (route) => route.fulfill({ json: { ok: true, data: ledger } }));
  await page.route("**/api/v1/finance/accounts*", (route) => route.fulfill({ json: { ok: true, data: { accounts: [] } } }));
  await page.route("**/api/v1/finance/report-export*", async (route) => {
    exports.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, body: FILE, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": "attachment; filename=\"trial-balance_2026-09-01_2026-09-30.csv\"" } });
  });
  return exports;
}

test("@smoke the trial balance offers CSV (Excel-compatible), asks for exactly the report on the screen, and saves the server's file", async ({ page }) => {
  const exports = await mock(page);
  await page.goto("/finance/trial-balance");
  await expect(page.getByRole("region", { name: "Trial balance" }).getByRole("status")).toContainText("Balanced");
  const button = page.getByRole("button", { name: "CSV (Excel-compatible)" });
  await expect(button).toBeVisible();
  // CSV is never offered as native Excel.
  await expect(page.getByRole("button", { name: /^(Excel|XLSX|Download Excel)/i })).toHaveCount(0);
  const download = page.waitForEvent("download");
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("trial-balance_2026-09-01_2026-09-30.csv");
  const bytes = await readFile(await file.path());
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.toString("utf8")).toContain("محرمانه");
  expect(exports).toHaveLength(1);
  const asked = Object.fromEntries(exports[0]!.searchParams);
  // The period the screen shows (the report resolved "as of" to 30 September), not whatever the form says now.
  expect(asked).toEqual({ report: "trial-balance", format: "csv", lang: "en", asOf: "2026-09-30" });
});

test("a refused export says why on the screen, in English and Dari, and saves nothing", async ({ page }) => {
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await mock(page);
  await page.route("**/api/v1/finance/report-export*", (route) => route.fulfill({ status: 422, json: { ok: false,
    error: { code: "TOO_MANY_LINES", message: "This statement is too long. Choose a shorter period." } } }));
  await page.goto(`/finance/account-statement?accountId=${cashId}&periodId=${periodId}`);
  await page.getByRole("button", { name: "CSV (Excel-compatible)" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("This statement is too long. Choose a shorter period.");
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("این صورت‌حساب خیلی طولانی است. دورهٔ کوتاه‌تری انتخاب کنید.");
  await page.getByRole("button", { name: "CSV (سازگار با Excel)" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("این صورت‌حساب خیلی طولانی است. دورهٔ کوتاه‌تری انتخاب کنید.");
  expect(downloads).toBe(0);
});

test("the statements and the General Ledger export the account and period on the screen, in the reader's language", async ({ page }) => {
  const exports = await mock(page);
  const exportFrom = async (path: string) => {
    await page.goto(path);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /^CSV \(/ }).click();
    await download;
    return Object.fromEntries(exports.at(-1)!.searchParams);
  };
  expect(await exportFrom(`/finance/account-statement?accountId=${cashId}&periodId=${periodId}`))
    .toEqual({ report: "account-statement", format: "csv", lang: "en", accountId: cashId, periodId });
  expect(await exportFrom(`/finance/safe-statement?accountId=${safeId}&from=2026-09-01&to=2026-09-30`))
    .toEqual({ report: "safe-statement", format: "csv", lang: "en", accountId: safeId, from: "2026-09-01", to: "2026-09-30" });
  expect(await exportFrom("/finance/general-ledger")).toEqual({ report: "general-ledger", format: "csv", lang: "en", from: "2026-01-01", to: "2026-09-30" });
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV (سازگار با Excel)" }).click();
  await download;
  expect(exports.at(-1)!.searchParams.get("lang")).toBe("fa");
});

test("a printed report carries the company, report, period, currency, print time and Confidential, in English and in Dari right to left", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/trial-balance");
  await expect(page.getByRole("region", { name: "Trial balance" }).getByRole("status")).toContainText("Balanced");
  const header = page.getByTestId("report-print-header");
  await expect(header).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute("dir", "ltr");
  await expect(header).toContainText("Confidential / محرمانه");
  await expect(header.getByRole("heading", { name: "Trial balance" })).toBeVisible();
  for (const [term, value] of [["Company", "UI test company"], ["Currency", "USD"], ["Period", "2026"], ["Printed", "Kabul"]] as const) {
    await expect(header.getByRole("term").filter({ hasText: term }).locator("xpath=following-sibling::dd")).toContainText(value);
  }
  await expect(page.locator(".print-confidential")).toBeVisible();
  await expect(page.locator(".print-confidential")).toHaveText("Confidential / محرمانه");
  // Navigation, filters and the export button are not printed.
  await expect(page.getByRole("button", { name: "CSV (Excel-compatible)", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("form", { name: "Report filters" })).toBeHidden();

  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await page.emulateMedia({ media: "print" });
  await expect(header).toHaveAttribute("dir", "rtl");
  await expect(header.getByRole("heading", { name: "بیلانس آزمایشی" })).toBeVisible();
  await expect(header).toContainText("Confidential / محرمانه");
  await expect(header.getByRole("term").filter({ hasText: "شرکت" }).locator("xpath=following-sibling::dd")).toHaveText("UI test company");
  await expect(header.getByRole("term").filter({ hasText: "زمان چاپ" }).locator("xpath=following-sibling::dd")).toContainText("کابل");
});

test("every printable report has the print header", async ({ page }) => {
  await mock(page);
  await page.emulateMedia({ media: "print" });
  for (const [path, title] of [[`/finance/account-statement?accountId=${cashId}&periodId=${periodId}`, "Account statement · C-01 · Cash"],
    [`/finance/safe-statement?accountId=${safeId}&from=2026-09-01&to=2026-09-30`, "Safe / Saraf statement · Main USD Safe"], ["/finance/general-ledger", "General Ledger activity"]] as const) {
    await page.goto(path);
    const header = page.getByTestId("report-print-header");
    await expect(header.getByRole("heading", { name: title })).toBeVisible();
    await expect(header).toContainText("Confidential / محرمانه");
  }
});
