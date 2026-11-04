import { expect, test, type Page } from "@playwright/test";

import type { EnvironmentName, JournalReversalWorkspace, ReportSource } from "@abos/contracts";

import { PERMISSION_COPY, permissionLabel } from "../src/lib/access-copy";
import { signedOutFooter, signInNotice } from "../src/lib/environment-copy";
import { withJournalSources } from "../src/lib/reversal-sources";

// HTTP-mocked UI tests and pure rules only. No database, password or financial writes. The masking itself is proven by the
// PostgreSQL suite reporting-trial-balance (0055); the production build's wording by the production rehearsal.
const cashId = "79000000-0000-4000-8000-000000000001";
const bankId = "79000000-0000-4000-8000-000000000002";
const auth = (permissions: string[]) => ({ userAccountId: "79000000-0000-4000-8000-000000000009", loginIdentifier: "ui.polish", displayName: "UI test Accountant",
  jobTitle: "Accountant", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const row = (accountId: string, accountCode: string, accountName: string) => ({ accountId, accountCode, accountName, accountType: "ASSET", controlType: null, accountCurrency: "USD",
  status: "ACTIVE", parentId: null, openingDebit: "0", openingCredit: "0", periodDebit: "0", periodCredit: "0", endingDebit: "0", endingCredit: "0", native: [] });
const range = { mode: "AS_OF", from: "2026-01-01", to: "2026-11-04", fiscalYear: null, period: null, periods: [] };
const statement = (code: string, name: string) => ({ account: { id: cashId, code, name }, range, opening: { debit: "0", credit: "0" }, closing: { debit: "0", credit: "0" },
  periodDebit: "0", periodCredit: "0", lines: [] });

async function mock(page: Page, permissions: string[]) {
  const trialBalance: string[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(permissions) } }));
  await page.route("**/api/v1/finance/trial-balance*", async (route) => {
    trialBalance.push(new URL(route.request().url()).search);
    await route.fulfill({ json: { ok: true, data: { legalEntityId: "e", baseCurrency: "USD", range, includeZero: true, balanced: true, unbalancedJournals: 0,
      accounts: [row(cashId, "1100", "Main Cash"), row(bankId, "1200", "Bank")], totals: {} } } });
  });
  await page.route("**/api/v1/finance/account-statement*", async (route) => {
    const bank = new URL(route.request().url()).searchParams.get("accountId") === bankId;
    await route.fulfill({ json: { ok: true, data: bank ? statement("1200", "Bank") : statement("1100", "Main Cash") } });
  });
  return trialBalance;
}

test("production wording never mentions a preview, staging, demo or synthetic data, in English or Dari", () => {
  for (const copy of [signInNotice("production"), signedOutFooter("production")]) {
    expect(copy.en).not.toMatch(/preview|staging|demo|synthetic|sandbox|test/i);
    expect(copy.fa).not.toMatch(/پیش‌نمایش|آزمایش|مصنوعی|نمایشی|ساختگی/);
  }
  expect(signInNotice("staging").en).toMatch(/Staging/);
  expect(signInNotice("development").en).toMatch(/Preview environment/);
});

test("@smoke the sign-in page states the server's real environment", async ({ page }) => {
  const { release } = await (await page.request.get("/api/health")).json() as { release: { environment: EnvironmentName } };
  await page.goto("/login");
  await expect(page.locator(".login-footer")).toHaveText(signInNotice(release.environment).en);
});

test("@smoke images are plain files: the optimizer can leave one hanging until a restart", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "image") asked.push(new URL(request.url()).pathname); });
  await page.goto("/login");
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked.filter((path) => path.startsWith("/_next/image"))).toEqual([]);
});

test("the seven capital receipt permissions have people's names in both languages, and the codes stay the keys", () => {
  const codes = ["shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "treasury.capital-receipt.verify", "finance.capital-receipt.configure",
    "finance.capital-receipt.prepare", "finance.capital-receipt.approve", "finance.capital-receipt.post"];
  for (const code of codes) {
    const copy = PERMISSION_COPY[code];
    expect(copy, code).toBeTruthy();
    for (const locale of ["en", "fa"] as const) {
      expect(permissionLabel(code, locale)).not.toBe(code);
      expect(copy?.allows[locale].length).toBeGreaterThan(10);
    }
    expect(copy?.label.fa).toMatch(/[؀-ۿ]/);
  }
  for (const code of ["treasury.capital-receipt.verify", "finance.capital-receipt.approve", "finance.capital-receipt.post"]) expect(PERMISSION_COPY[code]?.independence, code).toBeTruthy();
});

