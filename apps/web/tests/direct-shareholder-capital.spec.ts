import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database, password, document vault or financial writes.
const shareholderId = "71000000-0000-4000-8000-000000000001";
const safeId = "71000000-0000-4000-8000-000000000002";
const endpoint = "**/api/v1/shareholder/capital";
const auth = { userAccountId: "71000000-0000-4000-8000-000000000003", loginIdentifier: "ui.test", displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions: ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
const initial = () => ({
  legalEntity: { id: "71000000-0000-4000-8000-000000000004", name: "UI test company", baseCurrency: "USD" },
  permissions: { canManage: true, canReceive: true }, currencies: [{ code: "USD", label: "USD" }, { code: "AFN", label: "AFN" }],
  destinations: [{ id: safeId, name: "UI test USD Safe", currency: "USD", balance: "0.00" }, { id: "afn-safe", name: "UI test AFN Safe", currency: "AFN", balance: "0.00" }],
  shareholders: [] as {
    id: string; name: string; reference: string | null; note: string | null; ownershipPercent: string | null; active: boolean;
    capitals: { currency: string; total: string; received: string; outstanding: string; available: string }[];
    transactions: { id: string; date: string; amount: string; currency: string; destination: string; reference: string; status: "POSTED"; journalId: string; note: string | null; paymentReference: string | null }[];
    documents: { id: string; fileName: string; version: number }[];
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
    if (body.action === "create-shareholder") {
      const total = amount(cents(body.totalCapital as string));
      view.shareholders.push({ id: shareholderId, name: body.displayName as string, reference: body.externalReference as string | null, note: body.note as string | null, ownershipPercent: body.ownershipPercent as string | null, active: true, capitals: [{ currency: body.currencyCode as string, total, received: "0.00", outstanding: total, available: total }], transactions: [], documents: [] });
    } else {
      const holder = view.shareholders[0]!;
      const capital = holder.capitals[0]!;
      const received = cents(body.amount as string);
      if (received > cents(capital.outstanding)) { await route.fulfill({ status: 409, json: { ok: false, error: { code: "OVER_RECEIPT", message: "Amount exceeds capital." } } }); return; }
      capital.received = amount(cents(capital.received) + received);
      capital.outstanding = amount(cents(capital.total) - cents(capital.received)); capital.available = capital.outstanding;
      view.destinations[0]!.balance = amount(cents(view.destinations[0]!.balance) + received);
      const index = holder.transactions.length + 1;
      holder.transactions.push({ id: `receipt-${index}`, date: body.receiptDate as string, amount: amount(received), currency: "USD", destination: "UI test USD Safe", reference: `CAP-2026-${index.toString().padStart(4, "0")}`, status: "POSTED", journalId: `journal-${index}`, note: body.note as string | null, paymentReference: body.paymentReference as string | null });
    }
    const reference = view.shareholders[0]?.transactions.at(-1)?.reference;
    const response = { ok: true, data: { shareholderProfileId: shareholderId, reference, workspace: structuredClone(view) } };
    saved.set(key, response);
    if (loseNextConfirmation) { loseNextConfirmation = false; await route.abort("failed"); return; }
    await route.fulfill({ json: response });
  });
  return { view, commands, loseConfirmation: () => { loseNextConfirmation = true; } };
}

async function addShareholder(page: Page, file?: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole("button", { name: "Add shareholder", exact: true }).click();
  const form = page.getByRole("form", { name: "Add shareholder", exact: true });
  await form.getByLabel("Name", { exact: true }).fill("Demo Shareholder");
  await form.getByLabel("Total Capital", { exact: true }).fill("100000");
  if (file) await form.getByLabel("Agreement document (optional)").setInputFiles(file);
  await form.getByRole("button", { name: "Save shareholder", exact: true }).click();
  await expect(page.getByRole("article", { name: "Demo Shareholder", exact: true })).toBeVisible();
}

async function receive(page: Page, value: string) {
  await page.getByRole("button", { name: "Receive Capital", exact: true }).click();
  const form = page.getByRole("form", { name: "Receive Capital", exact: true });
  await form.getByLabel("Amount received", { exact: true }).fill(value);
  await form.getByRole("combobox", { name: "Destination Safe / account", exact: true }).selectOption(safeId);
  return form;
}

test("@smoke one save receives capital twice and refreshes shareholder, Safe and journal history", async ({ page }) => {
  const mocked = await mockWorkspace(page);
  await page.goto("/shareholders");
  await addShareholder(page);
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder).toContainText("USD 100,000.00");
  await expect(holder).toContainText("No document attached");
  for (const value of ["20000", "10000"]) {
    const form = await receive(page, value);
    await expect(form.getByRole("combobox", { name: "Destination Safe / account", exact: true })).not.toContainText("AFN");
    await form.getByRole("button", { name: "Save / Receive", exact: true }).click();
    await expect(form).toHaveCount(0);
  }
  const capital = holder.getByRole("region", { name: "USD capital", exact: true });
  await expect(capital).toContainText("USD 100,000.00");
  await expect(capital).toContainText("USD 30,000.00");
  await expect(capital).toContainText("USD 70,000.00");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 30,000.00");
  await expect(holder.getByRole("row")).toHaveCount(3);
  await expect(holder).toContainText("CAP-2026-0001");
  await expect(holder).toContainText("CAP-2026-0002");
  await expect(holder.getByRole("link", { name: "View journal" }).first()).toHaveAttribute("href", /journalId=journal-1/);
  expect(mocked.commands.map(command => command.action)).toEqual(["create-shareholder", "receive-capital", "receive-capital"]);
  expect(new Set(mocked.commands.map(command => command.idempotencyKey)).size).toBe(3);
  await expect(page.getByRole("main")).not.toContainText(/Capital Request|Receipt Intent|Posting Intent|Handoff|Evidence Binding|Synthetic Authorization|Advanced/);
});

