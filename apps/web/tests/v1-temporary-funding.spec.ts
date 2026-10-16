import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Temporary Funding (migration 0037) through the real UI, identity and database boundaries, in English
 * and Dari. It resets only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-temporary-funding --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TECHNICAL_TERMS = [
  "PROVIDER_PAID_EXPENSE_DIRECTLY", "PROVIDER_FUNDED_SAFE", "TEMPORARY_FUNDING", "PENDING_APPROVAL", "POSTED",
  "OPERATIONAL_V1", "finance.temporary-funding", "idempotency", "SECURITY DEFINER"
];

test.describe("V1 temporary funding", () => {
  test.skip(
    process.env.ABOS_V1_PREVIEW_E2E !== "1",
    "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this."
  );

  test("record, independently approve and partly repay a provider; Safe and payable stay apart; Dari complete", async ({ page }) => {
    test.setTimeout(300_000);
    const accounts = seedPreview();
    await configureSyntheticTemporaryFunding();

    // The payable account is configured with its authorization evidence by the configuring user.
    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Temporary funding" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Temporary funding" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "not ready yet" })).toContainText("Temporary Funding Payable account has not been chosen");
    const mapping = page.getByRole("form", { name: "Temporary Funding Payable account" });
    await mapping.getByLabel(/Liability account/).selectOption({ label: "SYN-2150 · Synthetic Temporary Funding Payable" });
    await mapping.getByLabel("Authorization document reference *").fill("SYN-BOARD-2026-01");
    await mapping.getByLabel("SHA-256 *").fill(createHash("sha256").update("synthetic authorization").digest("hex"));
    await mapping.getByLabel("Reason *").fill("Synthetic payable account for temporary funding");
    await mapping.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Payable account saved" })).toBeVisible();
    await signOut(page);

    // The preparer records a direct payment (Safe unchanged) and Safe funding (Safe funded).
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.goto("/finance/temporary-funding");
    const form = page.getByRole("form", { name: "Record temporary funding" });
    await form.getByLabel("Provider type *").selectOption({ label: "Individual" });
    await form.getByLabel("Provider *").selectOption({ label: "Synthetic Individual" });
    await form.getByLabel("Expense type *").selectOption({ label: "Synthetic Office Supplies" });
    await expect(form).toContainText("Safe unchanged");
    await form.getByLabel("Date *").fill("2026-09-22");
    await form.getByLabel("Amount (USD) *").fill("250.00");
    await form.getByLabel("Receipt or reference number *").fill("SYN-TF-001");
    await form.getByLabel("What was it for? *").fill("Synthetic printer paper paid by provider");
    await form.getByRole("button", { name: "Send for approval" }).click();
    await expect(page.getByRole("status").filter({ hasText: "sent for approval" })).toBeVisible();
    await form.getByLabel("Put cash into the Safe").check();
    await expect(form).toContainText("Safe funded");
    await form.getByLabel("Provider type *").selectOption({ label: "Organization" });
    await form.getByLabel("Provider *").selectOption({ label: "Synthetic Organization" });
    await form.getByLabel("Which Safe? *").selectOption({ label: "Synthetic Main Safe" });
    await form.getByLabel("Date *").fill("2026-09-22");
    await form.getByLabel("Amount (USD) *").fill("100.00");
    await form.getByLabel("Receipt or reference number *").fill("SYN-TF-002");
    await form.getByLabel("What was it for? *").fill("Synthetic cash placed in the Safe");
    await form.getByRole("button", { name: "Send for approval" }).click();
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-002" })).toContainText("Waiting for approval");
    await expect(page.getByRole("button", { name: "Approve and record" })).toHaveCount(0);
    await expectNoTechnicalTerms(page);
    await signOut(page);

    // An independent approver approves both; only the Safe funding moves physical cash.
    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/temporary-funding");
    for (const reference of ["SYN-TF-001", "SYN-TF-002"]) {
      const card = page.locator(".tf-card").filter({ hasText: reference });
      await card.getByLabel("Decision reason").fill("Receipt checked against the provider's confirmation");
      await card.getByRole("button", { name: "Approve and record" }).click();
      await expect(page.locator(".tf-card").filter({ hasText: reference })).toContainText("Owed — not repaid");
    }
    await expect(page.locator(".tf-total")).toHaveText("350.00 USD");
    const safe = page.locator(".tf-panel").first().locator("tr").filter({ hasText: "Synthetic Main Safe" });
    await expect(safe).toContainText("100.00 USD");
    await expect(page.getByRole("button", { name: /reverse/i })).toHaveCount(0);
    await signOut(page);

    // Repayment: over-settlement is refused; a partial repayment is approved independently.
    await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
    await page.goto("/finance/temporary-funding");
    const card = page.locator(".tf-card").filter({ hasText: "SYN-TF-001" });
    const repay = card.getByRole("form", { name: "Request repayment" });
    await repay.getByLabel("From which account?").selectOption({ label: "Synthetic Main Safe" });
    await repay.getByLabel("Repayment amount").fill("251.00");
    await repay.getByLabel("Repayment date").fill("2026-09-25");
    await repay.getByLabel("Repayment reference").fill("SYN-REPAY-001");
    await repay.getByRole("button", { name: "Request repayment" }).click();
    await expect(page.locator(".treasury-message.error")).toContainText("more than the amount still owed");
    await repay.getByLabel("Repayment amount").fill("100.00");
    await repay.getByRole("button", { name: "Request repayment" }).click();
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-001" })).toContainText("Repayment history");
    await signOut(page);

    await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
    await page.goto("/finance/temporary-funding");
    const pending = page.locator(".tf-card").filter({ hasText: "SYN-TF-001" });
    await pending.getByLabel("Repayment decision reason").fill("Cash handed over against signature");
    await pending.getByRole("button", { name: "Approve repayment" }).click();
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-001" })).toContainText("Partly repaid");
    await expect(page.locator(".tf-total")).toHaveText("250.00 USD");
    const provider = page.locator(".tf-payable tr").filter({ hasText: "Synthetic Individual" });
    await expect(provider).toContainText("150.00 USD");
    await expectNoTechnicalTerms(page);

    // Dari is complete and right-to-left.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "تمویل موقت" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-001" })).toContainText("قسماً بازپرداخت شده");
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-002" })).toContainText("صندوق تمویل شد");
    await expect(page.locator(".tf-card").filter({ hasText: "SYN-TF-001" })).toContainText("صندوق بدون تغییر");
    await expectNoTechnicalTerms(page);
  });
});

