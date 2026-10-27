import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password or financial writes. The database behaviour of
// opening balances and derived balances is proven by the PostgreSQL suites (0045/0046).
const safeId = "72000000-0000-4000-8000-000000000001";
const pettyId = "72000000-0000-4000-8000-000000000002";
const endpoint = "**/api/v1/finance/safes";
const auth = (permissions: string[]) => ({ userAccountId: "72000000-0000-4000-8000-000000000003", loginIdentifier: "ui.safes",
  displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions,
  sessionExpiresAt: "2099-01-01T00:00:00Z" });
const ALL = ["treasury.safe.read", "treasury.opening-balance.record", "treasury.operational-account.manage", "finance.report.operational.read"];

type Money = { opening: string; inflows: string; outflows: string; book: string; movementCount: number; lastMovementDate: string | null };
const safe = (id: string, name: string, balance: Partial<Money> = {}) => ({
  id, nameEn: name, nameFa: name === "Main Safe" ? "صندوق اصلی" : null, accountType: "SAFE", currencyCode: "USD", status: "ACTIVE", version: 1,
  ledgerAccount: { id: `${id}-ledger`, code: "C-01", name: "Cash" },
  balance: { opening: "0", inflows: "0", outflows: "0", book: "0", movementCount: 0, lastMovementDate: null, ...balance },
  openingBalance: null as null | Record<string, unknown>, responsibles: [] as { userAccountId: string; displayName: string }[],
  legacyLink: null as null | { locationName: string; activationStatus: string },
  movements: [] as { journalId: string; date: string; direction: string; amount: string; sourceType: string; reference: string | null; restricted: boolean }[]
});
const workspace = () => ({
  today: "2026-10-27", baseCurrency: "USD", canRecordOpeningBalance: true, canManageSafes: true, canOpenLedger: true,
  openingEquity: { status: "READY", account: { id: "obe", code: "E-OB", name: "Opening balance equity", currency: "USD" } },
  safes: [
    { ...safe(safeId, "Main Safe", { inflows: "1000", outflows: "125.50", book: "874.50", movementCount: 2, lastMovementDate: "2026-10-20" }),
      legacyLink: { locationName: "کسه", activationStatus: "DRAFT" },
      movements: [
        { journalId: "j2", date: "2026-10-20", direction: "OUT", amount: "125.50", sourceType: "OPERATIONAL_EXPENSE", reference: null, restricted: true },
        { journalId: "j1", date: "2026-10-18", direction: "IN", amount: "1000", sourceType: "DIRECT_SHAREHOLDER_CAPITAL", reference: "CAP-20261018-AB", restricted: false }] },
    safe(pettyId, "Petty cash box")],
  assignableUsers: [{ userAccountId: "72000000-0000-4000-8000-000000000003", displayName: "UI test Finance Manager" }]
});

async function mock(page: Page, options: { permissions?: string[]; view?: ReturnType<typeof workspace>; refuse?: { status: number; code: string; message: string } } = {}) {
  const view = options.view ?? workspace();
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(options.permissions ?? ALL) } }));
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (options.refuse) { await route.fulfill({ status: options.refuse.status, json: { ok: false, error: { code: options.refuse.code, message: options.refuse.message } } }); return; }
    const target = view.safes.find((item) => item.id === body.treasuryAccountId)!;
    if (body.action === "record-opening-balance") {
      target.openingBalance = { id: "ob1", amount: body.amount, currencyCode: "USD", asOfDate: body.asOfDate, reference: body.reference,
        note: body.note, transactionReference: "OB-20261001-XYZ", journalId: "j0", recordedAt: "2026-10-27T05:00:00Z" };
      const amount = Number(body.amount);
      target.balance = { ...target.balance, opening: String(body.amount), book: (Number(target.balance.book) + amount).toFixed(2), movementCount: target.balance.movementCount + 1 };
      target.movements = [...target.movements, { journalId: "j0", date: String(body.asOfDate), direction: "IN", amount: String(body.amount), sourceType: "OPENING_BALANCE", reference: "OB-20261001-XYZ", restricted: false }];
      await route.fulfill({ status: 201, json: { ok: true, data: { openingBalanceId: "ob1", journalId: "j0", reference: "OB-20261001-XYZ", status: "POSTED", replayed: false, workspace: structuredClone(view) } } });
    } else {
      target.responsibles = (body.userAccountIds as string[]).map((id) => ({ userAccountId: id, displayName: "UI test Finance Manager" }));
      await route.fulfill({ json: { ok: true, data: { workspace: structuredClone(view) } } });
    }
  });
  return { view, commands };
}

test("@smoke Safes show the real book balance, opening balance state and movements", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/safes");
  const main = page.getByRole("region", { name: "Main Safe" });
  await expect(main.getByLabel("Book balance")).toContainText("874.50 USD");
  await expect(main).toContainText("Money in");
  await expect(main).toContainText("1,000 USD");
  await expect(main).toContainText("125.50 USD");
  await expect(main).toContainText("No opening balance has been recorded yet.");
  await expect(main).toContainText("Same Safe in the old records: “کسه”");
  const rows = main.getByRole("row");
  await expect(rows.nth(1)).toContainText("Expense");
  await expect(rows.nth(1)).toContainText("Details outside your scope");
  await expect(rows.nth(2)).toContainText("Shareholder capital");
  await expect(main.getByRole("link", { name: "CAP-20261018-AB" })).toHaveAttribute("href", "/finance/general-ledger");
  await expect(page.getByText(/posting intent|journal machinery|policy version|sandbox/i)).toHaveCount(0);
});

