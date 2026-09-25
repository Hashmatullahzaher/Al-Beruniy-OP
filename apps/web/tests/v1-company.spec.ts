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
    await expect(page.getByRole("navigation", { name: "V1 preview" }).getByRole("link", { name: "Company" })).toBeVisible();
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
