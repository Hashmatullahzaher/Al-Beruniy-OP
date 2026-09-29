import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Company dashboard access control through the real UI, identity service and database. It resets
 * only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-company-dashboard --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const RETIRED_DEMO_FIGURES = ["1,284", "$243.1M", "$186.4M", "$60.2M", "$54.2M", "$6.8M", "$28.6M", "246 team members", "DEMO DATA"];

test.describe("V1 company dashboard access", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("only people whose role grants the company dashboard see it; removing the permission removes access", async ({ browser }) => {
    test.setTimeout(300_000);
    const accounts = seedPreview();
    const admin = await browser.newPage();
    const viewer = await browser.newPage();

    // A Super Administrator does not hold the dashboard permission implicitly.
    await signIn(admin, "super.admin", accounts["super.admin"]);
    await admin.goto("/");
    await expect(admin).toHaveURL(/\/dashboard$/);
    expect((await admin.request.get("/api/v1/company/dashboard")).status()).toBe(403);
    await expect(admin.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Company dashboard" })).toHaveCount(0);

    // The permission is offered in Roles & Permissions, in English and Dari.
    await admin.goto("/admin/roles");
    await admin.getByRole("button", { name: "New role" }).click();
    const editor = admin.getByRole("form", { name: "Role editor" });
    await expect(editor.locator(".permission-row", { hasText: "View company dashboard" })).toHaveCount(1);
    await admin.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(admin.locator(".permission-row", { hasText: "مشاهده داشبورد عمومی شرکت" })).toHaveCount(1);
    await admin.getByRole("button", { name: "Switch to English" }).click();
    await editor.getByLabel("Role name").fill("Executive Dashboard Viewer");
    await editor.getByLabel("Description").fill("Sees the company-wide dashboard only (synthetic preview).");
    await editor.locator(".permission-row", { hasText: "View company dashboard" }).locator("input").check();
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(admin.locator(".treasury-message.success")).toContainText("Role created");

    // A synthetic employee receives only that role.
    await admin.goto("/admin/users");
    await admin.getByRole("button", { name: "New employee" }).click();
    const create = admin.getByRole("form", { name: "New employee" });
    await create.getByLabel("Username").fill("exec.viewer");
    await create.getByLabel("Full name").fill("Synthetic Executive Viewer");
    await create.getByLabel("Job title").fill("Executive (synthetic)");
    await create.locator(".admin-role-picker label", { hasText: "Executive Dashboard Viewer" }).locator("input").check();
    await create.getByRole("button", { name: "Create account" }).click();
    const temporaryPassword = (await admin.locator(".admin-secret-value").textContent())?.trim() ?? "";
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

    await viewer.goto("/login");
    await viewer.getByLabel("Username").fill("exec.viewer");
    await viewer.getByLabel("Password", { exact: true }).fill(temporaryPassword);
    await viewer.getByRole("button", { name: "Sign in" }).click();
    await viewer.getByLabel("New password", { exact: true }).fill("Synthetic executive viewer passphrase 2026");
    await viewer.getByLabel("Repeat the new password").fill("Synthetic executive viewer passphrase 2026");
    await viewer.getByRole("button", { name: "Save password and continue" }).click();
    await expect(viewer).toHaveURL(/\/dashboard/);

    // Authorized: the dashboard shows real counts only; modules without a V1 source say so.
    const nav = viewer.getByRole("navigation", { name: "Operations" });
    await nav.getByRole("link", { name: "Company dashboard" }).click();
    await expect(viewer).toHaveURL(/\/$/);
    await expect(viewer.getByRole("heading", { level: 1, name: "Company dashboard" })).toBeVisible();
    const projects = await activeProjects();
    await expect(viewer.locator('[data-kpi="projects"] .kpi-figure')).toHaveText(String(projects));
    // The approved layout is intact: 8 KPI cards and every panel, with honest states instead of figures.
    await expect(viewer.locator(".kpi-strip .reference-kpi")).toHaveCount(8);
    await expect(viewer.locator('.kpi-strip [data-state="not-connected"]')).toHaveCount(7);
    await expect(viewer.locator('.kpi-strip [data-state="not-connected"] .kpi-empty').first()).toHaveText("Not connected yet");
    for (const panel of ["sales", "projects", "cash", "insights", "departments", "alerts"]) {
      await expect(viewer.locator(`[data-panel="${panel}"]`), panel).toBeVisible();
    }
    await expect(viewer.locator(".bar-chart .chart-empty")).toContainText("Not connected yet");
    await expect(viewer.locator(".line-chart .chart-empty")).toContainText("Not connected yet");
    // Empty charts draw no bars, curves or target lines.
    await expect(viewer.locator(".line-chart .cash-line, .line-chart .target-line, .line-chart .cash-area")).toHaveCount(0);
    expect(await viewer.locator(".bar-chart > span").evaluateAll((bars) => bars.every((bar) => bar.getBoundingClientRect().height === 0))).toBe(true);
    const text = await viewer.locator("body").innerText();
    for (const figure of RETIRED_DEMO_FIGURES) expect(text, `retired demo figure ${figure}`).not.toContain(figure);
    expect((await viewer.request.get("/api/v1/company/dashboard")).status()).toBe(200);

    // The same person has no Finance, Treasury or administration access through the dashboard.
    for (const url of ["/api/v1/finance/operations/expenses?from=2026-09-01&to=2026-09-30", "/api/v1/admin/users"]) {
      expect((await viewer.request.get(url)).status(), url).toBeGreaterThanOrEqual(401);
    }

    // Removing the permission from the role removes access at once, for the page and the API.
    await admin.goto("/admin/roles");
    await admin.locator(".admin-list button", { hasText: "Executive Dashboard Viewer" }).click();
    await admin.getByRole("form", { name: "Role editor" }).locator(".permission-row", { hasText: "View company dashboard" }).locator("input").uncheck();
    await admin.getByRole("form", { name: "Role editor" }).getByLabel("Description").fill("Company dashboard access removed (synthetic preview).");
    await admin.getByRole("button", { name: "Save role" }).click();
    await expect(admin.locator(".treasury-message.success")).toBeVisible();

    // Changing what a role allows ends its holders' sessions, so the change applies on the next request.
    await viewer.goto("/");
    await expect(viewer).toHaveURL(/\/login/);
    expect((await viewer.request.get("/api/v1/company/dashboard")).status()).toBe(401);
    // This role held only the dashboard permission, so the person now has no access at all.
    const again = await viewer.request.post("/api/v1/auth/login", {
      data: { loginIdentifier: "exec.viewer", password: "Synthetic executive viewer passphrase 2026" },
      headers: { Origin: new URL(viewer.url()).origin }
    });
    expect(again.status()).toBe(403);
    expect((await again.json()).error.code).toBe("NO_ACCESS_ASSIGNED");
  });
});

async function activeProjects(): Promise<number> {
  const environment = previewEnvironment();
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ n: string }>(
      "SELECT count(*) FILTER (WHERE active)::text AS n FROM abos.projects WHERE legal_entity_id = (SELECT id FROM abos.legal_entities ORDER BY created_at LIMIT 1)");
    return Number(result.rows[0]?.n ?? "0");
  } finally {
    await client.end();
  }
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  const environment = { ...fileEnvironment, ...process.env };
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  return environment;
}

function seedPreview(): Record<string, string> {
  const environment = previewEnvironment();
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

function assertDisposablePreviewDatabase(ownerUrl: string | undefined, identityUrl: string | undefined): void {
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  expect(identityUrl, "ABOS_IDENTITY_DATABASE_URL for the same isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  expect(new URL(identityUrl ?? "").pathname.slice(1)).toBe(ownerDatabase);
}

async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
