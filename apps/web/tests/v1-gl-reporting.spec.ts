import { expect, test, type Page } from "@playwright/test";

const day = new Date().toISOString().slice(0, 10);
const journalId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const capitalAccountId = "66666666-6666-4666-8666-666666666666";
const entityId = "33333333-3333-4333-8333-333333333333";
const ORDER = "accountingEffectiveDate DESC, postedAt DESC, journalId DESC, lineNumber ASC";

function line(index: number, overrides: Record<string, unknown> = {}) {
  const id = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  return {
    journalId: id, journalReference: `SYN-JRN-${String(index).padStart(3, "0")}`, lineNumber: 1, accountId,
    accountCode: "SYN-101", accountName: "Synthetic safe cash",
    sourceType: "CAPITAL_RECEIPT", sourceId: "44444444-4444-4444-8444-444444444444",
    accountingPeriodId: "55555555-5555-4555-8555-555555555555",
    accountingEffectiveDate: day, postedAt: `${day}T09:00:00Z`,
    originalCurrency: "USD", originalAmount: "1.25", baseCurrency: "USD", baseDebit: "1.25", baseCredit: "0",
    ...overrides
  };
}

function page(lines: readonly unknown[], extra: Record<string, unknown>) {
  return {
    ok: true,
    data: {
      syntheticOnly: false, legalEntityId: entityId, from: day, to: day, accountId: null, order: ORDER, pageLimit: 100,
      returnedLineCount: lines.length, hasMore: false, nextCursor: null, totals: null, lines, ...extra
    }
  };
}

const ACTIVITY = {
  ok: true,
  data: {
    syntheticOnly: false, legalEntityId: entityId, from: day, to: day, accountId: null,
    basis: "POSTED_ACTIVITY_IN_RANGE", isBalance: false, openingBalancesIncluded: false,
    accounts: [
      { accountId, accountCode: "SYN-101", accountName: "Synthetic safe cash", baseCurrency: "USD",
        debitTotal: "12345678901234567890.123456789000000001", creditTotal: "0.1", net: "12345678901234567890.023456789000000001", lineCount: "3",
        originalCurrencies: [{ currency: "USD", debitTotal: "12345678901234567890.123456789000000001", creditTotal: "0.1", net: "12345678901234567890.023456789000000001", lineCount: "3" }] },
      { accountId: capitalAccountId, accountCode: "SYN-301", accountName: "Synthetic paid-in capital", baseCurrency: "AFN",
        debitTotal: "0", creditTotal: "98765432109876543210.987654321", net: "-98765432109876543210.987654321", lineCount: "1",
        originalCurrencies: [{ currency: "AFN", debitTotal: "0", creditTotal: "98765432109876543210.987654321", net: "-98765432109876543210.987654321", lineCount: "1" }] },
      { accountId: capitalAccountId, accountCode: "SYN-301", accountName: "Synthetic paid-in capital", baseCurrency: "USD",
        debitTotal: "0.1", creditTotal: "12345678901234567890.123456789000000001", net: "-12345678901234567890.023456789000000001", lineCount: "3",
        originalCurrencies: [] }
    ],
    currencyTotals: [
      { baseCurrency: "AFN", debitTotal: "0", creditTotal: "98765432109876543210.987654321", net: "-98765432109876543210.987654321", lineCount: "1", accountCount: "1" },
      { baseCurrency: "USD", debitTotal: "12345678901234567890.223456789000000001", creditTotal: "12345678901234567890.223456789000000001", net: "0.000000000000000000", lineCount: "6", accountCount: "2" }
    ]
  }
};

async function mockAccounts(pageRef: Page) {
  await pageRef.route("**/api/v1/finance/accounts", (route) => route.fulfill({ json: {
    ok: true, data: { accounts: [{ id: accountId, code: "SYN-101", name: "Synthetic safe cash", nameFa: "نقد مصنوعی" }] }
  } }));
}

async function mockActivity(pageRef: Page, body: unknown = ACTIVITY) {
  await pageRef.route("**/api/v1/finance/general-ledger/activity?**", (route) => route.fulfill({ json: body }));
}

