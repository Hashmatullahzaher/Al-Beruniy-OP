import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Migration 0041 (Slice 1 D3): the E1 synthetic lane has left the product. Signed in as the owner's
 * Super Administrator on a disposable preview database: no Treasury, Finance-inbox or token-form
 * surface anywhere; the retired pages and routes answer 404; "My dashboard" is built from the
 * session alone; the roles editor never offers a retired permission; the legacy Shareholders page
 * has no capital-request panel; and the runtimes are locked out of every frozen function.
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-retire-synthetic-lane --workers=1
 */

const ROOT = resolve(__dirname, "../../..");

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("0041: the synthetic lane has left the product", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("the owner sees no sandbox: navigation, routes, dashboard, roles editor and the legacy page", async ({ page }) => {
    test.setTimeout(240_000);
    const accounts = seedPreview();

    // The frozen inventory, read through the operator connection: fourteen functions, no runtime may execute any.
    const frozen = await query(
      `SELECT jsonb_build_object('count', count(*), 'exists', bool_and(function_exists),
              'runtime', bool_or(finance_runtime_can_execute OR treasury_runtime_can_execute OR identity_runtime_can_execute),
              'holder', bool_and(frozen_lane_can_execute)) AS value FROM abos.frozen_lanes`);
    expect(frozen).toEqual({ count: 14, exists: true, runtime: false, holder: true });

    const apiCalls: string[] = [];
    page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) apiCalls.push(url.pathname); });
    await signIn(page, "super.admin", accounts["super.admin"]);

    // My dashboard: name, roles and pages from the session; nothing E1 is called.
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Synthetic Super Admin" })).toBeVisible();
    await expect(page.getByTestId("dashboard-roles")).toContainText("Super Administrator");
    await expect(page.getByRole("link", { name: "Roles & permissions" }).first()).toBeVisible();
    await expect(page.getByText("SYNTHETIC PREVIEW DATA ONLY")).toHaveCount(0);
    expect(apiCalls.filter((path) => /\/treasury\/|\/handoffs|capital-requests/.test(path)), "no E1 endpoint is called").toEqual([]);

    // Navigation and the shell: no Treasury, no Finance inbox, no token form.
    const nav = page.getByRole("navigation", { name: "Operations" });
    await expect(nav.getByRole("link", { name: "Treasury", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Finance inbox" })).toHaveCount(0);
    await expect(page.getByText(/sandbox session token/i)).toHaveCount(0);
    await page.getByLabel("Search workspaces").fill("treasury");
    await expect(page.getByRole("navigation", { name: "Workspace search results" }).getByRole("link", { name: "Treasury", exact: true })).toHaveCount(0);

    // The retired pages and routes are gone, not merely hidden: they fall to the application's not-found page
    // (streamed, so the status is 200 like every unknown path) and never answer as an API.
    for (const path of ["/finance/treasury", "/finance/handoffs"]) {
      await page.goto(path);
      await expect(page.getByText("Workspace not found")).toBeVisible();
    }
    for (const path of ["/api/v1/treasury/session", "/api/v1/treasury/overview", "/api/v1/treasury/receipts",
      "/api/v1/treasury/cash-locations", "/api/v1/finance/handoffs", "/api/v1/shareholder/capital-requests"]) {
      await expectGone(page, path);
    }
    // The operational bridge route survives: it answers as an API (a refusal for an empty body), not as a missing page.
    const bridge = await page.request.post("/api/v1/treasury/shareholder-capital-receipts/00000000-0000-4000-8000-000000000000/verify", { data: {} });
    expect(bridge.headers()["content-type"] ?? "").toContain("application/json");
    await page.goto("/dashboard");

    // Roles editor: a new role is never offered a retired permission, and nothing reads "Retired".
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await expect(editor.getByText("Manage safes and cashiers")).toBeVisible();
    for (const label of ["View Treasury", "Record cash received", "Create shareholder capital requests", "Open capital requests from installments",
      "Prepare journals", "Post journals to the General Ledger"]) {
      await expect(editor.getByText(label, { exact: true })).toHaveCount(0);
    }
    await expect(editor.getByText("Retired", { exact: true })).toHaveCount(0);
    await expect(editor.getByText("Unavailable", { exact: true })).toHaveCount(1); // finance.journal.reverse, as before 0041

    // The legacy Shareholders page: Advanced shows agreements and installments, never capital requests.
    await page.goto("/shareholders/legacy");
    await page.getByRole("button", { name: "Advanced" }).click();
    const tabs = page.getByRole("tablist", { name: "Shareholder areas" });
    await expect(tabs.getByRole("tab", { name: /^Installments/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Capital Requests" })).toHaveCount(0);
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(tabs.getByRole("tab", { name: /^اقساط/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /درخواست‌های سرمایه/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Switch to English" }).click();
    await signOut(page);
  });
});

/** Unknown paths stream the not-found page (status 200 with the 404 boundary); a removed API route must never answer as JSON. */
async function expectGone(page: Page, path: string): Promise<void> {
  const response = await page.request.get(path);
  expect(response.headers()["content-type"] ?? "", path).toContain("text/html");
  expect(await response.text(), path).not.toContain('"ok":');
}

async function query(sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<{ value: unknown }>(sql, [...parameters])).rows[0]?.value;
  } finally {
    await client.end();
  }
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
    cwd: ROOT, env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
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

/** Refuses to run unless the owner and every restricted login point at one disposable preview database. */
function assertDisposablePreviewDatabase(environment: Record<string, string | undefined>): void {
  const ownerUrl = environment.ABOS_DATABASE_URL;
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  for (const name of ["ABOS_IDENTITY_DATABASE_URL", "ABOS_FINANCE_DATABASE_URL", "ABOS_TREASURY_DATABASE_URL"]) {
    const url = environment[name];
    expect(url, name).toBeTruthy();
    expect(new URL(url ?? "").pathname.slice(1), `${name} database`).toBe(ownerDatabase);
  }
}
