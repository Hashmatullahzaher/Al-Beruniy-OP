import { expect, test } from "@playwright/test";

// UI contract tests only: authorization and database replay tests run in the disposable PG suite.
const timestamp = "2026-10-19T08:00:00Z";
const actor = { userAccountId: "10000000-0000-4000-8000-000000000001", loginIdentifier: "synthetic.policy", displayName: "Synthetic Policy Admin", jobTitle: "Test only", legalEntityName: "Synthetic Test Company", permissions: ["admin.finance-workflow.manage", "finance.ledger-account.manage"], sessionExpiresAt: "2099-01-01T00:00:00Z" };

test("policy UI retains retry identity, appends versions, shows history and supports tablet Dari", async ({ page }) => {
  const policy = { workflowType: "CHART_OF_ACCOUNTS", labelEn: "Chart of Accounts", labelFa: "جدول حساب‌ها", configured: true, policyVersionId: "policy-v1", version: 1, approvalRequired: true, changeReason: "Synthetic initial policy", configuredAt: timestamp, configuredBy: actor.displayName, history: [{ policyVersionId: "policy-v1", version: 1, approvalRequired: true, changeReason: "Synthetic initial policy", configuredAt: timestamp, configuredBy: actor.displayName }] };
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
