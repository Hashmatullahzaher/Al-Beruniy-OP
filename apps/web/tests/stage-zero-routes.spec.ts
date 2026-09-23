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
  // Treasury is no longer an empty placeholder: it links to the E1 synthetic Treasury sandbox,
  // which states that it posts nothing to the General Ledger.
  await page.getByRole("tab", { name: "Treasury" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Treasury workspace" })).toBeVisible();
  await expect(page.getByText("E1 SYNTHETIC SANDBOX")).toBeVisible();
  await expect(page.getByText(/no General Ledger posting from Treasury/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Treasury" })).toHaveAttribute("href", "/finance/treasury");
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

test("Procurement presents a guarded supply workflow without purchasing actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/procurement");

  await expect(page.getByRole("heading", { level: 1, name: "Procurement" })).toBeVisible();
  await expect(page.getByText(/No purchases, supplier liabilities, inventory valuation, payments, accounting entries, or inter-project transfers/)).toBeVisible();
  await page.getByRole("button", { name: "Select DEMO-MR-002 demo requirement" }).click();
  await expect(page.locator(".procurement-detail-panel").getByRole("heading", { level: 2, name: "MEP coordination sample" })).toBeVisible();
  await page.getByRole("tab", { name: /Material requirements/ }).click();
  await expect(page.getByText("DEMO-MR-003 · DEMO")).toBeVisible();
  await page.getByRole("tab", { name: "Purchase orders" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "No authorized purchase orders" })).toBeVisible();
});

test("Human Resources supports synthetic staff and role previews without payroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/human-resources");

  await expect(page.getByRole("heading", { level: 1, name: "Human Resources" })).toBeVisible();
  await expect(page.getByText(/no real identities, salaries, payroll calculations, employee finance, or accounting entries/i)).toBeVisible();
  await page.getByRole("button", { name: "Select DEMO-EMP-004 demo staff profile" }).click();
  await expect(page.locator(".hr-detail-panel").getByRole("heading", { level: 2, name: "Document control fixture" })).toBeVisible();
  await page.getByRole("tab", { name: /Roles/ }).click();
  await expect(page.getByText("DEMO-ROLE-03 · DEMO")).toBeVisible();
  await page.getByRole("tab", { name: "Attendance" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "No verified attendance service" })).toBeVisible();
});

test("Procurement and Human Resources remain usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/procurement");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "تدارکات" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/human-resources");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "منابع انسانی" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("Reports and Analytics supports guarded executive report previews", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/reports-analytics");

  await expect(page.getByRole("heading", { level: 1, name: "Reports & Analytics" })).toBeVisible();
  const boundary = page.getByRole("region", { name: "Reporting Stage 0 boundary" });
  await expect(boundary).toContainText(/No official statements, verified balances, live-ledger reconciliation, or operational report exports/i);
  await expect(boundary.getByText("DEMO DATA", { exact: true })).toBeVisible();

  const reportControls = page.locator(".reports-controls");
  await reportControls.locator("select").nth(0).selectOption({ label: "All demo projects" });
  await reportControls.locator("select").nth(1).selectOption({ label: "Illustrative quarter" });
  await expect(page.locator(".reports-readiness-panel")).toContainText("All demo projects");
  await expect(page.locator(".reports-readiness-panel")).toContainText("Illustrative quarter");

  await page.getByRole("tab", { name: "Financial" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Financial reporting structure" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Synthetic demonstration bar chart/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Official export locked" })).toBeDisabled();
});

test("AI Insights separates illustrative narratives from live AI and exposes context", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/ai-insights");

  await expect(page.getByRole("heading", { level: 1, name: "AI Insights" })).toBeVisible();
  const boundary = page.getByRole("region", { name: "AI Insights Stage 0 boundary" });
  await expect(boundary).toContainText(/No live model, verified findings, permission bypass, or executable actions/i);
  await expect(page.getByText(/Synthetic narratives · not AI findings/i)).toBeVisible();

  const constructionInsight = page.getByRole("button", { name: "Select Milestone review pattern illustrative insight" });
  await constructionInsight.click();
  await expect(constructionInsight).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".aiw-insight-detail").getByRole("heading", { level: 2, name: "Milestone review pattern" })).toBeVisible();
  await expect(page.getByText("Synthetic Construction fixture")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Construction" })).toHaveAttribute("href", "/construction");

  await page.getByRole("tab", { name: "Ask a question" }).click();
  await page.getByRole("textbox", { name: "Management question" }).fill("Which demo work area needs review?");
  await page.getByRole("button", { name: /Stage question/ }).click();
  await expect(page.getByRole("status")).toContainText("Question staged locally");
  await expect(page.getByRole("status")).toContainText("No AI response generated");

  await page.getByRole("tab", { name: /Sources & context/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Illustrative context register" })).toBeVisible();
  await expect(page.getByText("Synthetic · unverified").first()).toBeVisible();
});

test("Reports and AI Insights remain usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/reports-analytics");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "گزارش‌ها و تحلیل‌ها" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/ai-insights");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "بینش‌های هوش مصنوعی" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("Documents supports guarded synthetic discovery and read-only preview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/documents");

  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  const boundary = page.getByRole("region", { name: "Documents Stage 0 boundary" });
  await expect(boundary).toContainText(/No real storage, sharing, approvals, signing, or unrestricted downloads/i);
  await expect(boundary.getByText("DEMO DATA", { exact: true })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search demo metadata" });
  await search.fill("DEMO-DOC-002");
  const contractFixture = page.getByRole("button", { name: "Preview Illustrative contract index entry" });
  await expect(contractFixture).toBeVisible();
  await contractFixture.click();
  await expect(contractFixture).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".docw-preview").getByRole("heading", { level: 2, name: "Illustrative contract index entry" })).toBeVisible();
  await expect(page.locator(".docw-preview")).toContainText("Synthetic · unverified");
  await expect(page.getByRole("button", { name: "Download locked" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Share locked" })).toBeDisabled();

  await search.fill("no matching synthetic fixture");
  await expect(page.getByRole("status")).toContainText("No demo metadata matches");
});

test("Settings changes local interface previews without operational mutation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");

  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const boundary = page.getByRole("region", { name: "Settings Stage 0 boundary" });
  await expect(boundary).toContainText(/No permissions, security policy, organization records, system services, or financial configuration can be changed/i);

  await page.getByRole("tab", { name: "Interface preferences" }).click();
  const compact = page.getByRole("button", { name: /Compact/ });
  await compact.click();
  await expect(compact).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".setw-workspace")).toHaveAttribute("data-density", "compact");
  await expect(page.getByRole("status")).toContainText("Compact density selected for this local preview");
  await expect(page.getByRole("status")).toContainText("Nothing was saved to a user account or operational service");

  await page.getByRole("tab", { name: "Roles & permissions" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Roles and permissions overview" })).toBeVisible();
  await expect(page.getByText("STRUCTURE PREVIEW · NOT ASSIGNED").first()).toBeVisible();
  await page.getByRole("tab", { name: "System configuration" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Governed system categories" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configuration locked" }).first()).toBeDisabled();
});

test("Documents and Settings remain usable at tablet width and in Dari RTL", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/documents");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "اسناد" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");

  await page.goto("/settings");
  expect(await page.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeFalsy();
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "تنظیمات" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
});
