import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Treasury (E1 synthetic sandbox) in a real browser.
 *
 * The smoke test holds whether or not a sandbox database is configured: with none, the page must
 * say so and show nothing; with one, it must demand a session. Neither case may show a figure.
 *
 * The workflow test drives the real UI through the real API into PostgreSQL. It reseeds the DEV
 * sandbox database named in apps/web/.env.local, so it runs only when ABOS_TREASURY_BROWSER_E2E=1.
 */

test("@smoke Treasury has no default user, refuses a forged session and shows no figures unauthenticated", async ({ page, request }) => {
  const api = await request.get("/api/v1/treasury/overview");
  expect([401, 503]).toContain(api.status());
  const body = (await api.json()) as { ok: boolean; error: { code: string } };
  expect(body.ok).toBe(false);
  expect(["AUTHENTICATION_REQUIRED", "TREASURY_UNAVAILABLE"]).toContain(body.error.code);

  await page.goto("/finance/treasury");
  await expect(page.getByRole("heading", { level: 1, name: "Treasury" })).toBeVisible();
  await expect(page.getByText("SYNTHETIC SANDBOX DATA ONLY")).toBeVisible();
  await expect(page.locator(".treasury-signin, .treasury-placeholder").first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/USD\s[\d,]+\.\d\d/);

  if (api.status() === 401) {
    await page.getByLabel("Session token").fill("forged-token-that-was-never-issued");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("Unknown sandbox session");
    await expect(page.locator(".treasury-identity")).toHaveCount(0);
  }
});

test("@smoke Finance links to the Treasury workspace", async ({ page }) => {
  await page.goto("/finance");
  await page.getByRole("tab", { name: "Treasury" }).click();
  await page.getByRole("link", { name: "Open Treasury" }).click();
  await expect(page).toHaveURL(/\/finance\/treasury$/);
});

test.describe("Treasury workflow against the dev sandbox", () => {
  test.skip(process.env.ABOS_TREASURY_BROWSER_E2E !== "1", "Set ABOS_TREASURY_BROWSER_E2E=1 to reseed the dev sandbox and run this.");
  test.describe.configure({ mode: "serial" });

  let tokens: Record<string, string> = {};

  test.beforeAll(() => {
    tokens = seedDevSandbox();
  });

  test("cashier records and counts, an independent verifier verifies and hands off to Finance", async ({ page }) => {
    await signIn(page, tokens["Synthetic Cashier"] ?? "");
    await expect(page.locator(".treasury-identity strong")).toHaveText("Synthetic Cashier");

    // Independent USD and AFN accounts; no balance is presented.
    await page.getByRole("tab", { name: /Safes & accounts/ }).click();
    const usd = page.locator(".treasury-account", { hasText: "USD" });
    await expect(usd).toContainText("Active");
    await expect(page.locator(".treasury-account", { hasText: "AFN" })).toContainText("Draft · not reconciled");
    await expect(page.getByText("No balance is shown.")).toBeVisible();

    // Record cash against an eligible shareholder intent.
    await page.getByRole("tab", { name: /Shareholder intents/ }).click();
    const firstIntent = page.locator(".treasury-table tbody tr").first();
    await firstIntent.getByPlaceholder("Receipt ref.").fill("RCPT-PW-0001");
    await firstIntent.getByRole("button", { name: "Record cash received" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Cash receipt recorded");
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Received · not counted");

    // A short count is refused; the correct count is accepted.
    await page.getByLabel(/Counted amount/).fill("24999.99");
    await page.getByRole("button", { name: "Record physical count" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("below the received amount");
    await page.getByLabel(/Counted amount/).fill("25000.00");
    await page.getByRole("button", { name: "Record physical count" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Counted · not submitted");

    await page.getByRole("button", { name: "Submit for independent verification" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Awaiting independent verification");
    await expect(page.locator(".treasury-actions")).toContainText("You received this cash, so you cannot verify it.");
    await expect(page.getByRole("button", { name: "Confirm count and verify receipt" })).toHaveCount(0);

    // Bypassing the interface does not help: the server refuses the cashier.
    const receiptId = await page.evaluate(async () => {
      const overview = (await (await fetch("/api/v1/treasury/overview")).json()) as { data: { receipts: { id: string }[] } };
      return overview.data.receipts[0]?.id ?? "";
    });
    const selfVerify = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/treasury/receipts/${id}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return response.status;
    }, receiptId);
    expect(selfVerify).toBe(403);

    // The independent verifier.
    await signOut(page);
    await signIn(page, tokens["Synthetic Count Confirmer"] ?? "");
    await page.locator(".treasury-receipt-list button").first().click();
    await page.getByRole("button", { name: "Confirm count and verify receipt" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Verified · not handed to Finance");
    await page.getByRole("button", { name: "Hand verified receipt to Finance" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Nothing has been posted");
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Handed to Finance · not posted");

    // The trace preserves the source; Finance posting is shown as not done.
    const chain = page.locator(".treasury-chain");
    await expect(chain).toContainText("Synthetic Shareholder One");
    await expect(chain).toContainText("TREASURY_VERIFIED");
    await expect(chain).toContainText("Not posted");
    const history = page.locator(".treasury-history li strong");
    await expect(history).toHaveText(["DRAFT", "RECORDED", "DRAFT → COUNTED", "COUNTED → SUBMITTED FOR VERIFICATION", "RECORDED → CONFIRMED", "COUNTED → VERIFIED", "READY_FOR_FINANCE"]);
  });

  test("a Finance user without Treasury grants sees no Treasury records", async ({ page }) => {
    await signIn(page, tokens["Synthetic Finance Approver"] ?? "");
    await expect(page.locator(".treasury-identity")).toContainText("No Treasury permission");
    await expect(page.getByText("holds no treasury.read grant")).toBeVisible();
    await expect(page.locator(".treasury-receipt-list")).toHaveCount(0);
  });

  test("signing out revokes the session: the cashier's token cannot be reused", async ({ page }) => {
    await page.goto("/finance/treasury");
    await page.getByLabel("Session token").fill(tokens["Synthetic Cashier"] ?? "");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("revoked");
    await expect(page.locator(".treasury-identity")).toHaveCount(0);
  });

  test("the Treasury workspace works in Dari RTL at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, tokens["Synthetic Treasury Manager"] ?? "");
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText("فقط داده‌های مصنوعی آزمایشی")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

async function signIn(page: Page, token: string): Promise<void> {
  expect(token.length).toBeGreaterThan(20);
  await page.goto("/finance/treasury");
  await page.getByLabel("Session token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".treasury-identity")).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Session token")).toBeVisible();
}

/** Reseeds the dev sandbox named in apps/web/.env.local and returns one token per persona. */
function seedDevSandbox(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) environment[match[1]] = match[2];
  }
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "sandbox:seed"], {
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, ...environment },
    encoding: "utf8",
    shell: process.platform === "win32"
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
