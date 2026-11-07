import { expect, test, type Page } from "@playwright/test";

/** The documents panel from mocked APIs: what each person is offered, in both languages. The server's own rules are proved in document-vault.test.ts. */

const companyProfile = { legalEntity: { id: "e", code: "SYN", name: "Synthetic Company", baseCurrency: "USD" },
  profile: { legalName: null, registrationNumber: null, goLiveDate: null, version: 1, updatedAt: null, updatedBy: null }, currencies: [], calendar: null, canManage: true };
const auth = { userAccountId: "u", displayName: "Synthetic Administrator", loginIdentifier: "admin", legalEntityId: "e", jobTitle: "Administrator", legalEntityName: "Synthetic Company",
  permissions: ["admin.company.manage"], sessionExpiresAt: "2099-01-01T00:00:00Z" };
const attached = { id: "11111111-1111-4111-8111-111111111111", title: "Certificate", documentDate: "2026-09-01", fileName: "certificate.pdf", mediaType: "application/pdf", byteSize: 2048, attachedAt: "2026-09-01T08:00:00Z" };

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

test("the not-found page follows the person's language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page, null);
  await page.goto("/no-such-page");
  await expect(page.getByText("این صفحه پیدا نشد")).toBeVisible();
  await expect(page.getByRole("link", { name: "بازگشت به صفحهٔ اصلی" })).toBeVisible();
});