test("lost response retries the identical command and records only one receipt", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders"); await addShareholder(page);
  const form = await receive(page, "20000"); mocked.loseConfirmation();
  await form.getByRole("button", { name: "Save / Receive", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Confirmation was not received");
  await expect(form.getByLabel("Amount received")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(mocked.commands[1]).toEqual(mocked.commands[2]);
  expect(mocked.view.shareholders[0]!.transactions).toHaveLength(1);
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 20,000.00");
});

test("an unavailable receipt path and missing permissions offer no financial action", async ({ page }) => {
  const mocked = await mockWorkspace(page); mocked.view.permissions.canManage = false; mocked.view.permissions.canReceive = false;
  mocked.view.receiveAvailable = false; mocked.view.unavailableReason = "PERIOD_NOT_OPEN";
  await page.goto("/shareholders");
  await expect(page.getByRole("main")).toContainText("Receiving capital is currently unavailable");
  await expect(page.getByRole("button", { name: "Add shareholder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Receive Capital", exact: true })).toHaveCount(0);
  expect(mocked.commands).toHaveLength(0);
});

test("an over-receipt is rejected without changing displayed money", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders"); await addShareholder(page);
  const form = await receive(page, "100001");
  await form.getByRole("button", { name: "Save / Receive", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("greater than the capital still outstanding");
  expect(mocked.view.shareholders[0]!.capitals[0]!.received).toBe("0.00");
  await expect(page.getByRole("region", { name: "Safe balances" })).toContainText("USD 0.00");
});

test("two immediate submit events send one financial request", async ({ page }) => {
  const mocked = await mockWorkspace(page); await page.goto("/shareholders"); await addShareholder(page);
  const form = await receive(page, "20000");
  await form.evaluate(element => {
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(form).toHaveCount(0);
  expect(mocked.commands.filter(command => command.action === "receive-capital")).toHaveLength(1);
  expect(mocked.view.shareholders[0]!.transactions).toHaveLength(1);
});

test("signed-out access displays a sign-in boundary and sends no commands", async ({ page }) => {
  await page.route("**/api/v1/auth/me", route => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in." } } }));
  await page.route(endpoint, route => route.fulfill({ status: 401, json: { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in." } } }));
  await page.goto("/shareholders");
  await expect(page.getByRole("heading", { name: "Sign in first", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Receive Capital", exact: true })).toHaveCount(0);
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
  await page.goto("/shareholders"); await addShareholder(page, { name: "agreement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nUI test only") });
  await expect(page.getByRole("main").getByRole("alert")).toContainText("The shareholder is saved");
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder.getByRole("button", { name: "Receive Capital", exact: true })).toBeEnabled();
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
  await form.getByLabel("مجموع سرمایه", { exact: true }).fill("100000");
  await expect(form.getByLabel("سند توافق (اختیاری)")).toBeVisible();
  await form.getByRole("button", { name: "ذخیره سهامدار", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: "سهامدار نمایشی", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
