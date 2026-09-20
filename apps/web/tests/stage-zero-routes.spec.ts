import { expect, test } from "@playwright/test";

test("Projects supports filtering, search and accessible project selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/projects");

  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current project context" }).getByText("DEMO DATA", { exact: true })).toBeVisible();
  await expect(page.getByText("Services not connected", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Planning/ }).click();
  await expect(page.getByRole("button", { name: "Select BAQI Tower demo project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Mazar Mall demo project" })).toBeHidden();

  await page.getByRole("textbox", { name: "Search demo projects" }).fill("BAQI");
  await page.getByRole("button", { name: "Select BAQI Tower demo project" }).click();
  await expect(page.locator(".project-detail-panel").getByRole("heading", { level: 2, name: "BAQI Tower" })).toBeVisible();

  const overflow = await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBeFalsy();
});

test("Sales and CRM switches protected Stage 0 sections and filters demo leads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/sales-crm");

  await expect(page.getByRole("heading", { level: 1, name: "Sales & CRM" })).toBeVisible();
  await expect(page.getByText(/no reservation, posting, receipt, or verified customer action/i)).toBeVisible();

  await page.getByRole("tab", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "No verified customers connected" })).toBeVisible();
  await page.getByRole("tab", { name: "Contracts" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "No operational contracts connected" })).toBeVisible();
  await page.getByRole("tab", { name: /Lead pipeline/ }).click();

  await page.getByRole("textbox", { name: "Search demo leads" }).fill("L004");
  const lead = page.getByRole("button", { name: "Select DEMO-L004 presentation fixture" });
  await expect(lead).toBeVisible();
  await expect(page.getByRole("button", { name: "Select DEMO-L001 presentation fixture" })).toBeHidden();
  await lead.click();
  await expect(page.locator(".lead-detail-panel").getByRole("heading", { level: 2, name: "DEMO-L004" })).toBeVisible();
});

test("Projects and Sales remain usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/projects");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "پروژه‌ها" })).toBeVisible();

  await page.goto("/sales-crm");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "فروش و مشتریان" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("Finance exposes its intended structure without operational financial actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/finance");

  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();
  await expect(page.getByText("INTERFACE PREVIEW ONLY")).toBeVisible();
  await expect(page.getByText("Stage 1 not authorized")).toBeVisible();
  await page.getByRole("button", { name: "Treasury preview" }).click();
  await expect(page.locator(".finance-detail-panel").getByRole("heading", { level: 2, name: "Treasury" })).toBeVisible();
  await page.getByRole("tab", { name: "Treasury" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "No treasury accounts connected" })).toBeVisible();
  await expect(page.getByText(/No cash, bank, sarafi, receipt, payment, custody, or reconciliation service/)).toBeVisible();
});

test("Construction supports read-only progress, milestone, area, and update views", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/construction");

  await expect(page.getByRole("heading", { level: 1, name: "Construction" })).toBeVisible();
  await expect(page.getByText(/no certified quantities, costs, approvals, or financial posting/i)).toBeVisible();
  await page.getByRole("button", { name: "Select DEMO-WA-02 demo work area" }).click();
  await expect(page.locator(".construction-detail-panel").getByRole("heading", { level: 2, name: "Demo Wing B" })).toBeVisible();
  await page.getByRole("tab", { name: /Milestones/ }).click();
  await expect(page.getByText("DEMO-M01 · DEMO")).toBeVisible();
  await page.getByRole("tab", { name: /Work areas/ }).click();
  await expect(page.getByText("DEMO-WA-03 · DEMO")).toBeVisible();
  await page.getByRole("tab", { name: /Site updates/ }).click();
  await expect(page.getByText("DEMO-U03 · Demo Services Core")).toBeVisible();
});

test("Finance and Construction remain usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/finance");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "مالی" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/construction");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ساخت‌وساز" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
