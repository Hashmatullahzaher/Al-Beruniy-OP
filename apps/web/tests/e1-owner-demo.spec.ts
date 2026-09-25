import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The E1 owner demonstration, end to end, through the real UI and the real restricted services:
 * Shareholder intent -> Treasury receipt, count, verification, handoff -> Finance posting intent,
 * independent approval, restricted posting -> journal and reconciliation read back.
 *
 * Nothing is mocked. It reseeds the disposable dev sandbox (synthetic data only), so it is gated
 * and must run on its own: ABOS_OWNER_DEMO=1 pnpm exec playwright test e1-owner-demo --workers=1
 * Screenshots land in test-results/owner-demo/ for the presenter.
 */
const SHOTS = resolve(__dirname, "../test-results/owner-demo");

test.use({ viewport: { width: 1440, height: 900 }, video: { mode: "on", size: { width: 1440, height: 900 } } });

test.describe("E1 owner demonstration", () => {
  test.skip(process.env.ABOS_OWNER_DEMO !== "1", "Set ABOS_OWNER_DEMO=1 to reseed the dev sandbox and run the owner demo.");

  test("a verified cash receipt travels from the safe to a posted, reconciled journal", async ({ page }) => {
    test.setTimeout(180_000);
    mkdirSync(SHOTS, { recursive: true });
    const tokens = seedDevSandbox();
    const reference = "RCPT-OWNER-DEMO-0001";

    // 1-2. The cashier opens the synthetic shareholder agreement and picks the eligible USD installment.
    await treasurySignIn(page, tokens["Synthetic Cashier"] ?? "");
    await page.getByRole("tab", { name: /Shareholder intents/ }).click();
    const installment = page.locator(".treasury-table tbody tr").first();
    await expect(installment).toContainText("USD");
    await shot(page, "01-shareholder-installment");

    // 3. Cash received into the active safe's USD account.
    await installment.getByPlaceholder("Receipt ref.").fill(reference);
    await installment.getByRole("button", { name: "Record cash received" }).click();
    const header = page.locator(".treasury-receipt-detail header");
    await expect(header).toContainText("Received · not counted");
    await shot(page, "02-cash-recorded");

    // 4. Physical count with its evidence, then submission for independent verification.
    await page.getByLabel(/Counted amount/).fill("25000.00");
    await page.getByRole("button", { name: "Record physical count" }).click();
    await page.getByRole("button", { name: "Submit for independent verification" }).click();
    await expect(header).toContainText("Awaiting independent verification");
    await shot(page, "03-counted-awaiting-verification");
    await treasurySignOut(page);

    // 5-6. A different person verifies and hands the receipt to Finance.
    await treasurySignIn(page, tokens["Synthetic Count Confirmer"] ?? "");
    await page.locator(".treasury-receipt-list button").first().click();
    await page.getByRole("button", { name: "Confirm count and verify receipt" }).click();
    await expect(header).toContainText(/Verified/);
    await shot(page, "04-verified");
    await page.getByRole("button", { name: "Hand verified receipt to Finance" }).click();
    await expect(header).toContainText("Handed to Finance · not approved");
    await shot(page, "05-handed-to-finance");
    await treasurySignOut(page);

    // 7-8. The Finance preparer opens the handoff and prepares the posting intent.
    await financeSignIn(page, tokens["Synthetic Intent Creator"] ?? "");
    const handoff = page.locator(".finance-handoff-list button", { hasText: reference });
    await handoff.click();
    const trace = page.locator(".finance-handoff-trace");
    await expect(trace).toContainText(reference);
    await shot(page, "06-finance-handoff-opened");
    await expect(trace.locator(".finance-journey li.done")).toHaveCount(3);
    await page.getByRole("button", { name: "Prepare journal for approval" }).click();
    await expect(trace.locator(".finance-records li").first()).toContainText(/Prepared\s*You/);
    await expect(handoff).toContainText("Prepared · awaiting independent approval");
    // The preparer cannot approve their own work.
    await expect(page.getByRole("button", { name: "Approve (independent review)" })).toHaveCount(0);
    await shot(page, "07-posting-intent-prepared");
    await financeSignOut(page);

    // 9. A different Finance user approves.
    await financeSignIn(page, tokens["Synthetic Finance Approver"] ?? "");
    await page.locator(".finance-handoff-list button", { hasText: reference }).click();
    await page.getByRole("button", { name: "Approve (independent review)" }).click();
    await expect(trace.locator(".finance-journey li.done")).toHaveCount(4);
    await expect(trace.locator(".finance-records li").nth(1)).toContainText(/Approved\s*You/);
    // The preparer is a different person from the approver.
    await expect(trace.locator(".finance-records li").first()).not.toContainText("You");
    await shot(page, "08-approved");

    // 10-11. Posting through the restricted Finance gateway; the journal and reconciliation read back.
    await page.getByRole("button", { name: "Post to General Ledger" }).click();
    await expect(trace.locator(".finance-journey li.done")).toHaveCount(5);
    await expect(trace.locator(".finance-journal")).toContainText("25,000.00");
    await expect(trace.locator(".finance-journal p.ok")).toBeVisible();
    await expect(trace.locator(".finance-reconciliation")).toContainText("Posted");
    await expect(page.getByRole("button", { name: "Post to General Ledger" })).toHaveCount(0);
    await shot(page, "09-posted-journal-reconciled", ".finance-journal");

    // The same record in Dari, right to left, and on a phone.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(trace.locator(".finance-journal")).toContainText("متوازن");
    await expect(page.locator(".treasury-message")).toContainText("ثبت شد");
    await shot(page, "10-posted-dari-rtl", ".finance-journal");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_000); // let the RTL drawer finish sliding off-canvas before capturing
    await shot(page, "11-posted-dari-mobile", ".finance-journey");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to English" }).click();

    // Treasury sees Finance's outcome without having posted anything itself. Sign-out revoked the
    // earlier sessions, so a Treasury person who has not signed in yet looks.
    await financeSignOut(page);
    await treasurySignIn(page, tokens["Synthetic Treasury Manager"] ?? "");
    await page.locator(".treasury-receipt-list button").first().click();
    await expect(header).toContainText("Posted by Finance");
    await shot(page, "12-treasury-sees-posted");
  });
});

