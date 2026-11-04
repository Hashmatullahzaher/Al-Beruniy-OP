import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The balances, the reconciliation and the masking are
// proven by the PostgreSQL suite treasury-statement (0057).
const usdId = "7a000000-0000-4000-8000-000000000001";
const afnId = "7a000000-0000-4000-8000-000000000002";
const sarafId = "7a000000-0000-4000-8000-000000000003";
const journalId = "7a000000-0000-4000-8000-000000000009";
const auth = (permissions: string[]) => ({ userAccountId: "7a000000-0000-4000-8000-00000000000a", loginIdentifier: "ui.safes", displayName: "UI test Cashier",
  jobTitle: "Cashier", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const accounts = [
  { id: usdId, nameEn: "Main Safe", nameFa: "صندوق اصلی", accountType: "SAFE", currencyCode: "USD", status: "ACTIVE" },
  { id: afnId, nameEn: "AFN Safe", nameFa: "صندوق افغانی", accountType: "SAFE", currencyCode: "AFN", status: "ACTIVE" },
  { id: sarafId, nameEn: "Kabul Saraf", nameFa: "صراف کابل", accountType: "SARAF", currencyCode: "USD", status: "ACTIVE" }
];
const range = { mode: "AS_OF", from: "2026-01-01", to: "2026-09-30", period: null, fiscalYear: null, periods: [] };
const label = (en: string, fa: string) => ({ en, fa });
const line = (id: string, extra: object) => ({ id, date: "2026-09-10", postedAt: "2026-09-10T06:00:00Z", moneyIn: "0", moneyOut: "0", balance: "0", currency: "USD", baseAmount: "0",
  restricted: false, kind: "EXTERNAL", isReversal: false, fx: null, journalId, journalReference: "RC-20260910-AAA",
  source: { type: "CASH_RECEIPT", id: "s", label: label("Money received", "پول دریافت‌شده"), route: "/finance/safes", counterparty: "Tenant", detail: null, reference: "RENT-9", description: "September rent" },
  transferPeer: null, reversedBy: null, reverses: null, ...extra });
const totals = { moneyIn: "0", moneyOut: "0", transfersIn: "0", transfersOut: "0", reversalsIn: "0", reversalsOut: "0", movementCount: 0 };
const reconciled = { treasuryBase: "0", ledgerBase: "0", difference: "0", matches: true };
const statement = (accountId: string) => {
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]!;
  const common = { range, canOpenLedger: true, account: { ...account, ledgerAccount: { id: "l1", code: "1100", name: "Cash" } }, reconciliation: reconciled };
  if (accountId === afnId) return { ...common, opening: { native: "0", base: "0" }, closing: { native: "5600.00", base: "80.00" }, totals: { ...totals, moneyIn: "7000.00", moneyOut: "1400.00", movementCount: 2 },
    lines: [line("a1", { currency: "AFN", moneyIn: "7000.00", balance: "7000.00", baseAmount: "100.00",
      fx: { rate: "70", unitCurrency: "USD", quoteCurrency: "AFN", rateDate: "2026-09-14", source: "MARKET", policyVersionId: "p", roundingMode: "HALF_UP", baseScale: 2, exactBaseAmount: "100", roundingDifference: "0" } })] };
  if (accountId === sarafId) return { ...common, opening: { native: "0", base: "0" }, closing: { native: "-300.00", base: "-300.00" }, totals: { ...totals, moneyIn: "100.00", moneyOut: "400.00", movementCount: 2 },
    lines: [line("s1", { moneyIn: "100.00", balance: "100.00", baseAmount: "100.00" }), line("s2", { moneyOut: "400.00", balance: "-300.00", baseAmount: "-400.00" })] };
  return { ...common, opening: { native: "2500.00", base: "2500.00" }, closing: { native: "2900.00", base: "2900.00" },
    totals: { ...totals, moneyIn: "800.00", moneyOut: "400.00", transfersOut: "300.00", reversalsIn: "100.00", movementCount: 5 },
    lines: [
      line("u1", { moneyIn: "700.00", balance: "3200.00", baseAmount: "700.00" }),
      line("u2", { moneyOut: "300.00", balance: "2900.00", baseAmount: "-300.00", kind: "TRANSFER", journalReference: "TR-20260913-BBB", transferPeer: label("Petty cash", "تنخواه"),
        source: { type: "TREASURY_TRANSFER", id: "t", label: label("Transfer between accounts", "انتقال میان حساب‌ها"), route: "/finance/safes", counterparty: null, detail: null, reference: null, description: null } }),
      line("u3", { moneyOut: "100.00", balance: "2800.00", baseAmount: "-100.00", journalReference: "PY-20260914-CCC", reversedBy: { journalId: "r1", reference: "RV-1", date: "2026-09-15" },
        source: { type: "PAYMENT", id: "p", label: label("Payment", "پرداخت"), route: "/finance/safes", counterparty: "Supplier", detail: null, reference: null, description: null } }),
      line("u4", { moneyIn: "100.00", balance: "2900.00", baseAmount: "100.00", isReversal: true, journalReference: "RV-1", reverses: { journalId, reference: "PY-20260914-CCC", date: "2026-09-14" },
        source: { type: "REVERSAL", id: "r", label: label("Reversal", "برگشت"), route: "/finance/reversals", counterparty: null, detail: null, reference: null, description: null } }),
      line("u5", { restricted: true, journalId: null, journalReference: null, moneyIn: "0", moneyOut: "0", balance: "2900.00",
        source: { type: "RESTRICTED", id: null, label: label("Restricted movement", "حرکت محدود"), route: null, counterparty: null } })
    ] };
};

async function mock(page: Page, permissions = ["treasury.safe.read", "finance.report.operational.read"], change: (view: ReturnType<typeof statement>) => object = (view) => view) {
  const asked: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(permissions) } }));
  await page.route("**/api/v1/finance/safe-statement*", async (route) => {
    const query = new URL(route.request().url()).searchParams; asked.push(query.toString());
    const id = query.get("accountId");
    await route.fulfill({ json: { ok: true, data: { legalEntityId: "e", baseCurrency: "USD", accounts, statement: id ? change(statement(id)) : null } } });
  });
  return asked;
}