async function expectNoTechnicalTerms(page: Page): Promise<void> {
  const text = await page.locator("main").innerText();
  for (const term of TECHNICAL_TERMS) expect(text, `page shows "${term}"`).not.toContain(term);
}

/** Test-only Temporary Funding configuration inside the disposable preview database. */
async function configureSyntheticTemporaryFunding(): Promise<void> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const client = new pg.Client({ connectionString: environment.ABOS_DATABASE_URL });
  await client.connect();
  try {
    const one = async (sql: string, params: unknown[] = []) => (await client.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const entity = await one("SELECT id FROM abos.legal_entities ORDER BY created_at LIMIT 1");
    const admin = await one("SELECT id FROM abos.user_accounts WHERE display_name = 'Synthetic Super Admin'");
    const user = (login: string) => one("SELECT id FROM abos.user_accounts WHERE login_identifier = $1", [login]);
    const cash = await one(`SELECT id FROM abos.ledger_accounts WHERE legal_entity_id = $1 AND control_account_type = 'CASH'
      AND account_currency_code = 'USD' AND status = 'ACTIVE' AND posting_allowed ORDER BY account_code LIMIT 1`, [entity]);
    const expenseLedger = randomUUID();
    await client.query(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type,
        control_account_type, posting_allowed, account_currency_code, status)
      VALUES ($1,$2,'SYN-6100','Synthetic Office Supplies Expense','EXPENSE',NULL,true,'USD','ACTIVE'),
             (gen_random_uuid(),$2,'SYN-2150','Synthetic Temporary Funding Payable','LIABILITY','TEMPORARY_FUNDING_PAYABLE',true,'USD','ACTIVE')`,
    [expenseLedger, entity]);
    await client.query(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, name_fa, account_type, currency_code,
        ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
      VALUES (gen_random_uuid(),$1,'Synthetic Main Safe','صندوق اصلی آزمایشی','SAFE','USD',$2,'ACTIVE',1,$3,$3)`, [entity, cash, admin]);
    await client.query(`INSERT INTO abos.operational_expense_categories (id, legal_entity_id, category_code, name_en, name_fa,
        ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
      VALUES (gen_random_uuid(),$1,'SYN-OFFICE','Synthetic Office Supplies','لوازم دفتر آزمایشی',$2,'ACTIVE',1,$3,$3)`,
    [entity, expenseLedger, admin]);
    await client.query(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version, approval_required,
        configured_by_user_account_id, change_reason)
      VALUES (gen_random_uuid(),$1,'TEMPORARY_FUNDING',1,true,$2,'Synthetic preview: approval required.')`, [entity, admin]);
    for (const name of ["Synthetic Individual", "Synthetic Organization"]) {
      await client.query(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
        VALUES (gen_random_uuid(),$1,$2,$3,'ACTIVE')`, [entity, name, `SYN-${randomUUID().slice(0, 8)}`]);
    }
    const grants: readonly (readonly [string, string])[] = [
      ["demo.finance.preparer", "finance.temporary-funding.record"], ["demo.finance.preparer", "finance.temporary-funding.read"],
      ["demo.finance.preparer", "finance.temporary-funding.settle"],
      ["demo.finance.approver", "finance.temporary-funding.approve"], ["demo.finance.approver", "finance.temporary-funding.settle-approve"],
      ["demo.finance.approver", "finance.temporary-funding.read"],
      ["demo.treasury.manager", "finance.temporary-funding.configure"], ["demo.treasury.manager", "finance.temporary-funding.read"]
    ];
    for (const [login, permission] of grants) {
      await client.query(`INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [await user(login), entity, permission, admin]);
    }
  } finally {
    await client.end();
  }
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  const file = resolve(__dirname, "../.env.local");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
    }
  }
  // Explicit environment values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

function seedPreview(): Record<string, string> {
  const environment = previewEnvironment();
  assertDisposablePreviewDatabase(environment.ABOS_DATABASE_URL, environment.ABOS_IDENTITY_DATABASE_URL);
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
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

async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function signOut(page: Page): Promise<void> {
  await page.locator(".account-control > button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}