test("an opening balance is saved once with the Safe's currency fixed and one request identity", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  const main = page.getByRole("region", { name: "Main Safe" });
  await main.getByRole("button", { name: "Set opening balance" }).click();
  const form = page.getByRole("form", { name: "Opening balance of Main Safe" });
  await expect(form.getByLabel("Currency")).toHaveValue("USD");
  await expect(form.getByLabel("Currency")).toHaveAttribute("readonly", "");
  await expect(form.getByLabel("As of *")).toHaveAttribute("max", "2026-10-27");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Amount *").fill("2,500");
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Amount *").fill("2500.00");
  await form.getByLabel("As of *").fill("2026-10-01");
  await form.getByLabel("Reference (optional)").fill("Counted on day one");
  await form.getByRole("button", { name: "Save" }).dblclick();
  await expect(page.getByRole("status")).toContainText("Opening balance recorded");
  await expect(main.getByLabel("Book balance")).toContainText("3,374.50 USD");
  await expect(main).toContainText("Opening balance recorded: 2,500.00 USD as of 2026-10-01 · Counted on day one");
  await expect(main.getByRole("button", { name: "Set opening balance" })).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ action: "record-opening-balance", treasuryAccountId: safeId, amount: "2500.00", currencyCode: "USD",
    asOfDate: "2026-10-01", reference: "Counted on day one", note: null });
  expect(String(commands[0]!.idempotencyKey)).toMatch(/^opening-/);
});

test("refusals are shown in business language and the form keeps its request", async ({ page }) => {
  const { commands } = await mock(page, { refuse: { status: 409, code: "OPENING_EXISTS",
    message: "This Safe already has an opening balance. A posted opening balance is corrected by reversal, never edited." } });
  await page.goto("/finance/safes");
  await page.getByRole("region", { name: "Main Safe" }).getByRole("button", { name: "Set opening balance" }).click();
  const form = page.getByRole("form", { name: "Opening balance of Main Safe" });
  await form.getByLabel("Amount *").fill("10");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "corrected by reversal" })).toBeVisible();
  await form.getByRole("button", { name: "Save" }).click();
  expect(commands).toHaveLength(2);
  expect(commands[1]!.idempotencyKey).toBe(commands[0]!.idempotencyKey);
});

test("without opening balance equity, or without the permission, no opening balance can be started", async ({ page }) => {
  const view = workspace();
  view.openingEquity = { status: "MISSING" } as typeof view.openingEquity;
  await mock(page, { view });
  await page.goto("/finance/safes");
  await expect(page.getByText("Opening balances are not ready yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Chart of Accounts" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Set opening balance" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const readOnly = workspace(); readOnly.canRecordOpeningBalance = false; readOnly.canManageSafes = false;
  await mock(page, { permissions: ["treasury.safe.read"], view: readOnly });
  await page.reload();
  await expect(page.getByRole("region", { name: "Main Safe" }).getByLabel("Book balance")).toContainText("874.50 USD");
  await expect(page.getByRole("button", { name: "Set opening balance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change" })).toHaveCount(0);
});

test("responsible people are optional and saved without creating another Safe", async ({ page }) => {
  const { commands } = await mock(page);
  await page.goto("/finance/safes");
  const petty = page.getByRole("region", { name: "Petty cash box" });
  await expect(petty).toContainText("Not assigned (optional)");
  await petty.getByRole("button", { name: "Change" }).click();
  await petty.getByRole("checkbox", { name: "UI test Finance Manager" }).check();
  await petty.getByRole("button", { name: "Save" }).click();
  await expect(petty).toContainText("Responsible: UI test Finance Manager");
  expect(commands).toEqual([{ action: "set-responsibles", treasuryAccountId: pettyId, userAccountIds: ["72000000-0000-4000-8000-000000000003"] }]);
  await expect(page.getByRole("region")).toHaveCount(2);
});

test("signed-out and denied readers see a boundary, not a balance", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in" } } }));
  await page.route(endpoint, (route) => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in" } } }));
  await page.goto("/finance/safes");
  await expect(page.getByText("Sign in first")).toBeVisible();
  await expect(page.getByText("USD")).toHaveCount(0);
});

test("Dari labels and RTL remain usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/safes");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const main = page.getByRole("region", { name: "صندوق اصلی" });
  await expect(main.getByLabel("موجودی دفتری")).toContainText("874.50 USD");
  await expect(main).toContainText("ورودی");
  await main.getByRole("button", { name: "ثبت موجودی افتتاحیه" }).click();
  await expect(page.getByRole("form", { name: "موجودی افتتاحیهٔ صندوق اصلی" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
