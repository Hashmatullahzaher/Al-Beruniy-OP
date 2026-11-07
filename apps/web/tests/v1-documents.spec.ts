import { expect, test, type Page } from "@playwright/test";

/** The documents panel from mocked APIs: what each person is offered, in both languages. The server's own rules are proved in document-vault.test.ts. */

const companyProfile = { legalEntity: { id: "e", code: "SYN", name: "Synthetic Company", baseCurrency: "USD" },
  profile: { legalName: null, registrationNumber: null, goLiveDate: null, version: 1, updatedAt: null, updatedBy: null }, currencies: [], calendar: null, canManage: true };
const auth = { userAccountId: "u", displayName: "Synthetic Administrator", loginIdentifier: "admin", legalEntityId: "e", jobTitle: "Administrator", legalEntityName: "Synthetic Company",
  permissions: ["admin.company.manage"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
const attached = { id: "11111111-1111-4111-8111-111111111111", title: "Certificate", documentDate: "2026-09-01", fileName: "certificate.pdf", scanStatus: "CLEAN", mediaType: "application/pdf", byteSize: 2048, attachedAt: "2026-09-01T08:00:00Z" };

async function mock(page: Page, list: { canRead: boolean; canAttach: boolean; documents: unknown[] } | null, upload?: { status: number; body: unknown }) {
  const posts: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth } }));
  await page.route("**/api/v1/admin/company", (route) => route.fulfill({ json: { ok: true, data: companyProfile } }));
  await page.route(/\/api\/v1\/documents(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({ status: upload?.status ?? 201, json: upload?.body ?? { ok: true, data: attached } });
      return;
    }
    await route.fulfill(list === null ? { status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "x" } } } : { json: { ok: true, data: list } });
  });
  return posts;
}

const PDF = { name: "certificate.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

const journalId = "78000000-0000-4000-8000-000000000020";
const sourceId = "78000000-0000-4000-8000-000000000021";

/** A journal drill-down from mocked APIs. Returns what the documents panel asked for. */
async function journalPage(page: Page, type: string, id: string | null = sourceId): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: { ...auth, permissions: ["finance.report.operational.read"] } } }));
  await page.route(`**/api/v1/finance/journals/${journalId}`, (route) => route.fulfill({ json: { ok: true, data: { journalId, reference: "SYN-1", restricted: false, date: "2026-09-12", postedAt: "x",
    baseCurrency: "USD", postedBy: "Synthetic Cashier", period: null, source: { type, id, label: { en: "Source", fa: "منبع" }, route: null, counterparty: null },
    lines: [{ lineNumber: 1, accountId: "x", accountCode: "L-1", accountName: "Line", accountType: "ASSET", debit: "1.00", credit: "0", originalAmount: "1.00", originalCurrency: "USD" }],
    fx: null, reversedBy: null, reverses: null } } }));
  await page.route(/\/api\/v1\/finance\/general-ledger(\/activity)?\?/, (route) => route.fulfill({ json: { ok: true, data: { syntheticOnly: false, legalEntityId: "e", from: "2026-01-01",
    to: "2026-12-31", accountId: null, accounts: [], currencyTotals: [], lines: [], totals: [], returnedLineCount: 0, hasMore: false, nextCursor: null, pageLimit: 100,
    order: "", basis: "POSTED_ACTIVITY_IN_RANGE", isBalance: false, openingBalancesIncluded: false } } }));
  await page.route("**/api/v1/finance/accounts*", (route) => route.fulfill({ json: { ok: true, data: { accounts: [] } } }));
  await page.route(/\/api\/v1\/documents\?/, async (route) => {
    asked.push(new URL(route.request().url()).search.slice(1));
    await route.fulfill({ json: { ok: true, data: { canRead: true, canAttach: false, documents: [attached] } } });
  });
  await page.goto(`/finance/general-ledger?journalId=${journalId}`);
  return asked;
}

test("a person who can read and attach sees the file, how to open it, and that nothing is ever replaced", async ({ page }) => {
  await mock(page, { canRead: true, canAttach: true, documents: [attached] });
  await page.goto("/admin/company");
  const panel = page.getByRole("region", { name: "Documents" });
  const row = panel.getByRole("listitem").filter({ hasText: "Certificate" });
  await expect(row).toContainText("certificate.pdf");
  await expect(row.getByRole("link", { name: "View" })).toHaveAttribute("href", `/api/v1/documents/${attached.id}`);
  await expect(row.getByRole("link", { name: "Download" })).toHaveAttribute("href", `/api/v1/documents/${attached.id}?download=1`);
  await expect(panel).toContainText("An attached document is never replaced or removed.");
});