async function noHorizontalOverflow(pageRef: Page) {
  const overflow = await pageRef.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("posted GL preview preserves exact decimal text, both calendars, source and account filters", async ({ page: browser }) => {
  await mockAccounts(browser);
  await browser.route("**/api/v1/finance/general-ledger?**", (route) => route.fulfill({ json: page([line(1, {
    journalId, journalReference: "SYN-JRN-001", originalAmount: "12345678901234567890.123456789", baseDebit: "12345678901234567890.123456789"
  })], {
    hasMore: true, nextCursor: "CURSOR_TWO",
    totals: [{ currency: "USD", debits: "12345678901234567890.123456789", credits: "12345678901234567890.123456789", lineCount: "101" }]
  }) }));
  await mockActivity(browser);

  await browser.goto("/finance/general-ledger");
  await expect(browser.getByRole("heading", { name: "General Ledger activity" })).toBeVisible();
  await expect(browser.getByText("POSTED ACTIVITY · READ ONLY")).toBeVisible();
  await expect(browser.getByText("12345678901234567890.123456789", { exact: true })).toHaveCount(0);
  await expect(browser.getByText("12,345,678,901,234,567,890.123456789").first()).toBeVisible();
  await expect(browser.getByText("SYN-JRN-001 · #1")).toBeVisible();
  await expect(browser.getByText("CAPITAL_RECEIPT · 44444444-4444-4444-8444-444444444444")).toBeVisible();
  await expect(browser.getByRole("link", { name: "Open Finance inbox for source trace" })).toHaveAttribute("href", "/finance/handoffs");
  await expect(browser.getByRole("region", { name: "Line totals" })).toContainText(" · ");
  await expect(browser.getByRole("status").filter({ hasText: "Showing 1 of 101 lines" })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Load more lines" })).toBeVisible();
  await expect(browser.getByText(/Narrow the dates or account/)).toHaveCount(0);

  await browser.getByRole("combobox", { name: "Account" }).selectOption(accountId);
  const nextResponse = browser.waitForRequest((request) => request.url().includes("/api/v1/finance/general-ledger?") && request.url().includes(`accountId=${accountId}`));
  const nextActivity = browser.waitForRequest((request) => request.url().includes("/api/v1/finance/general-ledger/activity?") && request.url().includes(`accountId=${accountId}`));
  await browser.getByRole("button", { name: "Show activity" }).click();
  await nextResponse;
  await nextActivity;
  await browser.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(browser.getByRole("heading", { name: "فعالیت دفتر کل" })).toBeVisible();
  await browser.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(browser);
});

test("account activity is labelled as posted activity, never a balance, with currencies kept apart", async ({ page: browser }) => {
  await mockAccounts(browser);
  await browser.route("**/api/v1/finance/general-ledger?**", (route) => route.fulfill({ json: page([line(1)], {
    totals: [{ currency: "USD", debits: "1.25", credits: "0", lineCount: "1" }]
  }) }));
  await mockActivity(browser);
  await browser.goto("/finance/general-ledger");

  const summary = browser.getByRole("region", { name: "Account activity" });
  await expect(summary.getByRole("heading", { name: "Account activity in the selected range" })).toBeVisible();
  await expect(summary.getByRole("note")).toHaveText("Posted activity in the selected range — not a balance; opening balances are not yet imported.");
  await expect(summary).not.toContainText(/trial balance|closing balance|balance sheet/i);
  await expect(summary).toContainText(" · ");

  const usd = summary.getByRole("group", { name: "USD base-currency activity" });
  const afn = summary.getByRole("group", { name: "AFN base-currency activity" });
  await expect(usd).toContainText("Base currency USD · accounts 2 · lines 6");
  await expect(usd).toContainText("USD 12,345,678,901,234,567,890.123456789000000001");
  await expect(usd).toContainText("USD 12,345,678,901,234,567,890.023456789000000001");
  await expect(usd).toContainText("USD −12,345,678,901,234,567,890.023456789000000001");
  await expect(usd).toContainText("12,345,678,901,234,567,890.223456789000000001");
  await expect(usd).not.toContainText("AFN");
  await expect(afn).toContainText("AFN −98,765,432,109,876,543,210.987654321");
  await expect(afn).not.toContainText("USD");
  await expect(summary).toContainText("Each currency is shown separately; amounts are never added together or converted.");
  await expect(summary.getByText("12345678901234567890.123456789000000001", { exact: true })).toHaveCount(0);
  await expect(browser.getByRole("status").filter({ hasText: "All 1 lines shown." })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Load more lines" })).toHaveCount(0);

  await browser.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(browser.locator("html")).toHaveAttribute("dir", "rtl");
  const dari = browser.getByRole("region", { name: "فعالیت حساب‌ها" });
  await expect(dari.getByRole("heading", { name: "فعالیت هر حساب در بازهٔ انتخاب‌شده" })).toBeVisible();
  await expect(dari.getByRole("note")).toHaveText("فعالیت ثبت‌شده در بازهٔ انتخاب‌شده — مانده نیست؛ مانده‌های افتتاحیه هنوز وارد نشده‌اند.");
  await expect(dari.getByRole("group", { name: "فعالیت به ارز پایه AFN" })).toContainText("AFN −98,765,432,109,876,543,210.987654321");
  await browser.setViewportSize({ width: 390, height: 844 });
  await expect(dari).toBeVisible();
  await noHorizontalOverflow(browser);
  await browser.getByRole("button", { name: "Switch to English" }).click();
  await noHorizontalOverflow(browser);
});

test("Load more follows the cursor for the applied filters until every line is shown", async ({ page: browser }) => {
  await mockAccounts(browser);
  await mockActivity(browser);
  const firstPage = Array.from({ length: 100 }, (_, index) => line(index + 1));
  const secondPage = [line(101), line(102), line(103, { baseDebit: "0", baseCredit: "0.000000000000000001", originalAmount: "0.000000000000000001" })];
  const cursorRequests: string[] = [];
  await browser.route("**/api/v1/finance/general-ledger?**", (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) {
      return route.fulfill({ json: page(firstPage, {
        hasMore: true, nextCursor: "eyJ2IjoxfQ-_page2",
        totals: [{ currency: "USD", debits: "128.75", credits: "0.000000000000000001", lineCount: "103" }]
      }) });
    }
    cursorRequests.push(url.search);
    return route.fulfill({ json: page(secondPage, { hasMore: false, nextCursor: null, totals: null }) });
  });

  await browser.goto("/finance/general-ledger");
  const lines = browser.getByRole("region", { name: "Posted journal lines" }).locator("ol > li");
  await expect(lines).toHaveCount(100);
  await expect(browser.getByRole("status").filter({ hasText: "Showing 100 of 103 lines" })).toBeVisible();
  await browser.getByRole("button", { name: "Load more lines" }).click();
  await expect(lines).toHaveCount(103);
  await expect(browser.getByText("SYN-JRN-103 · #1")).toBeVisible();
  await expect(lines.last()).toContainText("SYN-JRN-103 · #1");
  await expect(lines.last().getByRole("definition").filter({ hasText: "USD 0.000000000000000001" })).toHaveCount(2);
  await expect(browser.getByRole("status").filter({ hasText: "All 103 lines shown." })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Load more lines" })).toHaveCount(0);
  expect(cursorRequests).toHaveLength(1);
  const params = new URLSearchParams(cursorRequests[0]);
  expect(params.get("cursor")).toBe("eyJ2IjoxfQ-_page2");
  expect(params.get("from")).toBe(day);
  expect(params.get("to")).toBe(day);
  // The line totals from the first page stay on screen after more lines are appended.
  await expect(browser.getByRole("region", { name: "Line totals" })).toContainText("128.75");

  await browser.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(browser.getByRole("status").filter({ hasText: "همهٔ 103 ردیف نمایش داده شد." })).toBeVisible();
  await browser.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(browser);
});

test("a refused page position shows an error and keeps the lines already shown", async ({ page: browser }) => {
  await mockAccounts(browser);
  await mockActivity(browser);
  await browser.route("**/api/v1/finance/general-ledger?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("cursor") === null) {
      return route.fulfill({ json: page([line(1)], { hasMore: true, nextCursor: "stale", totals: [{ currency: "USD", debits: "1.25", credits: "0", lineCount: "2" }] }) });
    }
    return route.fulfill({ status: 422, json: { ok: false, error: { code: "VALIDATION_FAILED", message: "The requested page position or range is not valid. Start again from the first page." } } });
  });
  await browser.goto("/finance/general-ledger");
  await browser.getByRole("button", { name: "Load more lines" }).click();
  await expect(browser.getByRole("alert").filter({ hasText: "Start again from the first page." })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Load more lines" })).toBeVisible();
  await expect(browser.getByText("SYN-JRN-001 · #1")).toBeVisible();
});

test("a denied Finance read does not display protected journal rows", async ({ page: browser }) => {
  await browser.route("**/api/v1/finance/accounts", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } } }));
  await browser.route("**/api/v1/finance/general-ledger?**", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } } }));
  await browser.route("**/api/v1/finance/general-ledger/activity?**", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } } }));
  await browser.goto("/finance/general-ledger");
  await expect(browser.getByText("Posted General Ledger activity requires the Finance operational report permission.")).toBeVisible();
  await expect(browser.getByText("SYN-JRN-001")).toHaveCount(0);
  await expect(browser.getByRole("region", { name: "Account activity" })).toHaveCount(0);
});
