import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The posting of receipts,
// transfers and payments is proven by the PostgreSQL suite (money-movements, 0047/0048).
const safeId = "73000000-0000-4000-8000-000000000001";
const sarafId = "73000000-0000-4000-8000-000000000002";
const afnId = "73000000-0000-4000-8000-000000000003";
const incomeId = "73000000-0000-4000-8000-000000000010";
const payableId = "73000000-0000-4000-8000-000000000011";
const categoryId = "73000000-0000-4000-8000-000000000012";
const partyId = "73000000-0000-4000-8000-000000000013";
const ALL = ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record", "finance.expense.create"];
const auth = (permissions: string[]) => ({ userAccountId: "73000000-0000-4000-8000-000000000004", loginIdentifier: "ui.money",
  displayName: "UI test Cashier", jobTitle: "Cashier", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });

const account = (id: string, nameEn: string, accountType: string, currencyCode: string, book: string) => ({
  id, nameEn, nameFa: nameEn === "Main Safe" ? "صندوق اصلی" : null, accountType, currencyCode, status: "ACTIVE", version: 1,
  ledgerAccount: { id: `${id}-ledger`, code: "C-01", name: "Cash" },
  balance: { opening: "0", inflows: book, outflows: "0", book, movementCount: book === "0" ? 0 : 1, lastMovementDate: null },
  openingBalance: null, responsibles: [], legacyLink: null,
  movements: [] as { journalId: string; date: string; direction: string; amount: string; sourceType: string; reference: string | null; restricted: boolean }[]
});
const workspace = () => ({
  today: "2026-10-27", baseCurrency: "USD", canRecordOpeningBalance: false, canManageSafes: false, canOpenLedger: false,
  openingEquity: { status: "MISSING" }, assignableUsers: [],
  safes: [account(safeId, "Main Safe", "SAFE", "USD", "500"), account(sarafId, "Saraf Hamid", "SARAF", "USD", "0"),
    account(afnId, "Afghani box", "CASH_BOX", "AFN", "0")]
});
type Settings = Record<string, "READY" | "APPROVAL_REQUIRED">;
// Owner decision of 2026-10-31: ordinary AFN movements need no FX difference account (MISSING here on purpose).
const fxReady = [{ currencyCode: "AFN", status: "READY", fxDifferenceStatus: "MISSING", policy: { versionId: null, version: 0, effectiveFrom: null,
  roundingMode: "HALF_UP", baseScale: 2, fxDifferenceAccountId: null, fxDifferenceStatus: "MISSING", isDefault: true } }];
const options = (settings: Settings = {}, can: Partial<Record<"canReceive" | "canTransfer" | "canPay" | "canRecordExpense", boolean>> = {},
  fx: readonly object[] = []) => ({
  baseCurrency: "USD", today: "2026-10-27", canReceive: true, canTransfer: true, canPay: true, canRecordExpense: true, ...can,
  settings: { OTHER_INCOME: "READY", TREASURY_TRANSFER: "READY", SUPPLIER_PAYMENT: "READY", SALARY_PAYMENT: "READY", ...settings },
  treasuryAccounts: [
    { id: afnId, nameEn: "Afghani box", nameFa: null, accountType: "CASH_BOX", currencyCode: "AFN" },
    { id: safeId, nameEn: "Main Safe", nameFa: "صندوق اصلی", accountType: "SAFE", currencyCode: "USD" },
    { id: sarafId, nameEn: "Saraf Hamid", nameFa: null, accountType: "SARAF", currencyCode: "USD" }],
  incomeAccounts: [{ id: incomeId, code: "R-900", name: "Other income" }],
  payableAccounts: [{ id: payableId, code: "L-200", name: "Accounts payable", requiresParty: true }],
  parties: [{ id: partyId, name: "Kabul Builders" }],
  fx
});
const none = { requiresProject: false, requiresDepartment: false, requiresCostCenter: false };
const expenseOptions = { expenseCategories: [{ id: categoryId, code: "EX-REPAIR", nameEn: "Repairs", nameFa: "ترمیمات", ...none },
  { id: "73000000-0000-4000-8000-000000000014", code: "EX-SITE", nameEn: "Site works", nameFa: "کارهای ساحه", ...none, requiresProject: true }],
  treasuryAccounts: [], payees: [], policyConfigured: true, approvalRequired: true };