test("a person who may read but not attach is offered no form, and one who may do neither sees nothing", async ({ page }) => {
  await mock(page, { canRead: true, canAttach: false, documents: [] });
  await page.goto("/admin/company");
  const panel = page.getByRole("region", { name: "Documents" });
  await expect(panel).toContainText("No documents attached.");
  await expect(panel.getByRole("form")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, null);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Documents" })).toHaveCount(0);
});

test("a person who may attach but not read sees no list", async ({ page }) => {
  await mock(page, { canRead: false, canAttach: true, documents: [] });
  await page.goto("/admin/company");
  const panel = page.getByRole("region", { name: "Documents" });
  await expect(panel.getByRole("form", { name: "Attach a document" })).toBeVisible();
  await expect(panel).not.toContainText("No documents attached.");
});

test("the form needs a title and a file, says so when a file is refused, and keeps the request for a retry", async ({ page }) => {
  const posts = await mock(page, { canRead: true, canAttach: true, documents: [] }, { status: 413, body: { ok: false, error: { code: "TOO_LARGE", message: "x" } } });
  await page.goto("/admin/company");
  const form = page.getByRole("form", { name: "Attach a document" });
  const save = form.getByRole("button", { name: "Attach document" });
  await expect(save).toBeDisabled();
  await form.getByLabel("Title").fill("Certificate");
  await expect(save).toBeDisabled();
  await form.getByLabel(/^PDF or image file/).setInputFiles(PDF);
  await save.click();
  await expect(form.getByRole("alert")).toContainText("Files cannot exceed 10 MB.");
  await save.click();
  await expect.poll(() => posts.length).toBe(2);
  const key = (body: string) => /name="idempotencyKey"\r\n\r\n([^\r]+)/.exec(body)?.[1];
  expect(key(posts[0]!)).toBeTruthy();
  expect(key(posts[1]!)).toBe(key(posts[0]!));
});

test("Dari, right to left", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, { canRead: true, canAttach: true, documents: [attached] });
  await page.goto("/admin/company");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const panel = page.getByRole("region", { name: "اسناد" });
  await expect(panel.getByRole("link", { name: "دیدن" })).toBeVisible();
  await expect(panel.getByRole("form", { name: "پیوست سند" })).toBeVisible();
});

test("a locked document offers no way to open it, and can be checked again", async ({ page }) => {
  const list = { canRead: true, canAttach: true, documents: [{ ...attached, scanStatus: "PENDING" }] };
  await mock(page, list);
  const scans: string[] = [];
  await page.route(`**/api/v1/documents/${attached.id}/scan`, async (route) => {
    scans.push(route.request().postData() ?? "");
    list.documents = [{ ...attached, scanStatus: "CLEAN" }];
    await route.fulfill({ json: { ok: true, data: { id: attached.id, scanStatus: "CLEAN" } } });
  });
  await page.goto("/admin/company");
  const row = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Certificate" });
  await expect(row).toContainText("Locked until its security check passes");
  await expect(row.getByRole("link")).toHaveCount(0);
  await row.getByRole("button", { name: "Check again" }).click();
  await expect(row.getByRole("link", { name: "View" })).toBeVisible();
  // The browser asks for a scan. It never says how the scan came out.
  expect(scans).toEqual([""]);
});

