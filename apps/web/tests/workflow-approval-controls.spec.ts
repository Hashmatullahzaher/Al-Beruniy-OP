import { expect, test } from "@playwright/test";

// UI contract tests only: authorization and database replay tests run in the disposable PG suite.
const timestamp = "2026-10-19T08:00:00Z";
const actor = { userAccountId: "10000000-0000-4000-8000-000000000001", loginIdentifier: "synthetic.policy", displayName: "Synthetic Policy Admin", jobTitle: "Test only", legalEntityName: "Synthetic Test Company", permissions: ["admin.finance-workflow.manage", "finance.ledger-account.manage"], sessionExpiresAt: "2099-01-01T00:00:00Z" };

test("policy UI retains retry identity, appends versions, shows history and supports tablet Dari", async ({ page }) => {
  const policy = { workflowType: "CHART_OF_ACCOUNTS", labelEn: "Chart of Accounts", labelFa: "جدول حساب‌ها", approvalAvailable: true, configured: true, policyVersionId: "policy-v1", version: 1, approvalRequired: true, changeReason: "Synthetic initial policy", configuredAt: timestamp, configuredBy: actor.displayName, history: [{ policyVersionId: "policy-v1", version: 1, approvalRequired: true, changeReason: "Synthetic initial policy", configuredAt: timestamp, configuredBy: actor.displayName }] };
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: actor } }));
  await page.route("**/api/v1/admin/finance-workflows", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(body);
      if (commands.length === 1) return route.abort("failed");
      policy.version += 1; policy.approvalRequired = body.approvalRequired as boolean; policy.changeReason = body.changeReason as string;
      policy.history.unshift({ policyVersionId: `policy-v${policy.version}`, version: policy.version, approvalRequired: policy.approvalRequired, changeReason: policy.changeReason, configuredAt: timestamp, configuredBy: actor.displayName });
    }
    return route.fulfill({ json: { ok: true, data: { legalEntityId: "test-entity", canManage: true, policies: [policy] } } });
  });
  await page.goto("/admin/finance-workflows");
  const card = page.locator(".policy-card");
  await expect(card).toContainText("Approval ON");
  await card.locator(".policy-toggle input").uncheck();
  await card.getByLabel("Reason for this change").fill("Synthetic owner direction to switch OFF");
  await card.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("status")).toContainText("server could not be reached");
  await card.getByRole("button", { name: "Save new version" }).click();
  await expect(card.locator("footer")).toContainText("Version 2");
  expect(commands[0]?.idempotencyKey).toBe(commands[1]?.idempotencyKey);
  expect(commands[0]?.correlationId).toBe(commands[1]?.correlationId);
  expect(commands[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  await card.locator(".policy-toggle input").check();
  await card.getByLabel("Reason for this change").fill("Synthetic owner direction to switch ON");
  await card.getByRole("button", { name: "Save new version" }).click();
  await expect(card.locator("footer")).toContainText("Version 3");
  expect(commands[2]?.idempotencyKey).not.toBe(commands[1]?.idempotencyKey);
  await card.getByText("Version history").click();
  await expect(card.locator(".policy-history li")).toHaveCount(3);
  await expect(card).toContainText("Synthetic initial policy");
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { name: "تنظیم تأیید جریان‌ها" })).toBeVisible();
  await expect(card.getByRole("checkbox")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("awaiting-review account offers explicit OFF-policy revalidation without inventing a reviewer", async ({ page }) => {
  const account = {
    id: "20000000-0000-4000-8000-000000000001", code: "SYN-E-01", name: "Synthetic Paid-in Shareholder Capital", nameFa: "سرمایه آزمایشی", description: null,
    type: "EQUITY", controlType: "SHAREHOLDER_CAPITAL", currency: "USD", parentId: null, postingAllowed: true, requiresProject: false, requiresDepartment: false, requiresCostCenter: false,
    status: "ACTIVE", createdAt: timestamp, origin: "APP", version: 1, reviewState: "PENDING_REVIEW", reviewReason: "CREATED", createdBy: actor.displayName, lastChangedBy: null, lastChangedAt: null,
    lastReviewedBy: null, lastReviewedAt: null, lastReviewNote: null, duplicateWarnings: [], viewerIsParticipant: true, reviews: [], approvalPolicyVersion: 1, approvalRequired: true,
    policyReleasedBy: null as string | null, policyReleasedAt: null as string | null, policyReleaseReason: null as string | null,
    usage: { inUse: false, journalLines: 0, postedJournalLines: 0, safeAccounts: 0, openSafeAccounts: 0, references: [], pendingPostingIntents: 0, children: 0, activeChildren: 0 }
  };
  let releaseBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: actor } }));
  await page.route("**/api/v1/finance/accounts", (route) => route.fulfill({ json: { ok: true, data: {
    canManage: true, canReview: true, actor, legalEntity: { id: "synthetic-entity", name: actor.legalEntityName, baseCurrency: "USD" }, currencies: [{ code: "USD", name: "USD" }], accounts: [account], reviewQueue: account.reviewState === "PENDING_REVIEW" ? 1 : 0,
    approvalPolicy: { configured: true, version: 2, approvalRequired: false }
  } } }));
  await page.route(`**/api/v1/finance/accounts/${account.id}/reevaluate`, async (route) => {
    releaseBody = route.request().postDataJSON() as Record<string, unknown>;
    Object.assign(account, { reviewState: "NOT_REQUIRED", reviewReason: null, version: 2, approvalPolicyVersion: 2, approvalRequired: false, policyReleasedBy: actor.displayName, policyReleasedAt: timestamp, policyReleaseReason: releaseBody.reason });
    return route.fulfill({ json: { ok: true, data: { account, replayed: false } } });
  });
  await page.goto("/finance/accounts");
  await page.getByRole("button", { name: /SYN-E-01/ }).click();
  const release = page.locator(".coa-policy-release");
  await expect(release).toContainText("Approval is currently OFF");
  await release.getByLabel("Reason for policy-based release").fill("Synthetic owner-directed policy release");
  await release.getByRole("button", { name: "Re-evaluate under current policy" }).click();
  await expect(page.getByRole("status")).toContainText("No approval was recorded");
  await expect(page.locator(".coa-detail")).toContainText("Released under policy without approval");
  await expect(page.locator(".coa-policy-release")).toHaveCount(0);
  expect(account.reviews).toHaveLength(0);
  expect(account.lastReviewedBy).toBeNull();
  expect(account.createdAt).toBe(timestamp);
  expect(releaseBody).toMatchObject({ expectedVersion: 1, reason: "Synthetic owner-directed policy release", idempotencyKey: expect.any(String), correlationId: expect.any(String) });
});