/** A viewport capture, scrolled to the part of the page the step is about. */
async function shot(page: Page, name: string, focus = ".finance-handoff-trace, .treasury-receipt-detail, .treasury-table"): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const target = page.locator(focus).first();
  if (await target.count() > 0) await target.evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function treasurySignIn(page: Page, token: string): Promise<void> {
  expect(token.length).toBeGreaterThan(20);
  await page.goto("/finance/treasury");
  await page.getByLabel("Session token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".treasury-identity")).toBeVisible();
}

async function treasurySignOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Session token")).toBeVisible();
}

async function financeSignIn(page: Page, token: string): Promise<void> {
  expect(token.length).toBeGreaterThan(20);
  await page.goto("/finance/handoffs");
  await page.getByLabel("Sandbox token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".treasury-identity")).toBeVisible();
}

async function financeSignOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Sandbox token")).toBeVisible();
}

function seedDevSandbox(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) environment[match[1]] = match[2];
  }
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "sandbox:seed"], {
    cwd: resolve(__dirname, "../../.."), env: { ...process.env, ...environment },
    encoding: "utf8", shell: process.platform === "win32"
  });
  const tokens: Record<string, string> = {};
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const name = /^(Synthetic [A-Za-z ]+?)\s{2,}/.exec(lines[index] ?? "")?.[1];
    const token = lines[index + 1]?.trim();
    if (name !== undefined && token !== undefined && /^[A-Za-z0-9_-]{20,}$/.test(token)) tokens[name] = token;
  }
  return tokens;
}
