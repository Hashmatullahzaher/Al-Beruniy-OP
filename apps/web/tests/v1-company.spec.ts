import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/** Lead (#8): company configuration. Reseeds the dev database; gated like the other V1 journeys. */
test.use({ viewport: { width: 1440, height: 900 } });

test.describe("V1 company configuration", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run this.");

  test("any employee sees the company details; owner data shows as pending and nothing is guessed", async ({ page }) => {
    test.setTimeout(180_000);
    const accounts = seedPreview();
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    await expect(page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Company" })).toBeVisible();
    await page.goto("/admin/company");
    const legal = page.locator(".company-card").first();
    await expect(legal.getByText("Pending from owner")).toHaveCount(3);
    await expect(page.getByRole("form", { name: "Edit company details" })).toHaveCount(0);
    const money = page.locator(".company-card").nth(1);
    await expect(money).toContainText("USD");
    await expect(money).toContainText("AFN");
    const refused = await page.evaluate(async () => (await fetch("/api/v1/admin/company", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalName: "Hijack", expectedVersion: 0 })
    })).status);
    expect(refused).toBe(403);
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(legal.getByText("در انتظار مالک")).toHaveCount(3);
    await page.getByRole("button", { name: "Switch to English" }).click();
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

function seedPreview(): Record<string, string> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win, so every runtime can point at one isolated preview DB; the seed
  // never runs unless both the owner and identity logins name the same disposable preview database.
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
