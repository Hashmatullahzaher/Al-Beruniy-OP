import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import pg from "pg";

type Accounts = Record<string, string>;
type Fixture = {
  readonly entity: string;
  readonly contribution: string;
  readonly treasuryAccount: string;
  readonly capitalLedger: string;
  readonly expenseLedger: string;
};

const ROOT = resolve(__dirname, "../../..");

test.use({ viewport: { width: 1440, height: 1000 } });

test("@smoke 0038: independent operators move declared capital into the Safe, post it, then spend from the same Safe", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const { accounts, fixture } = seedCapitalPreview();
  const files = evidenceFiles(testInfo);

  // Finance configures the exact paid-in-capital account. Configuration remains reachable while
  // the overall capability is still NOT_OPERATIONAL; evidence is hashed from a selected local file.
  await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
  await page.goto("/shareholders");
  const mapping = page.locator("section.capital-configuration");
  await expect(mapping).toContainText("Paid-in capital mapping");
  await mapping.getByRole("button", { name: "Configure account" }).click();
  await mapping.getByLabel("Capital account").selectOption({ label: "3010-USD · Synthetic Paid-in Share Capital · USD" });
  await mapping.getByLabel("Evidence reference").fill("SYN-CAPITAL-MAPPING-BOARD-0038");
  await mapping.getByLabel("File for fingerprint").setInputFiles(files.mapping.path);
  await mapping.getByLabel("Configuration reason").fill("Disposable browser proof of the approved paid-in-capital classification");
  await mapping.getByRole("button", { name: "Save mapping" }).click();
  await expect(mapping.getByRole("status")).toContainText("paid-in-capital account was configured");
  await expect(page.getByText("OPERATIONAL CASH CAPITAL PATH")).toBeVisible();
  await signOut(page);

  // Recorder: the actual receipt happens after the declaration. The selected receipt file is
  // hashed in the browser and only its reference/fingerprint are sent.
  await signIn(page, "demo.cashier", accounts["demo.cashier"]);
  let capital = await capitalWorkflow(page);
  await capital.getByRole("button", { name: "Record actual receipt" }).click();
  let form = capital.getByRole("heading", { name: "Cash receipt details" }).locator("..");
  await form.getByLabel("Actual amount").fill("50000");
  await form.getByLabel("Actual receipt date").fill("2026-09-22");
  await form.getByLabel("Treasury destination").selectOption({ label: "Synthetic Capital Safe · USD" });
  await form.getByLabel("Payment reference (optional)").fill("SYN-CAPITAL-CASH-0038");
  await form.getByLabel("Evidence reference (optional)").fill("SYN-CASH-RECEIPT-EVIDENCE-0038");
  await form.getByLabel("File for fingerprint (optional)").setInputFiles(files.receipt.path);
  await form.getByRole("button", { name: "Record receipt" }).click();
  await expect(capital.getByRole("status")).toContainText("Receipt recorded. Nothing has been posted.");
  await expect(capital.locator("article.capital-receipt")).toContainText("Receipt date 2026-09-22");
  await expect(capital.locator("article.capital-receipt")).toContainText("Synthetic Cashier");
  await signOut(page);

  // A different Treasury person verifies custody with evidence bound to this exact receipt.
  await signIn(page, "demo.verifier", accounts["demo.verifier"]);
  capital = await capitalWorkflow(page);
  await capital.getByRole("button", { name: "Review custody" }).click();
  form = capital.locator("form.capital-operation-form.compact");
  await form.getByLabel("Custody decision").selectOption("VERIFIED");
  await form.getByLabel("Evidence kind").selectOption("PHYSICAL_CASH_COUNT");
  await form.getByLabel("Evidence reference").fill("SYN-PHYSICAL-COUNT-0038");
  await form.getByLabel("File for fingerprint").setInputFiles(files.custody.path);
  await form.getByRole("button", { name: "Verify independently" }).click();
  await expect(capital.getByRole("status")).toContainText("Custody verified.");
  await expect(capital.locator("article.capital-receipt")).toContainText("Synthetic Count Confirmer");
  await signOut(page);

  // Finance preparer resolves the approved mapping, policy, period and exact receipt date.
  await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
  capital = await capitalWorkflow(page);
  await capital.getByRole("button", { name: "Prepare posting" }).click();
  form = capital.locator("form.capital-operation-form.compact");
  await expect(form.getByLabel("Accounting effective date")).toHaveValue("2026-09-22");
  await form.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(capital.getByRole("status")).toContainText("Posting was prepared for approval.");
  await signOut(page);

  // Independent Finance approver makes the decision and, under the current contract, explicitly
  // posts the approved intent. The trace must expose the actors, versions, accounts and journal.
  await signIn(page, "demo.finance.approver", accounts["demo.finance.approver"]);
  capital = await capitalWorkflow(page);
  await capital.getByRole("button", { name: "Finance review" }).click();
  form = capital.locator("form.capital-operation-form.compact");
  await form.getByRole("combobox", { name: /^Decision/ }).selectOption("APPROVED");
  await form.getByLabel("Evidence reference").fill("SYN-FINANCE-APPROVAL-0038");
  await form.getByLabel("File for fingerprint").setInputFiles(files.approval.path);
  await form.getByLabel("Decision note").fill("Independent Finance review completed against the receipt and custody record");
  await form.getByRole("button", { name: "Record decision" }).click();
  await expect(capital.getByRole("status")).toContainText("Posting approved.");
  await capital.getByRole("button", { name: "Post to General Ledger" }).click();
  await expect(capital.getByRole("status")).toContainText("posted to the General Ledger");
  const trace = capital.locator("article.capital-receipt");
  await expect(trace).toContainText("Synthetic Cashier");
  await expect(trace).toContainText("Synthetic Count Confirmer");
  await expect(trace).toContainText("Synthetic Intent Creator");
  await expect(trace).toContainText("Synthetic Finance Approver");
  await expect(trace).toContainText("Policy v1");
  await expect(trace).toContainText("Mapping v1");
  await expect(trace).toContainText("Dr 1010-USD · Synthetic Office Cash - USD");
  await expect(trace).toContainText("Cr 3010-USD · Synthetic Paid-in Share Capital");
  await expect(trace).toContainText("Journal ");
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath("capital-posted-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "سرمایه سهامداران" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("capital-posted-tablet-dari.png"), fullPage: true });
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signOut(page);

  // The same Safe can fund a normal operational expense; capital remains a separate source.
  await signIn(page, "demo.finance.preparer", accounts["demo.finance.preparer"]);
  await page.goto("/finance/record-expense");
  const expense = page.getByRole("form", { name: "Record expense" });
  await expense.getByLabel("Date *").fill("2026-09-23");
  await expense.getByLabel("Paid from *").selectOption({ label: "Synthetic Capital Safe · USD" });
  await expense.getByLabel("Expense type *").selectOption({ label: "Synthetic Capital Activation Expense" });
  await expense.getByLabel("Amount (USD) *").fill("125.50");
  await expense.getByLabel("Receipt or reference number *").fill("SYN-CAP-EXPENSE-0038");
  await expense.getByLabel("What was it for? *").fill("Disposable browser proof: office supplies from received capital");
  await expense.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Expense recorded" }))
    .toContainText("Expense recorded: 125.50 USD from Synthetic Capital Safe.");

  await assertDatabaseOutcome(fixture, files);
});

