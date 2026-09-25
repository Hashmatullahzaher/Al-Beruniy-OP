import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Exercises the real Finance HTTP handlers and restricted PostgreSQL login.
 * This reseeds the disposable dev sandbox, so run it separately from other DB tests.
 */
test.describe("Finance handoff against the dev sandbox", () => {
  test.skip(process.env.ABOS_FINANCE_BROWSER_E2E !== "1", "Set ABOS_FINANCE_BROWSER_E2E=1 to reseed the dev sandbox and run this.");

  test("a Finance preparer can load the handed-off receipt and its persisted trace", async ({ page }) => {
    test.setTimeout(60_000);
    const tokens = seedDevSandbox();

    await treasurySignIn(page, tokens["Synthetic Cashier"] ?? "");
    await page.getByRole("tab", { name: /Shareholder intents/ }).click();
    const firstIntent = page.locator(".treasury-table tbody tr").first();
    await firstIntent.getByPlaceholder("Receipt ref.").fill("RCPT-FINANCE-BROWSER-0001");
    await firstIntent.getByRole("button", { name: "Record cash received" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Received · not counted");
    await page.getByLabel(/Counted amount/).fill("25000.00");
    await page.getByRole("button", { name: "Record physical count" }).click();
    await page.getByRole("button", { name: "Submit for independent verification" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Awaiting independent verification");

    await treasurySignOut(page);
    await treasurySignIn(page, tokens["Synthetic Count Confirmer"] ?? "");
    await page.locator(".treasury-receipt-list button").first().click();
    await page.getByRole("button", { name: "Confirm count and verify receipt" }).click();
    await page.getByRole("button", { name: "Hand verified receipt to Finance" }).click();
    await expect(page.locator(".treasury-receipt-detail header")).toContainText("Handed to Finance · not approved");
    await treasurySignOut(page);

    await page.goto("/finance/handoffs");
    await page.getByLabel("Sandbox token").fill(tokens["Synthetic Intent Creator"] ?? "");
    await page.getByRole("button", { name: "Sign in" }).click();

    // These assertions require both finance_handoff_workspace and finance_handoff_trace
    // to execute successfully through the restricted role. The old qualified COALESCE
    // fails at this point with PostgreSQL 42883.
    await expect(page.locator(".treasury-identity strong")).toContainText("Synthetic Intent Creator");
    const handoff = page.getByRole("button", { name: /RCPT-FINANCE-BROWSER-0001/ });
    await expect(handoff).toContainText("USD 25,000.00");
    const traceResponse = page.waitForResponse(response =>
      response.url().includes("/api/v1/finance/handoffs/") && response.request().method() === "GET"
    );
    await handoff.click();
    const response = await traceResponse;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator(".finance-handoff-trace")).toContainText("RCPT-FINANCE-BROWSER-0001");
    await expect(page.locator(".finance-handoff-trace")).toContainText("Cash verified by Treasury");
    await expect(page.locator(".finance-reconciliation")).toContainText("Not posted yet");
    await expect(page.getByRole("button", { name: "Prepare journal for approval" })).toBeVisible();
  });
});

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