async function mock(page: Page, setup: { permissions?: string[]; money?: ReturnType<typeof options> | null;
  refuse?: { status: number; code: string; message: string } } = {}) {
  const view = workspace();
  const commands: { url: string; body: Record<string, unknown> }[] = [];
  let workspaceReads = 0;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(setup.permissions ?? ALL) } }));
  await page.route("**/api/v1/finance/safes", async (route) => { workspaceReads += 1; await route.fulfill({ json: { ok: true, data: structuredClone(view) } }); });
  await page.route("**/api/v1/finance/operations/expense-options*", (route) => route.fulfill({ json: { ok: true, data: expenseOptions } }));
  const write = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push({ url: new URL(route.request().url()).pathname, body });
    if (setup.refuse) { await route.fulfill({ status: setup.refuse.status, json: { ok: false, error: { code: setup.refuse.code, message: setup.refuse.message } } }); return; }
    const amount = Number(body.amount ?? body.originalAmount);
    const move = (id: unknown, sign: number, sourceType: string) => {
      const target = view.safes.find((item) => item.id === id)!;
      target.balance = { ...target.balance, book: (Number(target.balance.book) + sign * amount).toFixed(2), movementCount: target.balance.movementCount + 1 };
      target.movements = [{ journalId: `j${commands.length}`, date: String(body.businessDate), direction: sign > 0 ? "IN" : "OUT", amount: amount.toFixed(2),
        sourceType, reference: `REF-${commands.length}`, restricted: false }, ...target.movements];
    };
    if (body.action === "receive-cash") move(body.treasuryAccountId, 1, "CASH_RECEIPT");
    if (body.action === "transfer") { move(body.sourceTreasuryAccountId, -1, "TREASURY_TRANSFER"); move(body.destinationTreasuryAccountId, 1, "TREASURY_TRANSFER"); }
    if (body.action === "pay-payable") move(body.treasuryAccountId, -1, "PAYMENT");
    if (body.expenseCategoryId) {
      await route.fulfill({ status: 201, json: { ok: true, data: { expense: { status: "PENDING_APPROVAL" } } } });
      return;
    }
    await route.fulfill({ status: 201, json: { ok: true, data: { movementId: "m1", journalId: "j1", reference: "RC-20261027-AB", status: "POSTED", replayed: false } } });
  };
  await page.route("**/api/v1/finance/money", async (route) => {
    if (route.request().method() === "GET") {
      if (setup.money === null) { await route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Not allowed" } } }); return; }
      await route.fulfill({ json: { ok: true, data: setup.money ?? options() } }); return;
    }
    await write(route);
  });
  await page.route("**/api/v1/finance/operations/expenses", write);
  return { commands, reads: () => workspaceReads };
}

test("@smoke cash received into a Safe is saved once and the book balance follows", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  const main = page.getByRole("region", { name: "Main Safe" });
  await main.getByRole("button", { name: "Receive cash" }).click();
  const form = page.getByRole("form", { name: "Receive cash — Main Safe" });
  await expect(form.getByLabel("Currency")).toHaveValue("USD");
  await expect(form.getByLabel("Date *")).toHaveAttribute("max", "2026-10-27");
  await form.getByLabel("Amount *").fill("150");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Or a name").fill("Walk-in tenant");
  await form.getByLabel("Income account *").selectOption(incomeId);
  await form.getByLabel("Reference (optional)").fill("Receipt 17");
  await form.getByRole("button", { name: "Save" }).dblclick();
  await expect(page.getByRole("status").filter({ hasText: "Money received and recorded." })).toBeVisible();
  await expect(main.getByLabel("Book balance")).toContainText("650.00 USD");
  await expect(main.getByRole("row").nth(1)).toContainText("Cash received");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ url: "/api/v1/finance/money", body: { action: "receive-cash", treasuryAccountId: safeId, amount: "150",
    currencyCode: "USD", businessDate: "2026-10-27", payerBusinessPartyId: null, payerName: "Walk-in tenant", revenueLedgerAccountId: incomeId,
    reference: "Receipt 17", note: null } });
  expect(String(commands[0]!.body.idempotencyKey)).toMatch(/^money-/);
  await expect(page.getByText(/posting intent|journal machinery|policy version|sandbox/i)).toHaveCount(0);
});

