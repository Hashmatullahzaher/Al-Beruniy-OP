import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The year close and its database rules are
// proven by the PostgreSQL suite (financial-year-close, 0052).
const fy2025 = "76000000-0000-4000-8000-000000000001";
const fy2026 = "76000000-0000-4000-8000-000000000002";
const auth = (permissions: string[]) => ({ userAccountId: "76000000-0000-4000-8000-000000000009", loginIdentifier: "ui.year",
  displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const year = (id: string, label: string, labelFa: string, startsOn: string, endsOn: string) => ({ id, label, labelFa, calendarKind: "GREGORIAN",
  startsOn, endsOn, status: "ACTIVE", closedAt: null as string | null, closedBy: null as string | null, postedJournals: 12, months: [] as object[] });
const workspace = (canClose = true) => ({ today: "2026-10-31", canClose,
  years: [year(fy2026, "FY 2026", "سال مالی ۲۰۲۶", "2026-01-01", "2026-12-31"), year(fy2025, "FY 2025", "سال مالی ۲۰۲۵", "2025-01-01", "2025-12-31")] });
const preview = (y: ReturnType<typeof year>) => ({ year: y, summary: { postedJournals: 12, debits: "8400.00", credits: "8400.00" }, unpostedJournals: 0,
  pending: { expensesAwaitingApproval: 1, reversalRequests: 0, temporaryFundingDecisions: 0 }, warnings: [] as string[] });

async function mock(page: Page, options: { canClose?: boolean; refuse?: { status: number; code: string; message: string } } = {}) {
  const view = workspace(options.canClose);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(
    options.canClose === false ? ["finance.report.operational.read"] : ["finance.period.manage"]) } }));
  await page.route("**/api/v1/finance/financial-years/*/close-preview", (route) => {
    const target = view.years.find((y) => route.request().url().includes(y.id))!;
    return route.fulfill({ json: { ok: true, data: preview(target) } });
  });
  await page.route("**/api/v1/finance/financial-years", async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (options.refuse) { await route.fulfill({ status: options.refuse.status, json: { ok: false, error: { code: options.refuse.code, message: options.refuse.message } } }); return; }
    const target = view.years.find((y) => y.id === body.fiscalYearId)!;
    Object.assign(target, { status: "CLOSED", closedBy: "UI test Finance Manager", closedAt: "2026-10-31T06:00:00Z" });
    await route.fulfill({ json: { ok: true, data: { result: { fiscalYearId: target.id, status: "CLOSED", replayed: false, year: target }, workspace: structuredClone(view) } } });
  });
  return { view, commands };
}

test("@smoke the financial year page offers a year close only, never a month close or reopen", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/financial-year");
  await expect(page.getByRole("heading", { name: "Financial year", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: /FY 2026/ })).toContainText("Active");
  await expect(page.getByRole("button", { name: /month/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /reopen/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Financial year" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Financial periods" })).toHaveCount(0);
});

test("closing a financial year shows its summary and pending items first, then marks it closed", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/financial-year");
  const row = page.getByRole("row", { name: /FY 2025/ });
  await row.getByRole("button", { name: "Close financial year" }).click();
  const confirm = page.getByRole("region", { name: "Close financial year FY 2025" });
  await expect(confirm).toContainText("8400.00");
  await expect(confirm).toContainText("Expenses waiting for approval: 1");
  await expect(confirm).toContainText("Closing a financial year is final.");
  expect(commands).toHaveLength(0);
  await confirm.getByRole("button", { name: "Confirm financial year close" }).click();
  await expect(page.getByRole("status")).toContainText("Financial year FY 2025 closed.");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ fiscalYearId: fy2025 });
  expect(typeof commands[0]!.correlationId).toBe("string");
  await expect(row).toContainText("Closed");
  await expect(row).toContainText("Closed by UI test Finance Manager");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("a reader sees the years but cannot close; the old periods address lands on the financial year page", async ({ page }) => {
  await mock(page, { canClose: false });
  await page.goto("/finance/periods");
  await expect(page).toHaveURL(/\/finance\/financial-year$/);
  await expect(page.getByRole("row", { name: /FY 2026/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close financial year" })).toHaveCount(0);
});

test("refusals are shown in business language; Dari and RTL work at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, { refuse: { status: 422, code: "UNPOSTED_JOURNAL", message: "The financial year has a journal that is not posted, so it cannot be closed." } });
  await page.goto("/finance/financial-year");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("row", { name: /سال مالی ۲۰۲۵/ }).getByRole("button", { name: "بستن سال مالی" }).click();
  await page.getByRole("button", { name: "تأیید بستن سال مالی" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ثبت نهایی نشده" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
