import { FINANCE_MANAGER_ROLE_TEMPLATE } from "@abos/contracts";
import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests: Getting started derives every step from the existing APIs and only calls existing commands.
// The database-backed journey is in v1-operational-finance.spec.ts.

const FINANCE = [...FINANCE_MANAGER_ROLE_TEMPLATE.permissions];
const user = (permissions: readonly string[]) => ({ userAccountId: "79000000-0000-4000-8000-000000000001", loginIdentifier: "ui.setup", displayName: "UI test Finance",
  jobTitle: null, legalEntityName: "UI test company", permissions, roles: ["Finance Manager"], sessionExpiresAt: "2099-01-01T00:00:00Z" });
const policy = (workflowType: string, labelEn: string, configured = false, approvalRequired: boolean | null = null, version = 0, approvalAvailable = true) =>
  ({ workflowType, labelEn, labelFa: labelEn, approvalAvailable, configured, policyVersionId: configured ? `v-${workflowType}` : null, version, approvalRequired,
    changeReason: null, configuredAt: null, configuredBy: null, history: [] });
const freshPolicies = () => [policy("CHART_OF_ACCOUNTS", "Chart of Accounts"), policy("SHAREHOLDER_CAPITAL_RECEIPT", "Shareholder capital receipt"),
  policy("EXPENSE", "Expense"), policy("JOURNAL_REVERSAL", "Journal reversal", false, null, 0, false), policy("TEMPORARY_FUNDING", "Temporary funding")];

interface Mock { readonly puts: Record<string, unknown>[]; readonly posts: { url: string; body: unknown }[] }

async function mockCompany(page: Page, options: { permissions?: readonly string[]; policies?: ReturnType<typeof freshPolicies>; roles?: unknown[] | null } = {}): Promise<Mock> {
  const mock: Mock = { puts: [], posts: [] };
  const policies = options.policies ?? freshPolicies();
  const json = (data: unknown) => ({ json: { ok: true, data } });
  const denied = { status: 403, json: { ok: false, error: { code: "FORBIDDEN", message: "Not allowed." } } };
  await page.route("**/api/v1/auth/me", (route) => route.fulfill(json(user(options.permissions ?? FINANCE))));
  await page.route("**/api/v1/admin/finance-workflows", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mock.puts.push(body);
      const index = policies.findIndex((item) => item.workflowType === body.workflowType);
      policies[index] = policy(String(body.workflowType), policies[index]!.labelEn, true, body.approvalRequired as boolean, (body.expectedVersion as number) + 1, policies[index]!.approvalAvailable);
    }
    await route.fulfill(json({ legalEntityId: "e", canManage: (options.permissions ?? FINANCE).includes("admin.finance-workflow.manage"), policies }));
  });
  await page.route("**/api/v1/finance/financial-years", (route) => route.fulfill(json({ today: "2026-11-03", canClose: true, years: [] })));
  await page.route("**/api/v1/finance/calendar", (route) => route.fulfill(json({ canManage: true, legalEntity: { id: "e", name: "UI test company", baseCurrency: "USD" },
    settings: null, fiscalYears: [], otherPeriods: [] })));
  await page.route("**/api/v1/finance/accounts", (route) => route.fulfill(json({ canManage: true, canReview: true, actor: null,
    legalEntity: { id: "e", name: "UI test company", baseCurrency: "USD" }, currencies: [{ code: "USD", name: "US Dollar" }], accounts: [], reviewQueue: 0,
    approvalPolicy: { version: 0, approvalRequired: true, configured: false } })));
  await page.route("**/api/v1/finance/operations/configuration", (route) => route.fulfill(json({ legalEntity: { id: "e", name: "UI test company", baseCurrency: "USD" },
    permissions: { canManageTreasuryAccounts: true, canManageExpenseCategories: true, canManagePeriods: true }, treasuryAccounts: [], expenseCategories: [], periods: [],
    options: { treasuryLedgerAccounts: [], expenseLedgerAccounts: [] } })));
  await page.route("**/api/v1/shareholder/capital", (route) => route.fulfill(json({ legalEntity: { id: "e", name: "UI test company", baseCurrency: "USD" },
    permissions: { canManage: true, canReceive: true }, currencies: [], destinations: [], expenseAccounts: [], assetAccountReady: false, receiveAvailable: false,
    unavailableReason: "CONFIGURATION_REQUIRED", shareholders: [] })));
  await page.route("**/api/v1/finance/trial-balance?**", (route) => route.fulfill(json({ legalEntityId: "e", baseCurrency: "USD", range: {}, includeZero: false,
    accounts: [], totals: {}, balanced: true, unbalancedJournals: 0 })));
  await page.route("**/api/v1/admin/roles", (route) => options.roles === undefined || options.roles === null ? route.fulfill(denied) : route.fulfill(json(options.roles)));
  await page.route("**/api/v1/admin/catalogue", (route) => route.fulfill(json([...FINANCE, "admin.users.manage", "admin.roles.manage"].map((code: string) => ({ code, category: code.split(".")[0],
    availability: "ACTIVE", independenceEnforced: false, administrative: code.startsWith("admin."), catalogueVersion: 1 })))));
  return mock;
}