test("a transfer to a Saraf account moves both balances and offers only same-currency accounts", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  const main = page.getByRole("region", { name: "Main Safe" });
  await main.getByRole("button", { name: "Transfer" }).click();
  const form = page.getByRole("form", { name: "Transfer — Main Safe" });
  const destination = form.getByLabel("To which account? *");
  await expect(destination.locator("option")).toHaveText(["Choose", "Saraf Hamid · USD"]);
  await destination.selectOption(sarafId);
  await form.getByLabel("Amount *").fill("200.50");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transfer recorded." })).toBeVisible();
  await expect(main.getByLabel("Book balance")).toContainText("299.50 USD");
  await expect(page.getByRole("region", { name: "Saraf Hamid" }).getByLabel("Book balance")).toContainText("200.50 USD");
  expect(commands.map((command) => command.body)).toEqual([expect.objectContaining({ action: "transfer", sourceTreasuryAccountId: safeId,
    destinationTreasuryAccountId: sarafId, amount: "200.50", currencyCode: "USD" })]);
  // The Saraf account moves money back with the same form.
  await page.getByRole("region", { name: "Saraf Hamid" }).getByRole("button", { name: "Transfer" }).click();
  await expect(page.getByRole("form", { name: "Transfer — Saraf Hamid" }).getByLabel("To which account? *").locator("option"))
    .toHaveText(["Choose", "Main Safe · USD"]);
});

test("paying a salary that was owed posts against the payable account with its kind", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  const main = page.getByRole("region", { name: "Main Safe" });
  await main.getByRole("button", { name: "Pay" }).click();
  const form = page.getByRole("form", { name: "Pay — Main Safe" });
  await form.getByLabel("Kind of payment *").selectOption("SALARY");
  await form.getByLabel("Something we owed (a payable)").check();
  await form.getByLabel("Payable account *").selectOption(payableId);
  // Accounts payable is kept per supplier, so a typed name is not accepted for it.
  await expect(form.getByLabel("Or a name")).toBeDisabled();
  await expect(form).toContainText("choose the person or organization from the list");
  await form.getByLabel("To whom?").selectOption(partyId);
  await form.getByLabel("Amount *").fill("80");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Payment recorded." })).toBeVisible();
  await expect(main.getByLabel("Book balance")).toContainText("420.00 USD");
  expect(commands[0]).toMatchObject({ url: "/api/v1/finance/money", body: { action: "pay-payable", treasuryAccountId: safeId, paymentKind: "SALARY",
    payeeBusinessPartyId: partyId, payeeName: null, payableLedgerAccountId: payableId, amount: "80" } });
});

test("paying an expense goes through the expense lane with its kind and may wait for approval", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  await page.getByRole("region", { name: "Main Safe" }).getByRole("button", { name: "Pay" }).click();
  const form = page.getByRole("form", { name: "Pay — Main Safe" });
  await form.getByLabel("Kind of payment *").selectOption("OTHER");
  await expect(form.getByRole("status")).toContainText("will wait for approval");
  // Types that need a project are recorded on the full expense page, never here without one.
  await expect(form.getByLabel("Expense type *").locator("option")).toHaveText(["Choose", "Repairs"]);
  await expect(form.getByRole("link", { name: "Record expense" })).toHaveAttribute("href", "/finance/record-expense");
  await form.getByLabel("Expense type *").selectOption(categoryId);
  await form.getByLabel("Description *").fill("Door repair");
  await form.getByLabel("Amount *").fill("45");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Reference *").fill("INV-88");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "waiting for approval" })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ url: "/api/v1/finance/operations/expenses", body: { treasuryAccountId: safeId, expenseCategoryId: categoryId,
    description: "Door repair", reference: "INV-88", originalAmount: "45", currencyCode: "USD", businessDate: "2026-10-27", paymentKind: "OTHER" } });
});

