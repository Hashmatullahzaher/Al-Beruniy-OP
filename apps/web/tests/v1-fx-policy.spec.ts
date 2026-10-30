import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only. No database or financial writes. The policy rules (append-only versions, account control,
// stale screens, conversion) are proven by the PostgreSQL suite fx-afn-posting (0051).
const fxAccount = "77000000-0000-4000-8000-000000000001";
const auth = (permissions: string[]) => ({ userAccountId: "77000000-0000-4000-8000-000000000009", loginIdentifier: "ui.fx",
  displayName: "UI test Finance Manager", jobTitle: "Finance Manager", legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const account = { id: fxAccount, code: "X-700", name: "FX gains and losses" };
const workspace = (ready: boolean) => ({
  today: "2026-10-29", baseCurrency: "USD", canManage: true, defaultPolicy: { roundingMode: "HALF_UP", baseScale: 2 },
  fxDifference: ready ? { status: "READY", count: 1, account: { ...account, currency: "USD" } } : { status: "MISSING", count: 0 },
  fxDifferenceAccounts: ready ? [{ ...account, accountType: "EXPENSE", currency: "USD", ready: true }] : [],
  currencies: [{ currencyCode: "AFN", name: "Afghani",
    current: ready ? { currencyCode: "AFN", status: "READY", policy: { versionId: null, version: 0, effectiveFrom: null, roundingMode: "HALF_UP", baseScale: 2,
      fxDifferenceAccountId: fxAccount, isDefault: true }, fxDifferenceAccount: account }
      : { currencyCode: "AFN", status: "SETUP_REQUIRED", message: "FX setup" },
    versions: [] as object[] }]
});

async function mock(page: Page, ready = true) {
  const view = workspace(ready);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.fx-policy.manage"]) } }));
  await page.route("**/api/v1/finance/fx-policy", async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ json: { ok: true, data: view } }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    view.currencies[0]!.versions = [{ id: "v1", version: 1, effectiveFrom: body.effectiveFrom, roundingMode: body.roundingMode, baseScale: body.baseScale,
      reason: body.reason, createdAt: "2026-10-29T08:00:00Z", createdBy: "UI test Finance Manager", fxDifferenceAccount: account }];
    await route.fulfill({ status: 201, json: { ok: true, data: { result: { status: "SAVED" }, workspace: view } } });
  });
  return commands;
}

test("@smoke the FX policy shows the default in force and saves a new version with its reason", async ({ page }) => {
  const commands = await mock(page);
  await page.goto("/finance/fx-policy");
  await expect(page.getByRole("heading", { level: 1, name: "FX policy" })).toBeVisible();
  const afn = page.getByRole("region", { name: "AFN policy" });
  await expect(afn).toContainText("Default");
  await expect(afn).toContainText("Round half up");
  await afn.getByRole("button", { name: "Save a new policy" }).click();
  const form = page.getByRole("form", { name: "New AFN policy" });
  await form.getByLabel("Rounding *").selectOption("EXACT_ONLY");
  await form.getByLabel("Decimal places *").selectOption("2");
  await expect(form.getByLabel("FX difference account *")).toHaveValue(fxAccount);
  await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  await form.getByLabel("Reason *").fill("Board decision: only exact conversions");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "FX policy saved." })).toBeVisible();
  await expect(afn.getByRole("row").nth(1)).toContainText("Board decision: only exact conversions");
  expect(commands).toEqual([expect.objectContaining({ currencyCode: "AFN", effectiveFrom: "2026-10-29", roundingMode: "EXACT_ONLY", baseScale: 2,
    fxDifferenceLedgerAccountId: fxAccount, reason: "Board decision: only exact conversions", expectedVersion: 0 })]);
});

test("without an FX difference account the page says how to set it up and nothing can be saved", async ({ page }) => {
  const commands = await mock(page, false);
  await page.goto("/finance/fx-policy");
  await expect(page.getByRole("note").filter({ hasText: "No account carries the control “FX difference” yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Chart of Accounts" })).toHaveAttribute("href", "/finance/accounts");
  await expect(page.getByRole("region", { name: "AFN policy" }).getByRole("button", { name: "Save a new policy" })).toBeDisabled();
  expect(commands).toHaveLength(0);
});
