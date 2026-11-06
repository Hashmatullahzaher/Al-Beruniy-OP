import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, type Browser, type Page } from "@playwright/test";
import pg from "pg";

import { seedAccounts } from "./seed-credentials";

/** What the browser tests that start from a brand-new company share: seeding the disposable preview database, signing in and reading it back. */

export function policyCard(page: Page, heading: string) {
  return page.locator(".policy-card").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

export async function createAccount(page: Page, account: { code: string; name: string; type: string; control?: string; currency?: string }): Promise<void> {
  await page.getByRole("button", { name: "New account" }).click();
  const form = page.getByRole("form", { name: "Account form" });
  await form.getByLabel("Account code").fill(account.code);
  await form.getByLabel("Account type").selectOption(account.type);
  await form.getByLabel("Account name").fill(account.name);
  if (account.control !== undefined) await form.getByLabel("Control type").selectOption(account.control);
  if (account.currency !== undefined) await form.getByLabel("Currency").selectOption(account.currency);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Account created under the current approval policy.");
}

/** Read-only verification of the disposable preview database. Nothing is written. */
export async function readOnly<Row extends pg.QueryResultRow>(sql: string): Promise<Row[]> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = (await client.query<Row>(sql)).rows;
    await client.query("ROLLBACK");
    return rows;
  } finally {
    await client.end();
  }
}

const COUNTS: Readonly<Record<string, string>> = {
  fiscal_years: "abos.fiscal_years", ledger_accounts: "abos.ledger_accounts", workflow_policies: "abos.finance_workflow_policy_versions",
  treasury_accounts: "abos.operational_treasury_accounts", shareholders: "abos.shareholder_profiles", journals: "abos.journals"
};

export async function expectBusinessCounts(expected: Readonly<Record<string, number>>): Promise<void> {
  const sql = Object.keys(expected).map((key) => `SELECT '${key}' AS k, count(*)::int AS n FROM ${COUNTS[key]}`).join(" UNION ALL ");
  const rows = await readOnly<{ k: string; n: number }>(sql);
  expect(Object.fromEntries(rows.map((row) => [row.k, row.n]))).toEqual(expected);
}

export function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of (existsSync(resolve(__dirname, "../../.env.local")) ? readFileSync(resolve(__dirname, "../../.env.local"), "utf8") : "").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

export function seedFirstRun(): Record<string, string> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  return seedAccounts("preview:first-run", environment);
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

export async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function signOut(page: Page): Promise<void> {
  await page.locator(".account-control > button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** A new employee holding only the named permissions, signed in on their own browser context. */
export async function employeeHolding(admin: Page, browser: Browser, login: string, permissions: readonly string[]): Promise<Page> {
  await admin.goto("/admin/roles");
  await admin.getByRole("button", { name: "New role" }).click();
  const editor = admin.getByRole("form", { name: "Role editor" });
  await editor.getByLabel("Role name").fill(`Role of ${login}`);
  await editor.getByLabel("Description").fill("Synthetic confidentiality check.");
  for (const permission of permissions) await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
  await editor.getByRole("button", { name: "Create role" }).click();
  await expect(admin.locator(".treasury-message.success")).toContainText("Role created");
  await admin.goto("/admin/users");
  await admin.getByRole("button", { name: "New employee" }).click();
  const create = admin.getByRole("form", { name: "New employee" });
  await create.getByLabel("Username").fill(login);
  await create.getByLabel("Full name").fill(`Synthetic ${login}`);
  await create.getByLabel("Job title").fill("Synthetic");
  await create.locator(".admin-role-picker label", { hasText: `Role of ${login}` }).locator("input").check();
  await create.getByRole("button", { name: "Create account" }).click();
  const temporaryPassword = (await admin.locator(".admin-secret-value").textContent())?.trim() ?? "";
  const person = await (await browser.newContext()).newPage();
  await person.goto("/login");
  await person.getByLabel("Username").fill(login);
  await person.getByLabel("Password", { exact: true }).fill(temporaryPassword);
  await person.getByRole("button", { name: "Sign in" }).click();
  await person.getByLabel("New password", { exact: true }).fill("Synthetic confidentiality check passphrase 2026");
  await person.getByLabel("Repeat the new password").fill("Synthetic confidentiality check passphrase 2026");
  await person.getByRole("button", { name: "Save password and continue" }).click();
  await expect(person).toHaveURL(/\/dashboard/);
  return person;
}
