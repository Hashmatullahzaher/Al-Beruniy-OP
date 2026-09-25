import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V1 client-preview acceptance journey, through the real sign-in, the real administration service
 * and the real Treasury and Finance boundaries. Nothing is mocked.
 *
 * It reseeds the disposable dev database with `preview:seed`, so it is gated and runs alone:
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-client-preview --workers=1
 * Screenshots go to test-results/v1-preview/.
 */
const SHOTS = resolve(__dirname, "../test-results/v1-preview");
const RECEIPT = "RCPT-V1-PREVIEW-0001";

test.use({ viewport: { width: 1440, height: 900 }, video: { mode: "on", size: { width: 1440, height: 900 } } });

test.describe("V1 client preview", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run the client-preview journey.");

  test("an administrator creates an employee and a role; the employee's access is enforced end to end", async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const accounts = seedPreview();

    // 1. The Super Administrator signs in through the normal login screen.
    await page.goto("/login");
    await shot(page, "01-login");
    await signIn(page, "super.admin", accounts["super.admin"]);
    await expect(page.getByRole("heading", { level: 1, name: /Welcome, Synthetic Super Admin/ })).toBeVisible();
    await shot(page, "02-admin-dashboard");

    // 2-4. A custom role with receipt-recording permissions only.
    await page.goto("/admin/roles");
    await page.getByRole("button", { name: "New role" }).click();
    const editor = page.getByRole("form", { name: "Role editor" });
    await editor.getByLabel("Role name").fill("Cash Receipt Officer");
    await editor.getByLabel("Description").fill("Records and counts shareholder cash received into an assigned safe.");
    for (const permission of ["View Treasury", "Record cash received", "Count cash"]) {
      await editor.locator(".permission-row", { hasText: permission }).locator("input").check();
    }
    await expect(editor.locator(".permission-row.unavailable")).toHaveCount(2);
    await shot(page, "03-role-editor", ".role-editor");
    await editor.getByRole("button", { name: "Create role" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Role created");

    // 2, 5. A new employee with that role.
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "New employee" }).click();
    const create = page.getByRole("form", { name: "New employee" });
    await create.getByLabel("Username").fill("r.officer");
    await create.getByLabel("Full name").fill("Synthetic Receipt Officer");
    await create.getByLabel("Job title").fill("Cash receipt officer");
    await create.locator(".admin-role-picker label", { hasText: "Cash Receipt Officer" }).locator("input").check();
    // The one-time password is blurred in screenshots and the recording; the test still reads it.
    await page.addStyleTag({ content: ".admin-secret-value { filter: blur(6px); }" });
    await create.getByRole("button", { name: "Create account" }).click();
    const temporary = (await page.locator(".admin-secret-value").textContent())?.trim() ?? "";
    expect(temporary.length).toBeGreaterThanOrEqual(16);
    await shot(page, "04-user-created", ".admin-secret");
    await signOut(page);

    // The Treasury manager gives the new employee custody of the safe (a Treasury rule, not an admin one).
    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await page.goto("/finance/treasury");
    await page.getByRole("tab", { name: /Safes & accounts/ }).click();
    await page.getByLabel("Give custody of this safe to").selectOption({ label: "Synthetic Receipt Officer" });
    await page.getByRole("button", { name: "Assign as cashier" }).click();
    await expect(page.locator(".treasury-safe footer")).toContainText("Synthetic Receipt Officer");
    await shot(page, "05-safe-custody-assigned", ".treasury-safes");
    await signOut(page);

    // 6. The employee signs in and must replace the temporary password.
    await page.goto("/login");
    await page.getByLabel("Username").fill("r.officer");
    await page.getByLabel("Password", { exact: true }).fill(temporary);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel("New password", { exact: true }).fill("Receipt officer passphrase 2026");
    await page.getByLabel("Repeat the new password").fill("Receipt officer passphrase 2026");
    await page.getByRole("button", { name: "Save password and continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Welcome, Synthetic Receipt Officer/ })).toBeVisible();

    // 7. Only the permitted workspace is offered...
    const previewNav = page.getByRole("navigation", { name: "V1 preview" });
    await expect(previewNav.getByRole("link")).toHaveText(["My dashboard", "Treasury"]);
    await shot(page, "06-employee-dashboard");
    // ...and the server refuses everything else, whatever the interface shows.
    const refusals = await page.evaluate(async () => ({
      users: (await fetch("/api/v1/admin/users")).status,
      createUser: (await fetch("/api/v1/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginIdentifier: "x.y", displayName: "X Y", status: "ACTIVE", roleIds: [] }) })).status,
      finance: (await fetch("/api/v1/finance/handoffs")).status
    }));
    expect(refusals.users).toBe(403);
    expect(refusals.createUser).toBe(403);
    expect(refusals.finance).toBeGreaterThanOrEqual(400);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
    await shot(page, "07-denied-admin");

    // 8. The employee records the eligible synthetic USD receipt, counts it and submits it.
    await page.goto("/finance/treasury");
    await page.getByRole("tab", { name: /Shareholder intents/ }).click();
    const intent = page.locator(".treasury-table tbody tr").first();
    await intent.getByPlaceholder("Receipt ref.").fill(RECEIPT);
    await intent.getByRole("button", { name: "Record cash received" }).click();
    const header = page.locator(".treasury-receipt-detail header");
    await expect(header).toContainText("Received · not counted");
    await page.getByLabel(/Counted amount/).fill("25000.00");
    await page.getByRole("button", { name: "Record physical count" }).click();
    await page.getByRole("button", { name: "Submit for independent verification" }).click();
    await expect(header).toContainText("Awaiting independent verification");

    // 9. Verifying their own receipt is not offered, and the backend refuses a direct attempt.
    await expect(page.getByRole("button", { name: "Confirm count and verify receipt" })).toHaveCount(0);
    const selfVerify = await page.evaluate(async () => {
      const overview = await (await fetch("/api/v1/treasury/overview")).json() as { data: { receipts: { id: string }[] } };
      const id = overview.data.receipts[0]?.id ?? "";
      const response = await fetch(`/api/v1/treasury/receipts/${id}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() as { ok: boolean; error?: { message: string } } };
    });
    expect(selfVerify.body.ok).toBe(false);
    expect(selfVerify.status).toBeGreaterThanOrEqual(400);
    await shot(page, "08-employee-recorded-cannot-verify", ".treasury-receipt-detail");
    await signOut(page);

    // 10. An independent Treasury verifier verifies and hands the receipt to Finance.
    await signIn(page, "demo.verifier", accounts["demo.verifier"]);
    await page.goto("/finance/treasury");
    await page.locator(".treasury-receipt-list button", { hasText: RECEIPT }).click();
    await page.getByRole("button", { name: "Confirm count and verify receipt" }).click();
    await page.getByRole("button", { name: "Hand verified receipt to Finance" }).click();
    await expect(header).toContainText("Handed to Finance");
    await shot(page, "09-verified-and-handed-off", ".treasury-receipt-detail");
    await signOut(page);

    // 11. The Finance preparer prepares; approving their own preparation is refused by the database.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.goto("/finance/handoffs");
    const handoff = page.locator(".finance-handoff-list button", { hasText: RECEIPT });
    await handoff.click();
    await page.getByRole("button", { name: "Prepare journal for approval" }).click();
    await expect(handoff).toContainText("Prepared · awaiting independent approval");
    const selfApprove = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/finance/handoffs")).json() as { data: { handoffs: { id: string; postingIntentId?: string }[] } };
      const item = list.data.handoffs[0];
      const response = await fetch(`/api/v1/finance/handoffs/${item?.id ?? ""}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postingIntentId: item?.postingIntentId ?? "" }) });
      return { status: response.status, body: await response.json() as { ok: boolean } };
    });
    expect(selfApprove.body.ok).toBe(false);
    await shot(page, "10-prepared", ".finance-handoff-trace");
    await signOut(page);

    // 12-13. A different Finance employee approves and posts; the journal and reconciliation read back.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/handoffs");
    await page.locator(".finance-handoff-list button", { hasText: RECEIPT }).click();
    await page.getByRole("button", { name: "Approve (independent review)" }).click();
    await expect(page.locator(".finance-journey li.done")).toHaveCount(4);
    await page.getByRole("button", { name: "Post to General Ledger" }).click();
    await expect(page.locator(".finance-journey li.done")).toHaveCount(5);
    await expect(page.locator(".finance-journal p.ok")).toBeVisible();
    await shot(page, "11-posted-journal-reconciled", ".finance-journal");
    await signOut(page);

    // 15. The administrator sees the permission changes and the audit trail.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await page.goto("/admin/users");
    await page.locator(".admin-list > button", { hasText: "Synthetic Receipt Officer" }).click();
    await expect(page.locator(".admin-user-panel")).toContainText("Record cash received");
    await expect(page.locator(".admin-audit")).toContainText("Employee account created");
    await expect(page.locator(".admin-audit")).toContainText("Password changed by the employee");
    await shot(page, "12-employee-access-and-history", ".admin-user-panel");
    await page.getByRole("tab", { name: "Access history" }).click();
    await expect(page.locator(".admin-history")).toContainText("Role created");
    await shot(page, "13-access-history", ".admin-history");

    // Suspension takes effect at once.
    await page.getByRole("tab", { name: /Employees/ }).click();
    await page.locator(".admin-list > button", { hasText: "Synthetic Receipt Officer" }).click();
    await page.getByRole("button", { name: "Suspend account" }).click();
    await page.getByRole("button", { name: "Yes, suspend" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("suspended");

    // 16. Dari, right to left, on desktop and phone width.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.goto("/admin/roles");
    await page.locator(".admin-list > button", { hasText: "Cash Receipt Officer" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await shot(page, "14-roles-dari-rtl");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await page.waitForTimeout(800);
    await shot(page, "15-dashboard-dari-mobile");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to English" }).click();
  });
});

async function shot(page: Page, name: string, focus?: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (focus) {
    const target = page.locator(focus).first();
    // Leave room for the sticky top bar.
    if (await target.count() > 0) await target.evaluate((element) => { element.scrollIntoView({ block: "start" }); window.scrollBy(0, -96); });
  }
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
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
  const environment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) environment[match[1]] = match[2];
  }
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: { ...process.env, ...environment }, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}
