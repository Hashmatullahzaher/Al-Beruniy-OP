import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V1 Chart of Accounts (WP-A) through the real sign-in, administration and restricted Finance login.
 * Reseeds the disposable dev database: ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-chart-of-accounts --workers=1
 * Every account below is synthetic and says so.
 */
const SHOTS = resolve(__dirname, "../test-results/v1-chart-of-accounts");

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 Chart of Accounts", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run this.");

  test("a permitted user adds accounts with duplicate warnings; an independent reviewer works the review list", async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();

    // The Super Administrator creates a manager role and a reviewer role and assigns them.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await createRole(page, "Chart of Accounts Manager", ["Manage the Chart of Accounts"]);
    await createRole(page, "Accounts Reviewer", ["Review new accounts"]);
    await assignRole(page, "Synthetic Intent Creator", "Chart of Accounts Manager");
    await assignRole(page, "Synthetic Finance Approver", "Accounts Reviewer");
    await signOut(page);

    // The manager adds a group and two posting accounts; a likely duplicate needs confirmation.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.getByRole("link", { name: "Chart of Accounts" }).click();
    await expect(page).toHaveURL(/\/finance\/accounts/);
    await expect(page.getByText("NO FIXED CHART IS SHIPPED")).toBeVisible();
    await addAccount(page, { code: "SYN-EXP", name: "Synthetic Operating Expenses", type: "EXPENSE", currency: "", posting: false });
    await addAccount(page, { code: "SYN-EXP-100", name: "Synthetic Office Rent", type: "EXPENSE", currency: "USD", parent: "SYN-EXP · Synthetic Operating Expenses" });

    await page.getByRole("button", { name: "New account" }).click();
    const form = page.getByRole("form", { name: "Account form" });
    await form.getByLabel("Account code").fill("SYN-EXP-101");
    await form.getByLabel("Account name").fill("Synthetic office rent");
    await form.getByLabel("Account type").selectOption("EXPENSE");
    const warnings = form.getByRole("list", { name: "Duplicate warnings" });
    await expect(warnings).toContainText("Likely duplicate: SYN-EXP-100");
    await expect(form.getByRole("button", { name: "Create account" })).toBeDisabled();
    await page.screenshot({ path: resolve(SHOTS, "01-duplicate-warning.png") });
    await form.getByLabel("I have checked the warnings; this is not a duplicate.").check();
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("waits in the review list");
    // An exact code is refused before it is even sent.
    await page.getByRole("button", { name: "New account" }).click();
    await form.getByLabel("Account code").fill("syn-exp-100");
    await expect(form.getByRole("alert")).toContainText("already used by SYN-EXP-100");
    await form.getByRole("button", { name: "Cancel" }).click();

    // The tree shows the new accounts awaiting review; the creator cannot review.
    const tree = page.getByLabel("Accounts", { exact: true });
    await expect(tree.locator("button", { hasText: "SYN-EXP-100" })).toContainText("Awaiting review");
    await page.getByRole("tab", { name: /Review list/ }).click();
    await expect(page.getByText("You can see the list; reviewing needs")).toBeVisible();
    await page.screenshot({ path: resolve(SHOTS, "02-review-list-creator.png") });
    // A seeded account used by the synthetic safe is protected.
    await page.getByRole("tab", { name: /^Accounts/ }).click();
    await tree.locator("button", { hasText: "1010-USD" }).click();
    await expect(page.getByText(/In use — code, type, currency and control type are fixed/)).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(form.getByLabel("Account code")).toBeDisabled();
    await form.getByRole("button", { name: "Cancel" }).click();
    await signOut(page);

    // The independent reviewer marks one reviewed and flags the other; the reviewer cannot create.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/accounts");
    await expect(page.getByRole("button", { name: "New account" })).toHaveCount(0);
    const refused = await page.evaluate(async () => (await fetch("/api/v1/finance/accounts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { code: "SYN-X", name: "Synthetic Refused", type: "ASSET", currency: "USD", postingAllowed: true } })
    })).status);
    expect(refused).toBe(403);
    await page.getByRole("tab", { name: /Review list/ }).click();
    const rent = page.getByRole("article", { name: "Review SYN-EXP-100" });
    await rent.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("SYN-EXP-100 marked as reviewed");
    const duplicate = page.getByRole("article", { name: "Review SYN-EXP-101" });
    await expect(duplicate).toContainText("Warnings shown and confirmed");
    await duplicate.getByLabel("Note (required to flag)").fill("Synthetic: looks like SYN-EXP-100");
    await duplicate.getByRole("button", { name: "Flag for correction" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("SYN-EXP-101 flagged for correction");
    await expect(page.getByRole("article", { name: "Review SYN-EXP-101" })).toContainText("Flagged for correction");
    await page.screenshot({ path: resolve(SHOTS, "03-review-decisions.png") });

    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.getByRole("tab", { name: /فهرست بازبینی/ })).toBeVisible();
    // Phone width, where the navigation is a drawer. (At desktop width in Dari the shared app shell's
    // sidebar overlaps the right edge of every page: a pre-existing shell issue reported to the lead.)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /حساب‌ها/ }).click();
    await expect(page.getByLabel("حساب‌ها", { exact: true }).locator("button", { hasText: "SYN-EXP-100" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "04-phone-dari.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to English" }).click();
  });
});

async function createRole(page: Page, name: string, permissions: readonly string[]): Promise<void> {
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: "New role" }).click();
  const editor = page.getByRole("form", { name: "Role editor" });
  await editor.getByLabel("Role name").fill(name);
  for (const permission of permissions) await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
  await editor.getByRole("button", { name: "Create role" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Role created");
}

async function assignRole(page: Page, person: string, role: string): Promise<void> {
  await page.goto("/admin/users");
  await page.locator(".admin-list > button", { hasText: person }).click();
  await page.locator(".admin-role-picker label", { hasText: role }).locator("input").check();
  await page.getByRole("button", { name: "Save roles" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Roles saved");
}

async function addAccount(page: Page, account: { code: string; name: string; type: string; currency: string; posting?: boolean; parent?: string }): Promise<void> {
  await page.getByRole("button", { name: "New account" }).click();
  const form = page.getByRole("form", { name: "Account form" });
  await form.getByLabel("Account code").fill(account.code);
  await form.getByLabel("Account name").fill(account.name);
  await form.getByLabel("Account type").selectOption(account.type);
  await form.getByLabel("Currency").selectOption(account.currency);
  if (account.parent) await form.getByLabel("Parent account (optional)").selectOption({ label: account.parent });
  if (account.posting === false) await form.getByLabel("Accepts postings").uncheck();
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Account created");
}

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
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

/** Refuses to seed unless the owner and every restricted login point at one disposable preview database. */
function assertDisposablePreviewDatabase(environment: Record<string, string | undefined>): void {
  const ownerUrl = environment.ABOS_DATABASE_URL;
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  expect(environment.ABOS_IDENTITY_DATABASE_URL, "ABOS_IDENTITY_DATABASE_URL for the same isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  for (const name of ["ABOS_IDENTITY_DATABASE_URL", "ABOS_FINANCE_DATABASE_URL", "ABOS_TREASURY_DATABASE_URL"]) {
    const url = environment[name];
    if (url !== undefined && url.trim() !== "") expect(new URL(url).pathname.slice(1), `${name} database`).toBe(ownerDatabase);
  }
}
