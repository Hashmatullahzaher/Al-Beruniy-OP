import { expect, test, type Page } from "@playwright/test";

// The Documents page is real V1: a guide to where each kind of document is kept. It is served on every build.

/** Streaming keeps a hidden copy of the page in #S:0 until it is swapped in; strict locators must not race it. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => document.querySelector('[id^="S:"]') === null);
}

test("Documents says where each kind of document is kept, opens nothing itself, and shows no demo data", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  const places = page.getByRole("region", { name: "Where documents are kept" });
  for (const [name, href] of [["Company", "/admin/company"], ["Shareholders", "/shareholders"], ["Capital agreements", "/shareholders/legacy"], ["Loans", "/finance/loans"],
    ["Expenses", "/finance/transactions"], ["Receipts and payments", "/finance/safe-statement"]] as const) {
    await expect(places.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  }
  await expect(page.getByRole("region", { name: "Security check" })).toContainText("Until the check passes, the file stays locked.");
  await expect(page.getByRole("main")).not.toContainText(/DEMO|Stage 0|synthetic/i);
  await expect(page.getByRole("main").getByRole("link", { name: /download|view/i })).toHaveCount(0);
});

test("Documents remains usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page, "/documents");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "اسناد" })).toBeVisible();
  await expect(page.getByRole("region", { name: "جای اسناد" }).getByRole("link", { name: "قرض‌ها", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
});