async function capitalWorkflow(page: Page): Promise<Locator> {
  await page.goto("/shareholders");
  const holder = page.locator("article.contribution-card", { hasText: "Synthetic Shareholder One" });
  const workflow = holder.locator(".capital-operations");
  await expect(workflow).toBeVisible();
  return workflow;
}

function evidenceFiles(testInfo: TestInfo) {
  const directory = testInfo.outputPath("evidence");
  mkdirSync(directory, { recursive: true });
  const create = (name: string, body: string) => {
    const path = resolve(directory, name);
    writeFileSync(path, body, "utf8");
    return { path, sha256: createHash("sha256").update(body).digest("hex") };
  };
  return {
    mapping: create("capital-mapping.txt", "0038 mapping authority\n"),
    receipt: create("cash-receipt.txt", "0038 actual cash receipt\n"),
    custody: create("physical-count.txt", "0038 independent physical count\n"),
    approval: create("finance-approval.txt", "0038 independent finance approval\n")
  };
}

function previewEnvironment(): NodeJS.ProcessEnv {
  const owner = process.env.ABOS_DATABASE_URL;
  const identity = process.env.ABOS_IDENTITY_DATABASE_URL;
  expect(owner, "ABOS_DATABASE_URL for the dedicated capital browser database").toBeTruthy();
  expect(identity, "ABOS_IDENTITY_DATABASE_URL for the restricted login on that database").toBeTruthy();
  const ownerName = new URL(owner ?? "").pathname.slice(1);
  const identityName = new URL(identity ?? "").pathname.slice(1);
  expect(ownerName).toMatch(/capital_browser/i);
  expect(ownerName).not.toBe("abos_v1_local_review");
  expect(identityName).toBe(ownerName);
  expect(owner).not.toBe(identity);
  return { ...process.env, ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE: "0" };
}