test.describe("the reversal list's source detail", () => {
  const list = { journals: [{ id: "a" }, { id: "b" }] } as unknown as JournalReversalWorkspace;
  const label = { en: "Expense", fa: "مصرف" };
  const detail = { en: "EXP-001 — Office supplies", fa: "EXP-001 — لوازم دفتر" };
  const source = { type: "OPERATIONAL_EXPENSE", id: "source-id", label, route: "/finance/transactions", counterparty: "Synthetic Payee", detailRestricted: false, detail } satisfies ReportSource;
  const bare = { type: "OPERATIONAL_EXPENSE", id: null, label, route: null, counterparty: null };

  test("carries the label and authorized detail, and invents nothing for a journal the database left out", async () => {
    const asked: (readonly string[])[] = [];
    const result = await withJournalSources(list, async (ids) => { asked.push(ids); return { a: source }; });
    expect(asked).toEqual([["a", "b"]]);
    expect(result.journals.map((journal) => journal.source)).toEqual([{ ...bare, detail }, null]);
  });

  test("never passes on the source id, link or counterparty, even when the database returned them", async () => {
    const result = await withJournalSources(list, async () => ({ a: { ...source, detail: null } }));
    expect(result.journals[0]?.source).toEqual({ ...bare, detail: null });
    expect(JSON.stringify(result)).not.toMatch(/source-id|Synthetic Payee|\/finance\/transactions/);
  });

  test("someone who may reverse but cannot read Finance reports gets no source, and the list still works", async () => {
    const result = await withJournalSources(list, () => Promise.reject(new Error("current authority is missing finance.report.operational.read")));
    expect(result.journals.map((journal) => journal.source)).toEqual([null, null]);
  });

  test("any other failure is not hidden", async () => {
    await expect(withJournalSources(list, () => Promise.reject(new Error("connection lost")))).rejects.toThrow("connection lost");
  });

  test("an empty list asks the database nothing", async () => {
    const none = { journals: [] } as unknown as JournalReversalWorkspace;
    await withJournalSources(none, () => { throw new Error("must not be called"); });
  });
});

test.describe("Account statement in Finance navigation", () => {
  test("a report reader reaches it from the menu, chooses an account, and can switch", async ({ page }) => {
    const asked = await mock(page, ["finance.report.operational.read"]);
    await page.goto("/dashboard");
    await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Account statement" }).click();
    await expect(page).toHaveURL(/\/finance\/account-statement$/);
    const account = page.getByRole("combobox", { name: "Account" });
    await expect(account).toHaveValue("");
    await account.selectOption({ label: "1100 · Main Cash" });
    await expect(page).toHaveURL(new RegExp(`accountId=${cashId}`));
    await expect(page.getByRole("heading", { level: 1, name: "1100 · Main Cash" })).toBeVisible();
    await page.getByRole("combobox", { name: "Account" }).selectOption({ label: "1200 · Bank" });
    await expect(page.getByRole("heading", { level: 1, name: "1200 · Bank" })).toBeVisible();
    expect(asked[0]).toContain("includeZero=true");
  });

  test("a direct link and refresh keep the chosen account", async ({ page }) => {
    await mock(page, ["finance.report.operational.read"]);
    await page.goto(`/finance/account-statement?accountId=${bankId}`);
    await expect(page.getByRole("combobox", { name: "Account" })).toHaveValue(bankId);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "1200 · Bank" })).toBeVisible();
  });

  test("it is hidden from someone without report permission, and the page refuses them", async ({ page }) => {
    await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.expense.create"]) } }));
    await page.route("**/api/v1/finance/trial-balance*", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "Not allowed." } } }));
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation", { name: "Operations" });
    await expect(nav.getByRole("link", { name: "My dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Account statement" })).toHaveCount(0);
    await page.goto("/finance/account-statement");
    await expect(page.getByText("Account statements need permission to read Finance reports.")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Account" })).toHaveCount(0);
  });

  test("Dari label, RTL and phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
    await mock(page, ["finance.report.operational.read"]);
    await page.goto("/finance/account-statement");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("combobox", { name: "حساب" })).toBeVisible();
    await expect(page.getByRole("option", { name: "حساب را انتخاب کنید" })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