test("a workflow with no saved setting shows what happens today, never an assumed OFF, and saves only an explicit choice (English and Dari)", async ({ page }) => {
  const unset = (workflowType: string, labelEn: string, approvalAvailable = true) => ({ workflowType, labelEn, labelFa: labelEn, approvalAvailable, configured: false,
    policyVersionId: null, version: 0, approvalRequired: null, changeReason: null, configuredAt: null, configuredBy: null, history: [] });
  const policies = [unset("CHART_OF_ACCOUNTS", "Chart of Accounts"), unset("SHAREHOLDER_CAPITAL_RECEIPT", "Shareholder capital receipt"),
    unset("TEMPORARY_FUNDING", "Temporary funding"), unset("CUSTOMER_RECEIPT", "Customer receipt", false), unset("EXPENSE", "Expense")];
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: actor } }));
  await page.route("**/api/v1/admin/finance-workflows", async (route) => {
    if (route.request().method() === "PUT") commands.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { ok: true, data: { legalEntityId: "test-entity", canManage: true, policies } } });
  });
  await page.goto("/admin/finance-workflows");
  const card = (name: string) => page.locator(".policy-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card("Chart of Accounts").locator(".treasury-chip")).toHaveText("Not configured — approval is currently required by default");
  await expect(card("Shareholder capital receipt").locator(".treasury-chip")).toHaveText("Not configured — capital cannot be recorded until this setting is saved");
  await expect(card("Temporary funding").locator(".treasury-chip")).toHaveText("Not configured — temporary funding cannot be recorded until this setting is saved");
  await expect(card("Customer receipt").locator(".treasury-chip")).toHaveText("Not configured — no separate workflow; recorded with “Receive cash”");
  // The backend's Simple Mode default for ordinary workflows is OFF, so that is what they show.
  await expect(card("Expense").locator(".treasury-chip")).toHaveText("Approval OFF (default)");
  await expect(card("Expense").locator(".policy-toggle input")).not.toBeChecked();
  for (const name of ["Chart of Accounts", "Shareholder capital receipt", "Temporary funding", "Customer receipt"]) {
    const unsetCard = card(name);
    await expect(unsetCard.locator(".policy-toggle")).toHaveCount(0);
    await expect(unsetCard).not.toContainText("Approval required: OFF");
    await expect(unsetCard.getByRole("radio")).toHaveCount(2);
    for (const radio of await unsetCard.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  }
  await expect(card("Customer receipt").getByRole("radio", { name: /Approval ON/ })).toBeDisabled();
  const chart = card("Chart of Accounts");
  await chart.getByLabel("Reason for this change").fill("Single operator: no second reviewer");
  await expect(chart.getByRole("button", { name: "Save new version" })).toBeDisabled();
  await chart.getByRole("radio", { name: /Approval OFF/ }).check();
  await chart.getByRole("button", { name: "Save new version" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ workflowType: "CHART_OF_ACCOUNTS", approvalRequired: false, expectedVersion: 0 });
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(card("Chart of Accounts").locator(".treasury-chip")).toHaveText("پیکربندی نشده — فعلاً به‌طور پیش‌فرض تأیید لازم است");
  await expect(card("Shareholder capital receipt").locator(".treasury-chip")).toHaveText("پیکربندی نشده — تا این تنظیم ذخیره نشود، سرمایه ثبت نمی‌شود");
  await expect(card("Shareholder capital receipt").getByRole("radio", { name: /تأیید خاموش/ })).toBeVisible();
  await expect(card("Expense").locator(".treasury-chip")).toHaveText("تأیید خاموش (پیش‌فرض)");
});

