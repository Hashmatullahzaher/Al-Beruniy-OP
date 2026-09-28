import { expect, test } from "@playwright/test";

const day = new Date().toISOString().slice(0, 10);
const journalId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";

test("posted GL preview preserves exact decimal text, both calendars, source and account filters", async ({ page }) => {
  await page.route("**/api/v1/finance/accounts", (route) => route.fulfill({ json: {
    ok: true, data: { accounts: [{ id: accountId, code: "SYN-101", name: "Synthetic safe cash", nameFa: "نقد مصنوعی" }] }
  } }));
  await page.route("**/api/v1/finance/general-ledger?**", (route) => route.fulfill({ json: {
    ok: true,
    data: {
      syntheticOnly: true, legalEntityId: "33333333-3333-4333-8333-333333333333",
      from: day, to: day, accountId: null, pageLimit: 100, returnedLineCount: 1, hasMore: true,
      totals: [{ currency: "USD", debits: "12345678901234567890.123456789", credits: "12345678901234567890.123456789", lineCount: "101" }],
      lines: [{
        journalId, journalReference: "SYN-JRN-001", lineNumber: 1, accountId,
        accountCode: "SYN-101", accountName: "Synthetic safe cash",
        sourceType: "CAPITAL_RECEIPT", sourceId: "44444444-4444-4444-8444-444444444444",
        accountingPeriodId: "55555555-5555-4555-8555-555555555555",
        accountingEffectiveDate: day, postedAt: `${day}T09:00:00Z`,
        originalCurrency: "USD", originalAmount: "12345678901234567890.123456789",
        baseCurrency: "USD", baseDebit: "12345678901234567890.123456789", baseCredit: "0"
      }]
    }
  } }));

  await page.goto("/finance/general-ledger");
  await expect(page.getByRole("heading", { name: "General Ledger activity" })).toBeVisible();
  await expect(page.getByText("SYNTHETIC DATA · OPERATIONAL PREVIEW")).toBeVisible();
  await expect(page.getByText("12345678901234567890.123456789", { exact: true })).toHaveCount(0);
  await expect(page.getByText("12,345,678,901,234,567,890.123456789").first()).toBeVisible();
  await expect(page.getByText("SYN-JRN-001 · #1")).toBeVisible();
  await expect(page.getByText("CAPITAL_RECEIPT · 44444444-4444-4444-8444-444444444444")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Finance inbox for source trace" })).toHaveAttribute("href", "/finance/handoffs");
  await expect(page.getByRole("region", { name: "Line totals" })).toContainText(" · ");
  await expect(page.getByRole("note", { name: "" }).filter({ hasText: "Showing only the newest 1 lines" })).toBeVisible();

  await page.getByRole("combobox", { name: "Account" }).selectOption(accountId);
  const nextResponse = page.waitForRequest((request) => request.url().includes("/api/v1/finance/general-ledger?") && request.url().includes(`accountId=${accountId}`));
  await page.getByRole("button", { name: "Show activity" }).click();
  await nextResponse;
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { name: "فعالیت دفتر کل" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("a denied Finance read does not display protected journal rows", async ({ page }) => {
  await page.route("**/api/v1/finance/accounts", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } } }));
  await page.route("**/api/v1/finance/general-ledger?**", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } } }));
  await page.goto("/finance/general-ledger");
  await expect(page.getByText("Posted General Ledger activity requires the Finance operational report permission.")).toBeVisible();
  await expect(page.getByText("SYN-JRN-001")).toHaveCount(0);
});
