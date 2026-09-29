import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V1 journal reversals (WP #17) through the real sign-in, administration and restricted Finance login.
 * A Finance user requests; the Finance Manager approves; posting the reversal awaits the Finance
 * Manager's policy, so nothing is posted. Reseeds the disposable dev database:
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-reversals --workers=1
 * Every person, journal and amount is synthetic.
 */
const ROOT = resolve(__dirname, "../../..");
const SHOTS = resolve(__dirname, "../test-results/v1-reversals");

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 journal reversals", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run this.");

  test("a Finance user requests a reversal, the Finance Manager approves it, and nothing is posted", async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const { accounts, journal } = seedPreview();
    expect(journal).toMatch(/^JRN-/);

    // The Super Administrator creates a requester role and an approver role and assigns them.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await createRole(page, "Reversal Requester", ["Request journal reversals"]);
    await createRole(page, "Reversal Approver", ["Approve journal reversals"]);
    await assignRole(page, "Synthetic Intent Creator", "Reversal Requester");
    await assignRole(page, "Synthetic Finance Approver", "Reversal Approver");
    await signOut(page);

    // The Finance user chooses the posted journal and asks for its reversal with a reason.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.getByRole("link", { name: "Journal reversals" }).click();
    await expect(page).toHaveURL(/\/finance\/reversals/);
    await expect(page.getByText("REVERSAL POSTING IS NOT ENABLED · SYNTHETIC DATA")).toBeVisible();
    await expect(page.getByRole("region", { name: "Reversal posting status" })).toContainText("posting policy");
    await page.getByRole("tab", { name: /Request a reversal/ }).click();
    const card = page.getByRole("article", { name: `Journal ${journal}` });
    await expect(card).toContainText("Shareholder capital receipt");
    await expect(card).toContainText("Synthetic Earlier Poster");
    // Exact decimal text, grouped for display only.
    await expect(card.getByText("USD 25,000.00").first()).toBeVisible();
    await card.getByRole("button", { name: "Choose" }).click();
    const form = page.getByRole("form", { name: "Reversal request form" });
    await form.getByLabel("Reason for the reversal (10–1000 characters)").fill("short");
    await expect(form.getByRole("button", { name: "Send request" })).toBeDisabled();
    await form.getByLabel("Reason for the reversal (10–1000 characters)").fill("Synthetic: posted against the wrong installment");
    await page.screenshot({ path: resolve(SHOTS, "01-request-form.png") });
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("waits for the Finance Manager's decision");
    const request = page.getByRole("article", { name: `Reversal request ${journal}` });
    await expect(request).toContainText("Awaiting decision");
    await expect(request).toContainText("Requested by you");
    await expect(request.getByRole("button", { name: "Withdraw request" })).toBeVisible();
    // The requester cannot decide: the API refuses without the approve permission.
    const selfDecision = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/finance/reversals")).json() as { data: { requests: { id: string; version: number }[] } };
      const item = list.data.requests[0];
      const response = await fetch(`/api/v1/finance/reversals/${item?.id ?? ""}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "APPROVED", expectedVersion: item?.version ?? 0 })
      });
      return response.status;
    });
    expect(selfDecision).toBe(403);
    await page.screenshot({ path: resolve(SHOTS, "02-requested.png") });
    await signOut(page);

    // The Finance Manager approves. The approval posts nothing.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    const ledgerBefore = await ledgerLines(page);
    await page.goto("/finance/reversals");
    await expect(page.getByRole("tab", { name: /Request a reversal/ })).toHaveCount(0);
    const waiting = page.getByRole("article", { name: `Reversal request ${journal}` });
    await expect(waiting).toContainText("Synthetic: posted against the wrong installment");
    await expect(waiting).toContainText("Requested by Synthetic Intent Creator");
    await expect(waiting.getByRole("button", { name: "Reject reversal" })).toBeDisabled();
    await waiting.getByLabel("Note (required to reject)").fill("Synthetic: checked against the installment schedule");
    await waiting.getByRole("button", { name: "Approve reversal" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("nothing was posted");
    const approved = page.getByRole("article", { name: `Reversal request ${journal}` });
    await expect(approved).toContainText("Approved · awaits posting policy");
    await expect(approved.getByRole("note")).toContainText("No reversal journal has been created and the original journal is unchanged.");
    await expect(approved).toContainText("Decided by you");
    await expect(approved.getByRole("button", { name: /Approve reversal|Reject reversal/ })).toHaveCount(0);
    await page.screenshot({ path: resolve(SHOTS, "03-approved-awaiting-policy.png") });

    // Posting is fail-closed through the API as well, and the General Ledger is unchanged.
    const posting = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/finance/reversals")).json() as { data: { requests: { id: string }[] } };
      const response = await fetch(`/api/v1/finance/reversals/${list.data.requests[0]?.id ?? ""}/post`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      return { status: response.status, body: await response.json() as { ok: boolean; error: { code: string } } };
    });
    expect(posting.status).toBe(409);
    expect(posting.body.error.code).toBe("POSTING_POLICY_PENDING");
    expect(await ledgerLines(page)).toEqual(ledgerBefore);
    expect(ledgerBefore.length).toBe(2);

    // Dari, right to left, at phone width.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.getByRole("heading", { name: "برگشت ژورنال‌ها" })).toBeVisible();
    await expect(page.getByText("تایید شد · در انتظار پالیسی ثبت")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // At phone width the navigation becomes a closed drawer (after a short transition).
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.getByRole("article", { name: `درخواست برگشت ${journal}` })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: resolve(SHOTS, "04-phone-dari.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to English" }).click();
  });
});

/** The posted General Ledger lines for September 2026, as decimal text. */
async function ledgerLines(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/finance/general-ledger?from=2026-09-01&to=2026-09-30");
    const body = await response.json() as { data: { lines: { journalReference: string; lineNumber: number; baseDebit: string; baseCredit: string }[] } };
    return body.data.lines.map((line) => `${line.journalReference}#${line.lineNumber} ${line.baseDebit}/${line.baseCredit}`).sort();
  });
}

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

function seedPreview(): { accounts: Record<string, string>; journal: string } {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment);
  const env = environment as NodeJS.ProcessEnv;
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: ROOT, env, encoding: "utf8", shell: process.platform === "win32"
  });
  const fixture = execFileSync("node", ["--experimental-strip-types", "packages/e1-integration/src/reversal-preview-fixture.ts"], {
    cwd: ROOT, env, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return { accounts, journal: /JOURNAL_REFERENCE=(\S+)/.exec(fixture)?.[1] ?? "" };
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