test("after approval is turned OFF, waiting accounts say how to release them and the review card no longer demands another reviewer (English and Dari)", async ({ page }) => {
  const waiting = (id: string, code: string) => ({
    id, code, name: `Synthetic ${code}`, nameFa: null, description: null, type: "ASSET", controlType: "CASH", currency: "USD", parentId: null, postingAllowed: true,
    requiresProject: false, requiresDepartment: false, requiresCostCenter: false, status: "ACTIVE", createdAt: timestamp, origin: "APP", version: 1,
    reviewState: "PENDING_REVIEW", reviewReason: "CREATED", createdBy: actor.displayName, lastChangedBy: null, lastChangedAt: null, lastReviewedBy: null,
    lastReviewedAt: null, lastReviewNote: null, duplicateWarnings: [], viewerIsParticipant: true, reviews: [], approvalPolicyVersion: 0, approvalRequired: true,
    policyReleasedBy: null, policyReleasedAt: null, policyReleaseReason: null,
    usage: { inUse: false, journalLines: 0, postedJournalLines: 0, safeAccounts: 0, openSafeAccounts: 0, references: [], pendingPostingIntents: 0, children: 0, activeChildren: 0 }
  });
  const accounts = [waiting("20000000-0000-4000-8000-000000000011", "1100"), waiting("20000000-0000-4000-8000-000000000012", "3100")];
  let approvalRequired = false;
  let released = 0;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: actor } }));
  await page.route("**/api/v1/finance/accounts", (route) => route.fulfill({ json: { ok: true, data: {
    canManage: true, canReview: true, actor, legalEntity: { id: "synthetic-entity", name: actor.legalEntityName, baseCurrency: "USD" }, currencies: [{ code: "USD", name: "USD" }],
    accounts, reviewQueue: accounts.length, approvalPolicy: { configured: true, version: 1, approvalRequired } } } }));
  await page.route("**/api/v1/finance/accounts/*/reevaluate", (route) => { released += 1; return route.fulfill({ json: { ok: false, error: { code: "TEST", message: "not called" } } }); });
  await page.goto("/finance/accounts");
  const note = page.locator(".coa-release-note");
  await expect(note).toContainText("Chart of Accounts approval is now OFF, but 2 accounts saved while approval was required are still “Awaiting review”");
  await expect(note).toContainText("never done automatically");
  await note.getByRole("button", { name: "Open the accounts to release" }).click();
  await expect(page.getByRole("tab", { name: /Review list/ })).toHaveAttribute("aria-selected", "true");
  const card = page.getByRole("article", { name: "Review 1100" });
  await expect(card.getByRole("button", { name: "Re-evaluate under current policy" })).toBeVisible();
  await expect(card).toContainText("Approval is OFF now: release this account above with “Re-evaluate under current policy”");
  await expect(card).not.toContainText("another reviewer must review it");
  expect(released, "nothing is released without the person's action").toBe(0);
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(note).toContainText("تأیید جدول حساب‌ها اکنون خاموش است");
  await expect(page.getByRole("article", { name: "بازبینی 1100" })).toContainText("تأیید اکنون خاموش است");
  await page.getByRole("button", { name: "Switch to English" }).click();
  // While approval is still required, the independence rule is stated as before and no release is offered.
  approvalRequired = true;
  await page.reload();
  await expect(page.locator(".coa-release-note")).toHaveCount(0);
  await page.getByRole("tab", { name: /Review list/ }).click();
  await expect(page.getByRole("article", { name: "Review 1100" })).toContainText("You created or last changed this account; another reviewer must review it.");
  await expect(page.getByRole("article", { name: "Review 1100" }).getByRole("button", { name: "Re-evaluate under current policy" })).toHaveCount(0);
});
