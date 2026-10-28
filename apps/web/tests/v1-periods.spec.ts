import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. Closing, reopening and their
// database rules are proven by the PostgreSQL suite (periods-and-reversals, 0050).
const septId = "75000000-0000-4000-8000-000000000001";
const octId = "75000000-0000-4000-8000-000000000002";
const requestId = "75000000-0000-4000-8000-000000000003";
const auth = (permissions: string[]) => ({ userAccountId: "75000000-0000-4000-8000-000000000009", loginIdentifier: "ui.periods",
  displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const period = (id: string, name: string, status: string, extra: object = {}) => ({ id, name, nameFa: name === "2026-09" ? "سنبله" : "میزان",
  startsOn: `${name}-01`, endsOn: name === "2026-09" ? "2026-09-30" : "2026-10-31", status, version: 2, openedBy: "UI test Finance Manager",
  openedAt: "2026-09-01T05:00:00Z", closedBy: null, closedAt: null, reopenCount: 0, postedJournals: 4, reopenRequest: null, ...extra });
const workspace = (second = false) => ({ today: "2026-10-28", reopenNeedsSecondPerson: second, canClose: true, canReopen: true,
  periods: [period(septId, "2026-09", "OPEN"), period(octId, "2026-10", "OPEN")], history: [] as object[] });
const preview = { period: { id: septId, name: "2026-09", nameFa: "سنبله", startsOn: "2026-09-01", endsOn: "2026-09-30", status: "OPEN", version: 2 },
  summary: { postedJournals: 4, debits: "1250.00", credits: "1250.00" }, unpostedJournals: 0,
  pending: { expensesAwaitingApproval: 1, reversalRequests: 0, temporaryFundingDecisions: 0 }, warnings: ["EARLIER_MONTH_OPEN"] };

async function mock(page: Page, options: { second?: boolean; refuse?: { status: number; code: string; message: string } } = {}) {
  const view = workspace(options.second);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.period.manage", "finance.period.reopen"]) } }));
  await page.route(`**/api/v1/finance/periods/${septId}/close-preview`, (route) => route.fulfill({ json: { ok: true, data: preview } }));
  await page.route("**/api/v1/finance/periods", async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (options.refuse) { await route.fulfill({ status: options.refuse.status, json: { ok: false, error: { code: options.refuse.code, message: options.refuse.message } } }); return; }
    const sept = view.periods[0]!;
    if (body.action === "close") Object.assign(sept, { status: "CLOSED", closedBy: "UI test Finance Manager", version: 3 });
    if (body.action === "reopen") { Object.assign(sept, { status: "OPEN", closedBy: null, reopenCount: 1, version: 4 });
      view.history = [{ periodName: "2026-09", periodNameFa: "سنبله", action: "REOPENED", fromStatus: "CLOSED", toStatus: "OPEN", reason: body.reason,
        actor: "UI test Finance Manager", at: "2026-10-28T06:00:00Z" }]; }
    if (body.action === "request-reopen") Object.assign(sept, { reopenRequest: { id: requestId, reason: body.reason, version: 1,
      requestedBy: "UI test Finance Manager", requestedAt: "2026-10-28T06:00:00Z", viewerIsRequester: true } });
    await route.fulfill({ json: { ok: true, data: { result: {}, workspace: structuredClone(view) } } });
  });
  return { view, commands };
}

test("@smoke closing a month shows its summary, pending items and warnings before it is confirmed", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/periods");
  const row = page.getByRole("row", { name: /2026-09/ });
  await row.getByRole("button", { name: "Close month" }).click();
  const confirm = page.getByRole("region", { name: "Close 2026-09" });
  await expect(confirm).toContainText("Posted journals");
  await expect(confirm).toContainText("1250.00");
  await expect(confirm).toContainText("Expenses waiting for approval: 1");
  await expect(confirm).toContainText("An earlier month is still open.");
  expect(commands).toHaveLength(0);
  await confirm.getByRole("button", { name: "Confirm close" }).click();
  await expect(page.getByRole("status")).toContainText("Month closed.");
  expect(commands).toEqual([{ action: "close", periodId: septId, expectedVersion: 2 }]);
  await expect(row).toContainText("Closed");
});

test("Simple Mode reopens with a mandatory reason and keeps the history", async ({ page }) => {
  const { view, commands } = await mock(page);
  Object.assign(view.periods[0]!, { status: "CLOSED", closedBy: "UI test Finance Manager" });
  await page.goto("/finance/periods");
  await page.getByRole("row", { name: /2026-09/ }).getByRole("button", { name: "Reopen" }).click();
  const form = page.getByRole("form", { name: "Reopen 2026-09" });
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Reason for reopening *").fill("Late supplier invoice");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Month reopened.");
  expect(commands[0]).toMatchObject({ action: "reopen", periodId: septId, reason: "Late supplier invoice" });
  await expect(page.getByText("Late supplier invoice")).toBeVisible();
});

test("Advanced Mode asks for a reopen; the asker can only withdraw it", async ({ page }) => {
  const { view, commands } = await mock(page, { second: true });
  Object.assign(view.periods[0]!, { status: "CLOSED" });
  await page.goto("/finance/periods");
  await expect(page.getByText("reopening a closed month is requested by one person and confirmed by another")).toBeVisible();
  await page.getByRole("row", { name: /2026-09/ }).getByRole("button", { name: "Request reopen" }).click();
  await page.getByRole("form", { name: "Reopen 2026-09" }).getByLabel("Reason for reopening *").fill("Late supplier invoice");
  await page.getByRole("form", { name: "Reopen 2026-09" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("another person confirms it");
  expect(commands[0]).toMatchObject({ action: "request-reopen" });
  const row = page.getByRole("row", { name: /2026-09/ });
  await expect(row.getByRole("button", { name: "Withdraw" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Confirm reopen" })).toHaveCount(0);
});

test("refusals are shown in business language; Dari and RTL work at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, { refuse: { status: 422, code: "UNPOSTED_JOURNAL", message: "The month has a journal that is not posted, so it cannot be closed." } });
  await page.goto("/finance/periods");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("row", { name: /سنبله/ }).getByRole("button", { name: "بستن ماه" }).click();
  await page.getByRole("button", { name: "تأیید بستن" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ثبت نهایی نشده" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