test("an explicit approval-required setting blocks the save, and refusals keep the same request", async ({ page }) => {
  await mock(page, { money: options({ OTHER_INCOME: "APPROVAL_REQUIRED" }) });
  await page.goto("/finance/safes");
  await page.getByRole("region", { name: "Main Safe" }).getByRole("button", { name: "Receive cash" }).click();
  const blocked = page.getByRole("form", { name: "Receive cash — Main Safe" });
  await expect(blocked.getByRole("status")).toContainText("requires approval for this");
  await blocked.getByLabel("Amount *").fill("10");
  await blocked.getByLabel("Or a name").fill("Tenant");
  await blocked.getByLabel("Income account *").selectOption(incomeId);
  await expect(blocked.getByRole("button", { name: "Save" })).toBeDisabled();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const { commands } = await mock(page, { refuse: { status: 422, code: "PERIOD_CLOSED", message: "The month covering this date is closed. Choose another date." } });
  await page.reload();
  await page.getByRole("region", { name: "Main Safe" }).getByRole("button", { name: "Transfer" }).click();
  const form = page.getByRole("form", { name: "Transfer — Main Safe" });
  await form.getByLabel("To which account? *").selectOption(sarafId);
  await form.getByLabel("Amount *").fill("10");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("The month covering this date is closed.");
  await form.getByRole("button", { name: "Save" }).click();
  expect(commands).toHaveLength(2);
  expect(commands[1]!.body.idempotencyKey).toBe(commands[0]!.body.idempotencyKey);
});

test("a Safe shows what it holds, warns before overdrawing, and the database refusal is explained", async ({ page }) => {
  await mock(page, { refuse: { status: 422, code: "INSUFFICIENT_FUNDS",
    message: "The Safe does not hold enough money for this. A Safe, cash box or petty cash can never go below zero." } });
  await page.goto("/finance/safes");
  await page.getByRole("region", { name: "Main Safe" }).getByRole("button", { name: "Transfer" }).click();
  const form = page.getByRole("form", { name: "Transfer — Main Safe" });
  await expect(form).toContainText("Available in this Safe: 500 USD");
  await form.getByLabel("To which account? *").selectOption(sarafId);
  await form.getByLabel("Amount *").fill("500.01");
  await expect(form.getByRole("status")).toContainText("more than the Safe holds");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("can never go below zero");
  // A Saraf account may go below zero, so it shows no limit.
  await page.getByRole("region", { name: "Saraf Hamid" }).getByRole("button", { name: "Transfer" }).click();
  await expect(page.getByRole("form", { name: "Transfer — Saraf Hamid" })).not.toContainText("Available in this Safe");
});

