import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The REVERSAL posting itself
// (exact inverse, link, date policy, segregation of duties) is proven by periods-and-reversals (0050).
const paymentId = "76000000-0000-4000-8000-000000000001";
const ownId = "76000000-0000-4000-8000-000000000002";
const closedId = "76000000-0000-4000-8000-000000000003";
const requestId = "76000000-0000-4000-8000-000000000004";
const auth = (permissions: string[]) => ({ userAccountId: "76000000-0000-4000-8000-000000000009", loginIdentifier: "ui.reversals",
  displayName: "UI test Accountant", jobTitle: "Accountant", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const journal = (id: string, reference: string, extra: object = {}) => ({ id, reference, date: "2026-10-12", sourceType: "PAYMENT", amount: "120.00",
  currency: "USD", postedBy: "UI test Cashier", periodStatus: "OPEN", blocker: null, viewerIsParticipant: false, reversal: null,
  lines: [{ lineNumber: 1, accountCode: "L-200", accountName: "Accounts payable", debit: "120.00", credit: "0" },
    { lineNumber: 2, accountCode: "C-01", accountName: "Cash", debit: "0", credit: "120.00" }], ...extra });
const workspace = (approval = false) => ({ today: "2026-10-28", approvalRequired: approval, canReverseDirectly: !approval, canRequest: true, canApprove: true,
  journals: [journal(paymentId, "PY-20261012-AAA"), journal(ownId, "RC-20261013-BBB", { sourceType: "CASH_RECEIPT", viewerIsParticipant: true }),
    journal(closedId, "PY-20260912-CCC", { date: "2026-09-12", periodStatus: "CLOSED" })],
  requests: [] as object[] });

async function mock(page: Page, options: { approval?: boolean; refuse?: { status: number; code: string; message: string } } = {}) {
  const view = workspace(options.approval);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.reversal.direct", "finance.reversal.request", "finance.reversal.approve"]) } }));
  await page.route("**/api/v1/finance/journal-reversals", async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (options.refuse) { await route.fulfill({ status: options.refuse.status, json: { ok: false, error: { code: options.refuse.code, message: options.refuse.message } } }); return; }
    const target = view.journals.find((j) => j.id === body.journalId);
    if (body.action === "reverse" && target) target.reversal = { journalId: "rv", reference: "RV-20261012-DDD", date: target.date, reason: String(body.reason) } as never;
    if (body.action === "request" && target) { target.blocker = "OPEN_REQUEST" as never;
      view.requests = [{ id: requestId, journalId: target.id, journalReference: target.reference, status: "REQUESTED", reason: body.reason, version: 1,
        requestedBy: "UI test Accountant", requestedAt: "2026-10-28T06:00:00Z", decidedBy: null, decidedAt: null, decisionNote: null,
        viewerIsRequester: true, viewerIsParticipant: false, reversalJournalId: null }]; }
    await route.fulfill({ status: 201, json: { ok: true, data: { result: { status: "POSTED", replayed: false }, workspace: structuredClone(view) } } });
  });
  return { view, commands };
}

test("@smoke Simple Mode reverses a payment directly with a reason, showing the inverted lines first", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/reversals");
  await expect(page.getByText("Simple mode: a permitted person reverses directly")).toBeVisible();
  const row = page.getByRole("row", { name: /PY-20261012-AAA/ });
  await row.getByRole("button", { name: "Reverse" }).click();
  const form = page.getByRole("form", { name: "Reverse PY-20261012-AAA" });
  await expect(form).toContainText("Dr 120.00 → Cr 120.00");
  await expect(form).toContainText("The reversal posts on the same date, 2026-10-12.");
  await form.getByLabel("Reason *").fill("short");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Reason *").fill("Paid the wrong supplier by mistake");
  await form.getByRole("button", { name: "Save" }).dblclick();
  await expect(page.getByRole("status")).toContainText("Reversal posted.");
  await expect(row).toContainText("Reversed: RV-20261012-DDD");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ action: "reverse", journalId: paymentId, reason: "Paid the wrong supplier by mistake" });
  expect(String(commands[0]!.idempotencyKey)).toMatch(/^reversal-/);
});

test("Simple Mode lets the recorder correct their own entry as a self-correction; a closed month reverses today", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/reversals");
  await page.getByRole("row", { name: /RC-20261013-BBB/ }).getByRole("button", { name: "Reverse" }).click();
  await expect(page.getByRole("form", { name: "Reverse RC-20261013-BBB" })).toContainText("recorded in the audit trail as a self-correction");
  await page.getByRole("form", { name: "Reverse RC-20261013-BBB" }).getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("row", { name: /PY-20260912-CCC/ }).getByRole("button", { name: "Reverse" }).click();
  await expect(page.getByRole("form", { name: "Reverse PY-20260912-CCC" })).toContainText("Its month is closed: the reversal posts today (2026-10-28)");
});

test("with approvals on, the person who recorded a transaction can neither reverse it nor ask for its reversal", async ({ page }) => {
  await mock(page, { approval: true });
  await page.goto("/finance/reversals");
  const own = page.getByRole("row", { name: /RC-20261013-BBB/ });
  await expect(own).toContainText("You recorded it; with approvals on, another person must reverse it");
  await expect(own.getByRole("button")).toHaveCount(0);
});

test("Advanced Mode requests a reversal; the requester may only withdraw; refusals are explained", async ({ page }) => {
  const { commands } = await mock(page, { approval: true });
  await page.goto("/finance/reversals");
  await expect(page.getByText("Advanced controls: every reversal is requested")).toBeVisible();
  await page.getByRole("row", { name: /PY-20261012-AAA/ }).getByRole("button", { name: "Request reversal" }).click();
  await page.getByRole("form", { name: "Reverse PY-20261012-AAA" }).getByLabel("Reason *").fill("Duplicate supplier payment");
  await page.getByRole("form", { name: "Reverse PY-20261012-AAA" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("another person approves it");
  expect(commands[0]).toMatchObject({ action: "request", journalId: paymentId });
  const requests = page.locator(".reversal-requests");
  await expect(requests.getByRole("button", { name: "Withdraw" })).toBeVisible();
  await expect(requests.getByRole("button", { name: "Approve and post" })).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { refuse: { status: 422, code: "INSUFFICIENT_FUNDS", message: "Reversing this would take the Safe below zero. A Safe, cash box or petty cash can never go below zero." } });
  await page.reload();
  await page.getByRole("row", { name: /PY-20261012-AAA/ }).getByRole("button", { name: "Reverse" }).click();
  await page.getByRole("form", { name: "Reverse PY-20261012-AAA" }).getByLabel("Reason *").fill("Received from the wrong payer");
  await page.getByRole("form", { name: "Reverse PY-20261012-AAA" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "below zero" })).toBeVisible();
});

test("Dari labels and RTL remain usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/reversals");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "برگشت ژورنال‌ها" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
