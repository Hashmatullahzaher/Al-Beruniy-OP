import { expect, test, type Locator, type Page } from "@playwright/test";

/** Memory-only review harness: no database setup, seed, credentials or business API requests. */
test.use({ viewport: { width: 1440, height: 1000 } });

async function openReview(page: Page): Promise<string[]> {
  const businessRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/me") {
      await route.fulfill({ json: { ok: true, data: {
        userAccountId: "review-session-user", loginIdentifier: "review-only", displayName: "Synthetic Review User",
        jobTitle: "Interface reviewer", legalEntityName: "Synthetic review entity", permissions: [],
        sessionExpiresAt: "2099-01-01T00:00:00Z"
      } } });
      return;
    }
    businessRequests.push(`${route.request().method()} ${path}`);
    await route.fulfill({ status: 403, json: { ok: false, error: { code: "REVIEW_ONLY", message: "No business API in this test." } } });
  });
  await page.goto("/finance/capital-bridge-review");
  await expect(page.getByRole("heading", { level: 1, name: "Shareholder capital → Finance" })).toBeVisible();
  return businessRequests;
}

function contribution(page: Page, id: string): Locator {
  return page.locator(`article[data-contribution-id="${id}"]`);
}

async function recordReceipt(page: Page, id: string, amount: string): Promise<void> {
  await page.getByLabel("Simulated role", { exact: true }).selectOption("TREASURY_RECORDER");
  const card = contribution(page, id);
  await card.getByRole("button", { name: "Record receipt (simulation)", exact: true }).click();
  const form = card.getByRole("form", { name: "Receipt details", exact: true });
  await form.getByLabel("Amount", { exact: true }).fill(amount);
  await form.getByLabel("Receiving account", { exact: true }).selectOption("DEMO-USD-SAFE");
  await form.getByLabel("Payment / receipt reference (optional)").fill("SYN-PAYMENT-1");
  await form.getByRole("button", { name: "Simulate receipt", exact: true }).click();
  await expect(form).toHaveCount(0);
}