test("without a movement permission, and on a currency the company holds no FX information for, no movement can be started", async ({ page }) => {
  await mock(page, { permissions: ["treasury.safe.read"], money: null });
  await page.goto("/finance/safes");
  await expect(page.getByRole("region", { name: "Main Safe" }).getByLabel("Book balance")).toContainText("500 USD");
  await expect(page.getByRole("button", { name: /Receive cash|Transfer|^Pay$/ })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { money: options({}, { canReceive: false, canPay: false, canRecordExpense: false }) });
  await page.reload();
  const main = page.getByRole("region", { name: "Main Safe" });
  await expect(main.getByRole("button", { name: "Transfer" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Receive cash" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Pay" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Afghani box" }).getByRole("button")).toHaveCount(0);
});

test("Dari labels and RTL remain usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/safes");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const main = page.getByRole("region", { name: "صندوق اصلی" });
  await main.getByRole("button", { name: "پرداخت" }).click();
  const form = page.getByRole("form", { name: "پرداخت — صندوق اصلی" });
  await expect(form.getByLabel("نوع پرداخت *")).toBeVisible();
  await expect(form.getByLabel("نوع مصرف *").locator("option")).toHaveText(["انتخاب کنید", "ترمیمات"]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

// 0051: AFN movements. The conversion itself (rate snapshot, rounding, accounting amount) is proven by fx-afn-posting.
const marketRate = "73000000-0000-4000-8000-000000000030";
const sarafRate = "73000000-0000-4000-8000-000000000031";
async function mockPreview(page: Page, setup: "READY" | "NO_RATE") {
  const asked: string[] = [];
  await page.route("**/api/v1/finance/fx-preview*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    asked.push(query.toString());
    const rates = [{ id: marketRate, source: "MARKET", sarafName: null, unitCurrency: "USD", quoteCurrency: "AFN", rate: "70" },
      { id: sarafRate, source: "SARAF", sarafName: "Saraf Hamid", unitCurrency: "USD", quoteCurrency: "AFN", rate: "72" }];
    const chosen = rates.find((item) => item.id === query.get("exchangeRateId"));
    const amount = Number(query.get("amount") ?? "0");
    await route.fulfill({ json: { ok: true, data: { currencyCode: "AFN", baseCurrency: "USD", businessDate: query.get("businessDate"),
      setup: fxReady[0],
      rates: setup === "READY" ? rates : [],
      preview: chosen && amount > 0 ? { exact: (amount / Number(chosen.rate)).toFixed(20), base: (amount / Number(chosen.rate)).toFixed(2),
        difference: "0", exchangeRateId: chosen.id } : null } } });
  });
  return asked;
}

test("an AFN box receives cash at the chosen rate of the day and shows the amount recorded in the books", async ({ page }) => {
  const { commands } = await mock(page, { money: options({}, {}, fxReady) });
  const asked = await mockPreview(page, "READY");
  await page.goto("/finance/safes");
  const box = page.getByRole("region", { name: "Afghani box" });
  await box.getByRole("button", { name: "Receive cash" }).click();
  const form = page.getByRole("form", { name: "Receive cash — Afghani box" });
  await expect(form.getByLabel("Currency")).toHaveValue("AFN");
  await form.getByLabel("Amount *").fill("7000");
  await form.getByLabel("Or a name").fill("Shop tenant");
  await form.getByLabel("Income account *").selectOption(incomeId);
  const save = form.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await form.getByLabel("Rate for this day *").selectOption(marketRate);
  const recorded = form.getByRole("status").filter({ hasText: "Recorded in the books as" });
  await expect(recorded).toContainText("100.00 USD");
  await expect(recorded).toContainText("rounded half up, 2 decimal places");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Money received and recorded." })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ url: "/api/v1/finance/money", body: { action: "receive-cash", treasuryAccountId: afnId, amount: "7000",
    currencyCode: "AFN", exchangeRateId: marketRate } });
  expect(asked.some((query) => query.includes("currencyCode=AFN") && query.includes("amount=7000"))).toBe(true);
});

test("an AFN form for a day without a recorded rate says to record it and cannot be saved", async ({ page }) => {
  const { commands } = await mock(page, { money: options({}, {}, fxReady) });
  await mockPreview(page, "NO_RATE");
  await page.goto("/finance/safes");
  await page.getByRole("region", { name: "Afghani box" }).getByRole("button", { name: "Receive cash" }).click();
  const form = page.getByRole("form", { name: "Receive cash — Afghani box" });
  await form.getByLabel("Amount *").fill("7000");
  await form.getByLabel("Or a name").fill("Shop tenant");
  await form.getByLabel("Income account *").selectOption(incomeId);
  await expect(form.getByRole("note").filter({ hasText: "No AFN rate is recorded for 2026-10-27" })).toBeVisible();
  await expect(form.getByRole("link", { name: "Exchange rates" })).toHaveAttribute("href", "/finance/exchange-rates");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(commands).toHaveLength(0);
});