test("a reader of a locked document cannot start a check", async ({ page }) => {
  await mock(page, { canRead: true, canAttach: false, documents: [{ ...attached, scanStatus: "PENDING" }] });
  await page.goto("/admin/company");
  const row = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Certificate" });
  await expect(row).toContainText("Locked until its security check passes");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("a blocked document says so, and offers nothing", async ({ page }) => {
  await mock(page, { canRead: true, canAttach: true, documents: [{ ...attached, scanStatus: "INFECTED" }] });
  await page.goto("/admin/company");
  const row = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Certificate" });
  await expect(row).toContainText("Blocked: failed its security check and cannot be opened");
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
});

for (const [scanStatus, role, message] of [["CLEAN", "status", "Document attached."], ["PENDING", "status", "It stays locked until its security check passes."],
  ["INFECTED", "alert", "This file failed its security check."]] as const) {
  test(`attaching says where the file stands: ${scanStatus}`, async ({ page }) => {
    await mock(page, { canRead: true, canAttach: true, documents: [] }, { status: 201, body: { ok: true, data: { ...attached, scanStatus } } });
    await page.goto("/admin/company");
    const form = page.getByRole("form", { name: "Attach a document" });
    await form.getByLabel("Title").fill("Certificate");
    await form.getByLabel(/^PDF or image file/).setInputFiles(PDF);
    await form.getByRole("button", { name: "Attach document" }).click();
    await expect(form.getByRole(role)).toContainText(message);
  });
}

for (const [source, subject] of [["CASH_RECEIPT", "RECEIPT"], ["PAYMENT", "PAYMENT"]] as const) {
  test(`a ${source} journal carries its documents`, async ({ page }) => {
    const asked = await journalPage(page, source);
    await expect(page.getByRole("region", { name: "Journal", exact: true }).getByRole("region", { name: "Documents" })).toContainText("Certificate");
    expect(asked).toContain(`subjectType=${subject}&subjectId=${sourceId}`);
  });
}

test("a journal of any other kind asks for no documents", async ({ page }) => {
  const asked = await journalPage(page, "TREASURY_TRANSFER");
  await expect(page.getByRole("region", { name: "Journal", exact: true })).toContainText("L-1");
  expect(asked).toEqual([]);
});

test("a journal whose source is withheld asks for no documents", async ({ page }) => {
  const asked = await journalPage(page, "PAYMENT", null);
  await expect(page.getByRole("region", { name: "Journal", exact: true })).toContainText("L-1");
  expect(asked).toEqual([]);
});

test("the not-found page follows the person's language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, null);
  await page.goto("/no-such-page");
  await expect(page.getByText("این صفحه پیدا نشد")).toBeVisible();
  await expect(page.getByRole("link", { name: "بازگشت به صفحهٔ اصلی" })).toBeVisible();
});

test("a scan that could not finish says so, stays locked, and can be checked again only by someone who may attach", async ({ page }) => {
  const failed = { ...attached, id: "22222222-2222-4222-8222-222222222222", title: "Scan failed file", scanStatus: "SCAN_FAILED" };
  await mock(page, { canRead: true, canAttach: true, documents: [failed] });
  await page.goto("/admin/company");
  const row = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Scan failed file" });
  await expect(row).toContainText("Security check could not finish. It stays locked");
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Check again" })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { canRead: true, canAttach: false, documents: [failed] });
  await page.reload();
  const readOnly = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Scan failed file" });
  await expect(readOnly).toContainText("Security check could not finish");
  await expect(readOnly.getByRole("button")).toHaveCount(0);
});

test("an upload whose scan could not finish tells the person the file is attached but locked", async ({ page }) => {
  await mock(page, { canRead: true, canAttach: true, documents: [] }, { status: 201, body: { ok: true, data: { ...attached, scanStatus: "SCAN_FAILED" } } });
  await page.goto("/admin/company");
  const form = page.getByRole("form", { name: "Attach a document" });
  await form.getByLabel("Title").fill("Certificate");
  await form.getByLabel(/PDF or image file/).setInputFiles(PDF);
  await form.getByRole("button", { name: "Attach document" }).click();
  await expect(form.getByRole("status")).toHaveText("Document attached, but its security check could not finish. It stays locked until a check passes.");
});

test("a document attached to a capital agreement is marked with its agreement where it appears", async ({ page }) => {
  const onAgreement = { ...attached, id: "33333333-3333-4333-8333-333333333333", title: "Signed capital agreement", subjectType: "AGREEMENT", agreementReference: "SYN-AGR-7" };
  await mock(page, { canRead: true, canAttach: true, documents: [onAgreement] });
  await page.goto("/admin/company");
  const row = page.getByRole("region", { name: "Documents" }).getByRole("listitem").filter({ hasText: "Signed capital agreement" });
  await expect(row).toContainText("Agreement SYN-AGR-7");
  await expect(row.getByRole("link", { name: "View" })).toHaveAttribute("href", `/api/v1/documents/${onAgreement.id}`);
});
