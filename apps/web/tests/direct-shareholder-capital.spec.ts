import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password, document vault or financial writes.
const shareholderId = "71000000-0000-4000-8000-000000000001";
const safeId = "71000000-0000-4000-8000-000000000002";
const expenseAccountId = "71000000-0000-4000-8000-000000000005";
const endpoint = "**/api/v1/shareholder/capital";
const auth = { userAccountId: "71000000-0000-4000-8000-000000000003", loginIdentifier: "ui.test", displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions: ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
type Capital = { currency: string; contributed: string; agreedTotal: string | null; remaining: string | null };
type Entry = { id: string; date: string; amount: string; currency: string; method: string; destination: string | null; providerName: string | null; itemDescription: string | null; debitAccount: string | null; reference: string; status: "POSTED"; journalId: string; note: string | null; paymentReference: string | null };
const initial = () => ({
  legalEntity: { id: "71000000-0000-4000-8000-000000000004", name: "UI test company", baseCurrency: "USD" },
  permissions: { canManage: true, canReceive: true }, currencies: [{ code: "USD", label: "USD" }, { code: "AFN", label: "AFN" }],
  destinations: [{ id: safeId, name: "UI test USD Safe", currency: "USD", balance: "0.00" }, { id: "afn-safe", name: "UI test AFN Safe", currency: "AFN", balance: "0.00" }],
  expenseAccounts: [{ id: expenseAccountId, code: "5100", name: "UI test fuel" }],
  assetAccountReady: true,
  shareholders: [] as {
    id: string; name: string; reference: string | null; note: string | null; active: boolean;
    capitals: Capital[]; transactions: Entry[]; documents: { id: string; fileName: string; version: number }[];
  }[], receiveAvailable: true, unavailableReason: null as string | null
});

function cents(amount: string) { const [whole = "0", decimal = ""] = amount.split("."); return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0")); }
function amount(value: bigint) { return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`; }

async function mockWorkspace(page: Page) {
  const view = initial();
  const commands: Record<string, unknown>[] = [];
  const saved = new Map<string, object>();
  let loseNextConfirmation = false;
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ok: true, data: auth } }));
  await page.route(endpoint, async route => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    const key = body.idempotencyKey as string;
    if (saved.has(key)) { await route.fulfill({ json: saved.get(key) }); return; }
    const record = (holder: (typeof view.shareholders)[number], money: Record<string, unknown>) => {
      const given = cents(money.amount as string);
      const method = money.fundingMethod as string;
      const currency = money.currencyCode as string;
      const capital = holder.capitals.find(item => item.currency === currency)
        ?? (holder.capitals.push({ currency, contributed: "0.00", agreedTotal: null, remaining: null }),
          holder.capitals[holder.capitals.length - 1]!);
      capital.contributed = amount(cents(capital.contributed) + given);
      if (capital.agreedTotal !== null) capital.remaining = amount(cents(capital.agreedTotal) - cents(capital.contributed));
      if (method === "CASH" || method === "HAWALA") {
        const safe = view.destinations.find(item => item.id === money.destinationAccountId)!;
        safe.balance = amount(cents(safe.balance) + given);
      }
      const index = holder.transactions.length + 1;
      holder.transactions.push({ id: `receipt-${index}`, date: money.receiptDate as string, amount: amount(given),
        currency, method, destination: method === "CASH" || method === "HAWALA" ? "UI test USD Safe" : null,
        providerName: (money.providerName as string | null) ?? null, itemDescription: (money.itemDescription as string | null) ?? null,
        debitAccount: method === "ASSET" ? "UI test contributed assets" : method === "BILL_PAYMENT" ? "UI test fuel" : null,
        reference: `CAP-2026-${index.toString().padStart(4, "0")}`, status: "POSTED", journalId: `journal-${index}`,
        note: (money.note as string | null) ?? null, paymentReference: (money.paymentReference as string | null) ?? null });
    };
    if (body.action === "add-shareholder") {
      const total = body.agreedTotal === null ? null : amount(cents(body.agreedTotal as string));
      const holder = { id: shareholderId, name: body.displayName as string, reference: body.externalReference as string | null,
        note: body.note as string | null, active: true,
        capitals: total === null ? [] : [{ currency: body.currencyCode as string, contributed: "0.00", agreedTotal: total, remaining: total }],
        transactions: [] as Entry[], documents: [] as { id: string; fileName: string; version: number }[] };
      view.shareholders.push(holder);
      if (body.firstContribution !== null) record(holder, body.firstContribution as Record<string, unknown>);
    } else {
      record(view.shareholders[0]!, body);
    }
    const reference = view.shareholders[0]?.transactions.at(-1)?.reference;
    const response = { ok: true, data: { shareholderProfileId: shareholderId, reference, workspace: structuredClone(view) } };
    saved.set(key, response);
    if (loseNextConfirmation) { loseNextConfirmation = false; await route.abort("failed"); return; }
    await route.fulfill({ json: response });
  });
  return { view, commands, loseConfirmation: () => { loseNextConfirmation = true; } };
}

async function openAdd(page: Page) {
  await page.getByRole("button", { name: "Add shareholder", exact: true }).click();
  return page.getByRole("form", { name: "Add shareholder", exact: true });
}

/** One save: the shareholder and the first money together. */
async function addShareholder(page: Page, options: { readonly agreedTotal?: string; readonly cash?: string;
  readonly file?: { name: string; mimeType: string; buffer: Buffer } } = {}) {
  const form = await openAdd(page);
  await form.getByLabel("Name", { exact: true }).fill("Demo Shareholder");
  if (options.cash === undefined) {
    await form.getByRole("combobox", { name: "What are they putting in?", exact: true }).selectOption("");
  } else {
    await form.getByLabel(/^Amount/).fill(options.cash);
    await form.getByRole("combobox", { name: "Which Safe did it go into?", exact: true }).selectOption(safeId);
  }
  if (options.agreedTotal) await form.getByLabel(/^Agreed total \(optional\)/).fill(options.agreedTotal);
  if (options.file) await form.getByLabel("Agreement document (optional)").setInputFiles(options.file);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "Demo Shareholder", exact: true })).toBeVisible();
}

async function addMoney(page: Page, value: string, method?: string) {
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  const form = page.getByRole("form", { name: /^Add money/ });
  if (method) await form.getByRole("combobox", { name: "What are they putting in?", exact: true }).selectOption(method);
  await form.getByLabel(/^Amount/).fill(value);
  if (method === undefined || method === "CASH" || method === "HAWALA") {
    await form.getByRole("combobox", { name: "Which Safe did it go into?", exact: true }).selectOption(safeId);
  }
  return form;
}

test("@smoke one save records the shareholder and the money, then more money, with ledger history", async ({ page }) => {
  const mocked = await mockWorkspace(page);
  await page.goto("/shareholders");
  await addShareholder(page, { cash: "20000", agreedTotal: "100000" });
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder).toContainText("USD 20,000.00");
  await expect(holder).toContainText("No document attached");
  const form = await addMoney(page, "10000");
  await expect(form.getByRole("combobox", { name: "Which Safe did it go into?", exact: true })).not.toContainText("AFN");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  const capital = holder.getByRole("region", { name: "USD capital", exact: true });
  await expect(capital).toContainText("USD 30,000.00");
  await expect(capital).toContainText("USD 100,000.00");
  await expect(capital).toContainText("USD 70,000.00");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 30,000.00");
  await expect(holder.getByRole("row")).toHaveCount(3);
  await expect(holder).toContainText("CAP-2026-0001");
  await expect(holder).toContainText("CAP-2026-0002");
  await expect(holder.getByRole("link", { name: "View journal" }).first()).toHaveAttribute("href", /journalId=journal-1/);
  expect(mocked.commands.map(command => command.action)).toEqual(["add-shareholder", "add-capital"]);
  expect(new Set(mocked.commands.map(command => command.idempotencyKey)).size).toBe(2);
  // None of the machinery the owner asked to be rid of appears on the ordinary page.
  await expect(page.getByRole("main")).not.toContainText(/Capital Request|Receipt Intent|Posting Intent|Handoff|Evidence Binding|Installment|Ownership|Approve|Synthetic Authorization|Advanced/);
});

test("a shareholder with no agreed total shows only what they put in", async ({ page }) => {
  await mockWorkspace(page); await page.goto("/shareholders");
  await addShareholder(page, { cash: "7500" });
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder).toContainText("Capital put in");
  await expect(holder).toContainText("USD 7,500.00");
  await expect(holder).not.toContainText("Agreed total");
  await expect(holder).not.toContainText("Still to come");
});

test("hawala keeps the saraf, an asset moves no Safe, and a paid bill needs its expense account", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders");
  await addShareholder(page, { cash: "1000" });
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });

  const hawala = await addMoney(page, "12000", "HAWALA");
  await hawala.getByLabel("Which saraf?", { exact: true }).fill("Saraf Mahmood");
  await hawala.getByLabel("Hawala reference (optional)", { exact: true }).fill("HAWALA-77421");
  await hawala.getByRole("button", { name: "Save", exact: true }).click();
  await expect(hawala).toHaveCount(0);
  await expect(holder).toContainText("Saraf Mahmood");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 13,000.00");

  const asset = await addMoney(page, "35000", "ASSET");
  await expect(asset.getByRole("combobox", { name: "Which Safe did it go into?", exact: true })).toHaveCount(0);
  await asset.getByLabel("What is it?", { exact: true }).fill("Hilux pickup, 2019");
  await asset.getByRole("button", { name: "Save", exact: true }).click();
  await expect(asset).toHaveCount(0);
  await expect(holder).toContainText("Hilux pickup, 2019");
  await expect(holder).toContainText("UI test contributed assets");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 13,000.00");

  const bill = await addMoney(page, "1800", "BILL_PAYMENT");
  await bill.getByLabel("What was the bill for?", { exact: true }).fill("Generator fuel invoice");
  await bill.getByRole("combobox", { name: "Which expense account?", exact: true }).selectOption(expenseAccountId);
  await bill.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bill).toHaveCount(0);
  await expect(holder).toContainText("Bill paid directly");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 13,000.00");

  expect(mocked.commands.map(command => command.fundingMethod)).toEqual([undefined, "HAWALA", "ASSET", "BILL_PAYMENT"]);
  const asset_command = mocked.commands.find(command => command.fundingMethod === "ASSET")!;
  expect(asset_command.destinationAccountId).toBeNull();
  expect(asset_command.itemDescription).toBe("Hilux pickup, 2019");
  const hawala_command = mocked.commands.find(command => command.fundingMethod === "HAWALA")!;
  expect(hawala_command.providerName).toBe("Saraf Mahmood");
  expect(hawala_command.destinationAccountId).toBe(safeId);
});

test("a method with no account behind it cannot be chosen", async ({ page }) => {
  const mocked = await mockWorkspace(page);
  mocked.view.assetAccountReady = false; mocked.view.expenseAccounts = [];
  await page.goto("/shareholders");
  const form = await openAdd(page);
  const method = form.getByRole("combobox", { name: "What are they putting in?", exact: true });
  // Playwright does not treat <option disabled> as a disabled control, so assert the property.
  await expect(method.getByRole("option", { name: /An asset/ })).toHaveJSProperty("disabled", true);
  await expect(method.getByRole("option", { name: /bill they paid directly/ })).toHaveJSProperty("disabled", true);
  await expect(method).toContainText("not set up yet");
});

test("a shareholder can be added with nothing put in yet", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders");
  await addShareholder(page);
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder).toContainText("Nothing has been put in yet");
  expect(mocked.commands[0]?.firstContribution).toBeNull();
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 0.00");
});

test("lost response retries the identical command and records only one contribution", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders"); await addShareholder(page);
  const form = await addMoney(page, "20000"); mocked.loseConfirmation();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Confirmation was not received");
  await expect(form.getByLabel(/^Amount/)).toBeDisabled();
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(mocked.commands[1]).toEqual(mocked.commands[2]);
  expect(mocked.view.shareholders[0]!.transactions).toHaveLength(1);
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 20,000.00");
});

test("an unavailable path and missing permissions offer no financial action", async ({ page }) => {
  const mocked = await mockWorkspace(page); mocked.view.permissions.canManage = false; mocked.view.permissions.canReceive = false;
  mocked.view.receiveAvailable = false; mocked.view.unavailableReason = "CONFIGURATION_REQUIRED";
  await page.goto("/shareholders");
  await expect(page.getByRole("main")).toContainText("Recording capital is currently unavailable");
  await expect(page.getByRole("button", { name: "Add shareholder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add money", exact: true })).toHaveCount(0);
  expect(mocked.commands).toHaveLength(0);
});

test("two immediate submit events send one financial request", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders"); await addShareholder(page);
  const form = await addMoney(page, "20000");
  await form.evaluate(element => {
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(form).toHaveCount(0);
  expect(mocked.commands.filter(command => command.action === "add-capital")).toHaveLength(1);
  expect(mocked.view.shareholders[0]!.transactions).toHaveLength(1);
});

test("signed-out access displays a sign-in boundary and sends no commands", async ({ page }) => {
  await page.route("**/api/v1/auth/me", route => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in." } } }));
  await page.route(endpoint, route => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in." } } }));
  await page.goto("/shareholders");
  await expect(page.getByRole("heading", { name: "Sign in first", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add money", exact: true })).toHaveCount(0);
});

test("a user without financial reporting access sees no invented zero Safe balance", async ({ page }) => {
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ok: true, data: auth } }));
  const view = initial();
  await page.route(endpoint, route => route.fulfill({ json: { ok: true, data: { ...view,
    destinations: [{ id: safeId, name: "Restricted Safe", currency: "USD", balance: null }] } } }));
  await page.goto("/shareholders");
  const safes = page.getByRole("region", { name: "Safe balances", exact: true });
  await expect(safes).toContainText("Not available with your permissions");
  await expect(safes).not.toContainText("USD 0");
});

test("optional upload failure preserves the saved shareholder and retries the same version key", async ({ page }) => {
  const mocked = await mockWorkspace(page);
  const keys: string[] = []; let uploads = 0;
  await page.route("**/api/v1/shareholder/capital/documents", async route => {
    uploads += 1; const body = route.request().postDataBuffer()!.toString();
    keys.push(/name="idempotencyKey"\r\n\r\n([^\r]+)/.exec(body)![1]!);
    if (uploads === 1) { await route.fulfill({ status: 503, json: { ok: false, error: { code: "UNAVAILABLE", message: "Upload unavailable" } } }); return; }
    mocked.view.shareholders[0]!.documents.push({ id: "document-1", fileName: "agreement.pdf", version: 1 });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await page.goto("/shareholders");
  await addShareholder(page, { cash: "20000", file: { name: "agreement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nUI test only") } });
  await expect(page.getByRole("main").getByRole("alert")).toContainText("The shareholder is saved");
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder.getByRole("button", { name: "Add money", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry document upload", exact: true }).click();
  await expect(holder.getByRole("link", { name: "View document", exact: true })).toHaveAttribute("href", "/api/v1/shareholder/setup/documents/document-1");
  await expect(holder.getByRole("link", { name: "Download document", exact: true })).toHaveAttribute("href", "/api/v1/shareholder/setup/documents/document-1?download=1");
  await expect(holder.getByLabel("Upload another version")).toBeVisible();
  expect(keys[0]).toBe(keys[1]); expect(mocked.commands).toHaveLength(1);
});

test("Dari labels and RTL remain usable at tablet width", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mockWorkspace(page); await page.goto("/shareholders");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "افزودن سهامدار", exact: true }).click();
  const form = page.getByRole("form", { name: "افزودن سهامدار", exact: true });
  await form.getByLabel("نام", { exact: true }).fill("سهامدار نمایشی");
  await form.getByRole("combobox", { name: "چه می‌گذارد؟", exact: true }).selectOption("CASH");
  await form.getByLabel("مبلغ", { exact: true }).fill("20000");
  await form.getByRole("combobox", { name: "به کدام صندوق رفت؟", exact: true }).selectOption(safeId);
  await expect(form.getByLabel("سند توافق (اختیاری)")).toBeVisible();
  await form.getByRole("button", { name: "ذخیره", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: "سهامدار نمایشی", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