test("@smoke Simple mode shows exactly what it saves, then saves only those versions with the Getting started reason", async ({ page }) => {
  const mock = await mockCompany(page);
  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  await expect(page.getByText("1 of 8 steps done")).toBeVisible();
  await expect(page.getByRole("button", { name: "2. Finance access — Done" })).toBeVisible();
  // Keyboard: the choice is a radio group.
  await page.getByRole("radio", { name: /Simple \/ Single Operator/ }).focus();
  await page.keyboard.press("Space");
  const plan = page.locator(".gs-plan");
  await expect(plan.locator("li")).toHaveText(["Chart of Accounts: approval OFF", "Shareholder capital receipt: approval OFF", "Expense: approval OFF", "Journal reversal: approval OFF"]);
  await expect(plan).not.toContainText("Temporary funding");
  await plan.getByRole("button", { name: "Use Simple / Single Operator" }).click();
  await expect(page.getByText("Saved. Each setting is a new, audited policy version")).toBeVisible();
  expect(mock.puts.map((body) => [body.workflowType, body.approvalRequired, body.expectedVersion, body.changeReason])).toEqual([
    ["CHART_OF_ACCOUNTS", false, 0, "Configured by Getting Started — Simple / Single Operator"],
    ["SHAREHOLDER_CAPITAL_RECEIPT", false, 0, "Configured by Getting Started — Simple / Single Operator"],
    ["EXPENSE", false, 0, "Configured by Getting Started — Simple / Single Operator"],
    ["JOURNAL_REVERSAL", false, 0, "Configured by Getting Started — Simple / Single Operator"]]);
  expect(new Set(mock.puts.map((body) => body.idempotencyKey)).size).toBe(4);
  await expect(page.getByRole("button", { name: "1. How the company works — Done" })).toBeVisible();
  // The financial year suggests the current year, never next year; nothing is created until asked.
  await expect(page.getByRole("heading", { level: 2, name: "Financial year" })).toBeVisible();
  await expect(page.getByLabel("Year", { exact: true })).toHaveValue(String(new Date().getFullYear()));
  expect(mock.posts).toEqual([]);
});

test("Advanced Controls never saves ON where no approval lane exists and waits for a second Finance approver", async ({ page }) => {
  const roles = [{ id: "r1", name: "Finance Manager", description: "", status: "ACTIVE", version: 1, permissions: FINANCE, youHoldThis: true,
    holders: [{ id: "u1", displayName: "Only person", status: "ACTIVE" }] }];
  const mock = await mockCompany(page, { permissions: [...FINANCE, "admin.roles.manage"], roles });
  await page.goto("/setup");
  await page.getByRole("radio", { name: /Advanced Controls/ }).check();
  const plan = page.locator(".gs-plan");
  await expect(plan.locator("li")).toHaveText(["Chart of Accounts: approval ON", "Shareholder capital receipt: approval ON", "Expense: approval ON"]);
  await expect(plan).toContainText("Not available yet, so left unchanged: Journal reversal");
  await expect(plan).toContainText("needs at least two Finance people");
  await plan.getByRole("button", { name: "Use Advanced Controls" }).click();
  await expect(page.getByText("there is no second Finance person who can approve yet")).toBeVisible();
  expect(mock.puts.map((body) => [body.workflowType, body.approvalRequired, body.changeReason])).toEqual([
    ["CHART_OF_ACCOUNTS", true, "Configured by Getting Started — Advanced Controls"], ["SHAREHOLDER_CAPITAL_RECEIPT", true, "Configured by Getting Started — Advanced Controls"],
    ["EXPENSE", true, "Configured by Getting Started — Advanced Controls"]]);
  await expect(page.getByRole("button", { name: "1. How the company works — Waiting" })).toBeVisible();
  await page.getByRole("button", { name: /^8\. Ready/ }).click();
  await expect(page.getByText("Advanced Controls needs a second Finance person who can approve before setup counts as complete.")).toBeVisible();
});

test("an administrator without Finance access is led to a prefilled Finance Manager role they still review and save", async ({ page }) => {
  const posted: unknown[] = [];
  await mockCompany(page, { permissions: ["admin.users.manage", "admin.roles.manage"], roles: [] });
  await page.route("**/api/v1/admin/finance-workflows", (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "FORBIDDEN", message: "Not allowed." } } }));
  await page.goto("/setup");
  await expect(page.getByRole("button", { name: "2. Finance access — Needs access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "4. Chart of Accounts — Done" })).toHaveCount(0);
  await page.getByRole("button", { name: /^2\. Finance access/ }).click();
  await expect(page.getByText("The System Administrator is not a Finance user automatically, and nobody can give access to themselves.")).toBeVisible();
  await page.route("**/api/v1/admin/roles", async (route) => {
    if (route.request().method() === "POST") { posted.push(route.request().postDataJSON()); }
    await route.fulfill({ json: { ok: true, data: [] } });
  });
  await page.getByRole("link", { name: "1. Create the Finance Manager role" }).click();
  await expect(page).toHaveURL(/\/admin\/roles\?template=finance-manager$/);
  await expect(page.getByRole("note").filter({ hasText: "Prefilled from the single-operator Finance Manager template" })).toBeVisible();
  const editor = page.getByRole("form", { name: "Role editor" });
  await expect(editor.getByLabel("Role name")).toHaveValue("Finance Manager");
  await expect(editor.locator(".permission-row input:checked")).toHaveCount(FINANCE.length);
  await expect(editor.locator(".permission-row", { hasText: "Manage employee accounts" }).locator("input")).not.toBeChecked();
  expect(posted, "nothing is saved until the administrator chooses Create role").toEqual([]);
});

test("Dari, right to left and phone width keep every step usable", async ({ page }) => {
  await mockCompany(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/setup");
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "آغاز کار" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("۱ از ۸ مرحله انجام شد")).toBeVisible();
  await expect(page.getByRole("radio", { name: /ساده \/ اپراتور یک‌نفره/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Switch to English" }).click();
});