test("@smoke a report reader chooses a Safe from the menu and reads its statement in its own currency", async ({ page }) => {
  const asked = await mock(page);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Safe / Saraf statement" }).click();
  await expect(page.getByText("Choose a Safe or Saraf.")).toBeVisible();
  await page.getByLabel("Safe or Saraf").selectOption({ label: "Main Safe · USD" });
  const report = page.getByRole("region", { name: "Statement" });
  await expect(report.getByText("2,900.00 USD").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Main Safe" })).toBeVisible();
  await expect(report.getByText("Safe · USD")).toBeVisible();
  await expect(report.getByRole("status")).toContainText("Agrees with the General Ledger.");
  await expect(report.getByRole("link", { name: /Ledger account/ })).toHaveAttribute("href", "/finance/account-statement?accountId=l1");
  const first = report.getByRole("row").filter({ hasText: "RENT-9" });
  await expect(first).toContainText("Money received · Tenant");
  await expect(first).toContainText("September rent");
  await expect(first).toContainText("3,200.00 USD");
  await expect(first.getByRole("link", { name: "RC-20260910-AAA" })).toHaveAttribute("href", `/finance/general-ledger?journalId=${journalId}`);
  expect(asked.at(-1)).toContain(`accountId=${usdId}`);
  expect(asked.at(-1)).toContain("asOf=");
});

test("transfers name the other account and are called out; reversals keep both movements and are marked", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${usdId}&asOf=2026-09-30`);
  const report = page.getByRole("region", { name: "Statement" });
  await expect(report.getByRole("row").filter({ hasText: "TR-20260913-BBB" })).toContainText("Transfer to Petty cash");
  await expect(report.getByText("Includes transfers between the company's own accounts:")).toContainText("300.00 USD");
  await expect(report.getByRole("row").filter({ hasText: "PY-20260914-CCC" }).first()).toContainText("reversed");
  await expect(report.getByRole("row").filter({ hasText: "reverses PY-20260914-CCC" })).toContainText("Reversal");
  await expect(report.getByText("Includes reversals:")).toContainText("100.00 USD");
  const hidden = report.getByRole("row").filter({ hasText: "Restricted movement" }).first();
  await expect(hidden).toContainText("2,900.00 USD");
  await expect(hidden.getByRole("link")).toHaveCount(0);
});

test("an AFN Safe's balance is AFN; USD is labelled as accounting value, never as the balance", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${afnId}&asOf=2026-09-30`);
  const report = page.getByRole("region", { name: "Statement" });
  await expect(report.getByRole("definition").filter({ hasText: "5,600.00 AFN" })).toBeVisible();
  await expect(report.getByText(/This account's balance is in AFN\. Accounting value \(USD/)).toContainText("80.00 USD");
  await expect(report.getByRole("columnheader", { name: "Accounting value (USD)" })).toBeVisible();
  await expect(report.getByRole("row").filter({ hasText: "7,000.00" })).toContainText("1 USD = 70 AFN");
  await expect(report.getByRole("columnheader", { name: "Balance", exact: true })).toBeVisible();
});

test("a Saraf's negative balance is shown as it is and explained", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${sarafId}&asOf=2026-09-30`);
  const report = page.getByRole("region", { name: "Statement" });
  await expect(report.getByRole("definition").filter({ hasText: /[-−]300.00 USD/ })).toBeVisible();
  await expect(report.getByRole("note")).toHaveText("A negative balance is an amount owed to the Saraf.");
});

test("a reader without report permission gets no ledger links, and a mismatch with the ledger is impossible to miss", async ({ page }) => {
  await mock(page, ["treasury.safe.read"], (view) => ({ ...view, canOpenLedger: false, account: { ...view.account, ledgerAccount: null },
    lines: view.lines.map((l) => ({ ...l, journalId: null })), reconciliation: { treasuryBase: "2900.00", ledgerBase: "2800.00", difference: "100.00", matches: false } }));
  await page.goto(`/finance/safe-statement?accountId=${usdId}&asOf=2026-09-30`);
  const report = page.getByRole("region", { name: "Statement" });
  await expect(report.getByRole("status")).toContainText("Does not agree with the General Ledger. Difference: 100.00 USD");
  await expect(report.getByRole("link", { name: /Ledger account/ })).toHaveCount(0);
  await expect(report.getByRole("row").filter({ hasText: "RC-20260910-AAA" }).getByRole("link", { name: "RC-20260910-AAA" })).toHaveCount(0);
});

test("the date range is sent as chosen, and a refused request is explained", async ({ page }) => {
  const asked = await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${usdId}&asOf=2026-09-30`);
  await page.getByLabel("Report for").selectOption("range");
  await page.getByLabel("From").fill("2026-09-01");
  await page.getByLabel("To", { exact: true }).fill("2026-09-30");
  await page.getByRole("button", { name: "Show" }).click();
  await expect.poll(() => asked.at(-1)).toContain("from=2026-09-01");
  await page.route("**/api/v1/finance/safe-statement*", (route) => route.fulfill({ status: 422, json: { ok: false, error: { code: "TOO_MANY_LINES", message: "This statement is too long. Choose a shorter period." } } }));
  await page.reload();
  await expect(page.locator(".treasury-message.error")).toContainText("Choose a shorter period");
});

test("without Safe or report permission the menu item is hidden and the page refuses", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.expense.create"]) } }));
  await page.route("**/api/v1/finance/safe-statement*", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Not allowed." } } }));
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Operations" });
  await expect(nav.getByRole("link", { name: "My dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Safe / Saraf statement" })).toHaveCount(0);
  await page.goto("/finance/safe-statement");
  await expect(page.getByText("Safe and Saraf statements need permission to read Safes or Finance reports.")).toBeVisible();
});

test("Dari, RTL and phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${usdId}&asOf=2026-09-30`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "صندوق اصلی" })).toBeVisible();
  const report = page.getByRole("region", { name: "صورت‌حساب" });
  await expect(report.getByRole("status")).toContainText("با دفتر کل مطابقت دارد.");
  await expect(report.getByRole("row").filter({ hasText: "TR-20260913-BBB" })).toContainText("انتقال به تنخواه");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("printing shows the report without the application around it", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/safe-statement?accountId=${usdId}&asOf=2026-09-30`);
  await expect(page.getByRole("region", { name: "Statement" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".report-filters")).toBeHidden();
  await expect(page.getByRole("region", { name: "Statement" }).getByRole("columnheader", { name: "Money in" })).toBeVisible();
});
