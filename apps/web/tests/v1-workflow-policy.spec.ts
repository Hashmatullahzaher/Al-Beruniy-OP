import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Workflow-approval policy acceptance coverage through the real identity and database boundaries.
 * This test resets only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-workflow-policy --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 workflow approval policy", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("an explicitly permitted System Administrator manages versioned policy while other employees cannot see or call it", async ({ page }) => {
    test.setTimeout(240_000);
    const accounts = seedPreview();

    // Super Administration alone does not silently grant Finance policy authority.
    await signIn(page, "super.admin", accounts["super.admin"]);
    const adminNav = page.getByRole("navigation", { name: "V1 operations" });
    await expect(adminNav.getByRole("link", { name: "Workflow approvals" })).toHaveCount(0);

    // The Super Administrator explicitly creates the narrow administrative role.
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await editor.getByLabel("Role name").fill("Finance Workflow Policy Administrator");
    await editor.getByLabel("Description").fill("Configures whether each synthetic-preview Finance workflow needs independent approval.");
    await editor.locator(".permission-row", { hasText: "Manage Finance workflow approvals" }).locator("input").check();
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");

    // A separate synthetic employee receives only that role.
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "New employee" }).click();
    const create = page.getByRole("form", { name: "New employee" });
    await create.getByLabel("Username").fill("policy.admin");
    await create.getByLabel("Full name").fill("Synthetic Policy Administrator");
    await create.getByLabel("Job title").fill("Workflow policy administrator (synthetic)");
    await create.locator(".admin-role-picker label", { hasText: "Finance Workflow Policy Administrator" }).locator("input").check();
    await create.getByRole("button", { name: "Create account" }).click();
    const temporaryPassword = (await page.locator(".admin-secret-value").textContent())?.trim() ?? "";
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);
    await signOut(page);

    // The synthetic employee replaces the one-time password through the real sign-in flow.
    await page.goto("/login");
    await page.getByLabel("Username").fill("policy.admin");
    await page.getByLabel("Password", { exact: true }).fill(temporaryPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel("New password", { exact: true }).fill("Synthetic workflow policy passphrase 2026");
    await page.getByLabel("Repeat the new password").fill("Synthetic workflow policy passphrase 2026");
    await page.getByRole("button", { name: "Save password and continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Navigation and search are derived from the employee's live permissions.
    const policyNav = page.getByRole("navigation", { name: "V1 operations" });
    await expect(policyNav.getByRole("link")).toHaveText(["My dashboard", "Company", "Workflow approvals"]);
    await page.getByLabel("Search workspaces").fill("workflow");
    const search = page.getByRole("navigation", { name: "Workspace search results" });
    await expect(search.getByRole("link")).toHaveText(["Workflow approvals"]);
    await search.getByRole("link", { name: "Workflow approvals" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Finance workflow approvals" })).toBeVisible();
    await expect(page.locator(".policy-card")).toHaveCount(7);
    await expect(page.locator(".policy-card .treasury-chip", { hasText: "Not configured" })).toHaveCount(7);

    // Missing policy is explicit. Saving OFF creates v1; changing to ON creates v2 and keeps v1.
    const expense = page.locator(".policy-card").filter({ has: page.getByRole("heading", { name: "Expense", exact: true }) });
    await expense.getByLabel("Reason for this change").fill("Owner-directed synthetic preview default");
    await expense.getByRole("button", { name: "Save new version" }).click();
    await expect(page.getByRole("status")).toContainText("Approval policy saved");
    await expect(expense.locator(".treasury-chip")).toHaveText("Approval OFF");
    await expect(expense.locator("footer")).toContainText("Version 1");

    await expense.locator(".policy-toggle input").check();
    await expense.getByLabel("Reason for this change").fill("Synthetic independent-review scenario");
    await expense.getByRole("button", { name: "Save new version" }).click();
    await expect(expense.locator(".treasury-chip")).toHaveText("Approval ON");
    await expect(expense.locator("footer")).toContainText("Version 2");
    await expense.getByText("Version history").click();
    await expect(expense.locator(".policy-history li")).toHaveCount(2);
    await expect(expense.locator(".policy-history")).toContainText("Owner-directed synthetic preview default");
    await expect(expense.locator(".policy-history")).toContainText("Synthetic independent-review scenario");
    await signOut(page);

    // An ordinary cashier does not see the administrative route. Policy is readable company
    // configuration, but the server refuses a mutation and the direct page stays read-only.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    const cashierNav = page.getByRole("navigation", { name: "V1 operations" });
    await expect(cashierNav.getByRole("link", { name: "Workflow approvals" })).toHaveCount(0);
    await page.getByLabel("Search workspaces").fill("workflow");
    await expect(page.getByRole("navigation", { name: "Workspace search results" })).toHaveCount(0);
    const access = await page.evaluate(async () => {
      const readable = await fetch("/api/v1/admin/finance-workflows");
      const workspace = await readable.json() as { data: { canManage: boolean } };
      const mutation = await fetch("/api/v1/admin/finance-workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowType: "EXPENSE",
          approvalRequired: false,
          expectedVersion: 2,
          changeReason: "Unauthorized synthetic attempt"
        })
      });
      return { readStatus: readable.status, canManage: workspace.data.canManage, mutationStatus: mutation.status };
    });
    expect(access).toEqual({ readStatus: 200, canManage: false, mutationStatus: 403 });
    await page.goto("/admin/finance-workflows");
    await expect(page.locator(".policy-card form")).toHaveCount(0);
    await expect(page.locator(".policy-card").first()).toContainText("This page is read-only");
  });
});

async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function signOut(page: Page): Promise<void> {
  await page.locator(".account-control > button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

function seedPreview(): Record<string, string> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so CI can point every runtime at one isolated preview DB.
  const environment = { ...fileEnvironment, ...process.env };
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: environment, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}

function assertDisposablePreviewDatabase(ownerUrl: string | undefined, identityUrl: string | undefined): void {
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  expect(identityUrl, "ABOS_IDENTITY_DATABASE_URL for the same isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  const identityDatabase = new URL(identityUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  expect(identityDatabase).toBe(ownerDatabase);
}