function seedCapitalPreview(): { readonly accounts: Accounts; readonly fixture: Fixture } {
  const environment = previewEnvironment();
  const seed = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: ROOT, env: environment, encoding: "utf8", shell: process.platform === "win32"
  });
  const configured = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:capital-configure"], {
    cwd: ROOT, env: environment, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Accounts = {};
  for (const line of seed.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] && match[2]) accounts[match[1]] = match[2];
  }
  const fixtureLine = configured.split(/\r?\n/).find((line) => line.startsWith("CAPITAL_FIXTURE_JSON="));
  if (!fixtureLine) throw new Error("Capital browser fixture did not report its identifiers");
  return { accounts, fixture: JSON.parse(fixtureLine.slice("CAPITAL_FIXTURE_JSON=".length)) as Fixture };
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

async function assertDatabaseOutcome(fixture: Fixture, files: ReturnType<typeof evidenceFiles>): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.ABOS_DATABASE_URL });
  await client.connect();
  try {
    const evidence = await client.query<{ evidence_kind: string; sha256: string }>(
      `SELECT evidence_kind,sha256 FROM abos.shareholder_capital_evidence_registrations
        WHERE legal_entity_id=$1 ORDER BY evidence_kind`, [fixture.entity]);
    expect(evidence.rows).toEqual(expect.arrayContaining([
      { evidence_kind: "CAPITAL_ACCOUNT_MAPPING", sha256: files.mapping.sha256 },
      { evidence_kind: "CASH_RECEIPT", sha256: files.receipt.sha256 },
      { evidence_kind: "PHYSICAL_CASH_COUNT", sha256: files.custody.sha256 },
      { evidence_kind: "FINANCE_APPROVAL", sha256: files.approval.sha256 }
    ]));

    const outcome = (await client.query<{
      business_date: string; record_status: string; receipt_date: string; receipt_count: string;
      intent_count: string; capital_journal_count: string; capital_line_count: string;
      capital_subledger_count: string; expense_count: string; safe_movement: string;
      shareholder_capital_movement: string; audit_count: string; outbox_count: string;
    }>(`SELECT contribution.business_date::text,contribution.record_status,
          (SELECT receipt_date::text FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id) AS receipt_date,
          (SELECT count(*)::text FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id) AS receipt_count,
          (SELECT count(*)::text FROM abos.posting_intents WHERE shareholder_capital_receipt_id IN
            (SELECT id FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id)) AS intent_count,
          (SELECT count(*)::text FROM abos.journals WHERE posting_intent_id IN (SELECT id FROM abos.posting_intents
            WHERE shareholder_capital_receipt_id IN (SELECT id FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id))) AS capital_journal_count,
          (SELECT count(*)::text FROM abos.journal_lines WHERE source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
            AND source_id IN (SELECT id FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id)) AS capital_line_count,
          (SELECT count(*)::text FROM abos.subledger_entries WHERE shareholder_capital_receipt_id IN
            (SELECT id FROM abos.shareholder_capital_receipts WHERE contribution_id=contribution.id)) AS capital_subledger_count,
          (SELECT count(*)::text FROM abos.operational_expenses WHERE reference='SYN-CAP-EXPENSE-0038') AS expense_count,
          (SELECT COALESCE(sum(original_amount),0)::text FROM abos.subledger_entries
            WHERE operational_treasury_account_id=$2) AS safe_movement,
          (SELECT COALESCE(sum(original_amount),0)::text FROM abos.subledger_entries
            WHERE subledger_type='SHAREHOLDER_CAPITAL' AND shareholder_capital_receipt_id IS NOT NULL) AS shareholder_capital_movement,
          (SELECT count(*)::text FROM abos.audit_records WHERE legal_entity_id=$1
            AND metadata->>'source'='v1-shareholder-finance-bridge') AS audit_count,
          (SELECT count(*)::text FROM abos.outbox_events WHERE legal_entity_id=$1
            AND event_type LIKE 'shareholder_capital_%') AS outbox_count
        FROM abos.shareholder_contributions contribution WHERE contribution.id=$3`,
    [fixture.entity, fixture.treasuryAccount, fixture.contribution])).rows[0];
    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({
      business_date: "2026-09-20", record_status: "DECLARED", receipt_date: "2026-09-22",
      receipt_count: "1", intent_count: "1", capital_journal_count: "1", capital_line_count: "2",
      capital_subledger_count: "2", expense_count: "1", safe_movement: "49874.50",
      shareholder_capital_movement: "-50000"
    });
    expect(Number(outcome?.audit_count ?? 0)).toBeGreaterThanOrEqual(5);
    expect(Number(outcome?.outbox_count ?? 0)).toBeGreaterThanOrEqual(5);
  } finally {
    await client.end();
  }
}