test("@smoke isolated bridge keeps declarations, legacy commitment and cancelled history separate", async ({ page }) => {
  const requests = await openReview(page);
  await expect(page.getByRole("region", { name: "Isolated review boundary" })).toContainText("DEMO DATA");
  for (const id of ["SYN-C1", "SYN-C2", "SYN-C3"]) {
    await expect(contribution(page, id).locator('[data-figure="received"]')).toContainText("USD 0");
    await expect(contribution(page, id).locator('[data-figure="posted"]')).toContainText("USD 0");
    await expect(contribution(page, id)).toContainText("Not received · Not posted");
  }
  await expect(contribution(page, "SYN-C1").locator('[data-figure="declared"]')).toContainText("USD 50,000");
  await expect(contribution(page, "SYN-C2").locator('[data-figure="declared"]')).toContainText("USD 50,000");
  await expect(page.getByTestId("bridge-legacy-commitment")).toContainText("USD 20,000");
  await expect(page.getByTestId("bridge-cancelled-installment")).toContainText("USD 5,000");
  await expect(page.getByRole("button", { name: "Record receipt (simulation)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Simulate posting" })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("partial receipts, independent review and one simulation posting follow separate steps", async ({ page }) => {
  const requests = await openReview(page);
  await recordReceipt(page, "SYN-C1", "12500.25");
  const first = contribution(page, "SYN-C1");
  await expect(first.locator('[data-figure="received"]')).toContainText("USD 12,500.25");
  await expect(first.locator('[data-figure="outstanding"]')).toContainText("USD 37,499.75");
  await expect(first.locator('[data-figure="posted"]')).toContainText("USD 0");
  await expect(first.getByRole("button", { name: "Review receipt" })).toHaveCount(0);
  await expect(first.getByRole("button", { name: "Simulate posting" })).toHaveCount(0);

  await page.getByLabel("Simulated role", { exact: true }).selectOption("FINANCE_REVIEWER");
  await first.getByRole("button", { name: "Review receipt", exact: true }).click();
  await first.getByRole("button", { name: "Simulate approval", exact: true }).click();
  await expect(first).toContainText("Approved · Not posted");
  await expect(first.locator('[data-figure="posted"]')).toContainText("USD 0");
  await expect(first).toContainText("Posting blocked");
  await expect(first.getByRole("button", { name: "Simulate posting" })).toHaveCount(0);
  await page.getByLabel("Use illustrative accounting configuration", { exact: false }).check();
  await first.getByRole("button", { name: "Simulate posting", exact: true }).click();
  await expect(first.locator('[data-figure="posted"]')).toContainText("USD 12,500.25");
  await expect(first.getByRole("button", { name: "Simulate posting" })).toHaveCount(0);
  await expect(first.getByRole("button", { name: "Reverse", exact: true })).toBeDisabled();
  await expect(page.locator('[data-audit-action="POST"]')).toHaveCount(1);
  await expect(contribution(page, "SYN-C2").locator('[data-figure="received"]')).toContainText("USD 0");
  await expect(page.getByTestId("bridge-legacy-commitment")).toContainText("USD 20,000");

  await recordReceipt(page, "SYN-C1", "37499.75");
  await expect(first.locator("[data-receipt-id]")).toHaveCount(2);
  await expect(first.locator('[data-figure="received"]')).toContainText("USD 50,000");
  await expect(first.locator('[data-figure="outstanding"]')).toContainText("USD 0");
  await expect(first.getByRole("button", { name: "Record receipt (simulation)" })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("invalid amount, over-receipt and currency mismatch are refused without a receipt", async ({ page }) => {
  const requests = await openReview(page);
  await page.getByLabel("Simulated role", { exact: true }).selectOption("TREASURY_RECORDER");
  const first = contribution(page, "SYN-C1");
  await first.getByRole("button", { name: "Record receipt (simulation)" }).click();
  const form = first.getByRole("form", { name: "Receipt details", exact: true });
  await form.getByLabel("Receiving account", { exact: true }).selectOption("DEMO-USD-SAFE");
  await form.getByLabel("Amount", { exact: true }).fill("50000.01");
  await form.getByRole("button", { name: "Simulate receipt", exact: true }).click();
  await expect(page.locator(".treasury-message[role=alert]")).toContainText("exceeds the outstanding");
  await form.getByLabel("Amount", { exact: true }).fill("1e3");
  await form.getByRole("button", { name: "Simulate receipt", exact: true }).click();
  await expect(page.locator(".treasury-message[role=alert]")).toContainText("positive decimal");
  await form.getByLabel("Amount", { exact: true }).fill("1000");
  await form.getByLabel("Currency", { exact: true }).selectOption("AFN");
  await form.getByRole("button", { name: "Simulate receipt", exact: true }).click();
  await expect(page.locator(".treasury-message[role=alert]")).toContainText("must match this declaration");
  await expect(first.locator("[data-receipt-id]")).toHaveCount(0);
  await expect(page.locator("[data-audit-action]")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("rejected receipt remains in received history with no posting, refresh clears only simulation", async ({ page }) => {
  const requests = await openReview(page);
  await recordReceipt(page, "SYN-C3", "1000");
  await page.getByLabel("Simulated role", { exact: true }).selectOption("FINANCE_REVIEWER");
  const card = contribution(page, "SYN-C3");
  await card.getByRole("button", { name: "Review receipt" }).click();
  await expect(card.getByRole("button", { name: "Reject receipt" })).toBeDisabled();
  await card.getByLabel("Rejection reason (required to reject)").fill("Illustrative reference requires correction");
  await card.getByRole("button", { name: "Reject receipt", exact: true }).click();
  await expect(card).toContainText("Rejected · Not posted");
  await expect(card.locator('[data-figure="received"]')).toContainText("USD 1,000");
  await expect(card.locator('[data-figure="posted"]')).toContainText("USD 0");
  await expect(card.getByRole("button", { name: "Simulate posting" })).toHaveCount(0);
  await expect(page.locator('[data-audit-action="REJECT"]')).toHaveCount(1);
  await page.reload();
  await expect(card.locator('[data-figure="received"]')).toContainText("USD 0");
  await expect(page.locator("[data-audit-action]")).toHaveCount(0);
  await expect(page.getByTestId("bridge-cancelled-installment")).toContainText("USD 5,000");
  expect(requests).toEqual([]);
});

test("Dari RTL and phone/tablet layouts retain readable controls and keyboard form access", async ({ page }) => {
  const requests = await openReview(page);
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "سرمایه سهامداران ← مالی" })).toBeVisible();
  await page.getByLabel("نقش شبیه‌سازی‌شده", { exact: true }).selectOption("TREASURY_RECORDER");
  await contribution(page, "SYN-C1").getByRole("button", { name: "ثبت دریافت (شبیه‌سازی)", exact: true }).click();
  const form = page.getByRole("form", { name: "جزئیات دریافت", exact: true });
  await expect(form.getByLabel("مبلغ", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByLabel("واحد پول", { exact: true })).toBeFocused();
  for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(form.getByLabel("حساب دریافت‌کننده", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("form", { name: "Receipt details", exact: true }).getByLabel("Amount", { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});
