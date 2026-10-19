/**
 * Disposable browser fixture for the 0038 shareholder-capital activation path.
 *
 * Run `preview:seed` first. This script adds only the operational configuration and one declared
 * CASH contribution needed by the browser journey. Actual receipt, evidence, custody, Finance
 * approval, posting, and expense recording must all happen through the real application UI.
 *
 * The database name must contain `capital_browser`; the preserved local-review database is always
 * refused. Generated passwords continue to come from preview-seed and are never stored here.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

pg.types.setTypeParser(1700, (value: string) => value);

const ownerUrl = process.env.ABOS_DATABASE_URL;
const identityUrl = process.env.ABOS_IDENTITY_DATABASE_URL;

function disposableDatabase(url: string | undefined, label: string): URL {
  if (!url?.trim()) throw new Error(`${label} is not set`);
  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);
  if (database !== "abos_capital_browser_preview_0038" || parsed.hostname !== "127.0.0.1" || parsed.port !== "55442") {
    throw new Error(`Refusing to configure non-disposable database "${database}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const owner = disposableDatabase(ownerUrl, "ABOS_DATABASE_URL");
  const identity = disposableDatabase(identityUrl, "ABOS_IDENTITY_DATABASE_URL");
  if (identity.pathname !== owner.pathname) throw new Error("Owner and identity URLs must use the same disposable database");
  if (ownerUrl === identityUrl) throw new Error("The identity URL must use the restricted runtime credential");

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const one = async (sql: string, params: readonly unknown[] = []): Promise<string> => {
      const id = (await client.query<{ id: string }>(sql, [...params])).rows[0]?.id;
      if (!id) throw new Error(`Fixture prerequisite missing: ${sql}`);
      return id;
    };
    const entity = await one("SELECT id FROM abos.legal_entities ORDER BY created_at LIMIT 1");
    const bootstrap = await one("SELECT id FROM abos.user_accounts WHERE display_name = 'Synthetic Super Admin'");
    const user = (login: string) => one("SELECT id FROM abos.user_accounts WHERE login_identifier = $1", [login]);
    const recorder = await user("demo.cashier");
    const verifier = await user("demo.verifier");
    const preparer = await user("demo.finance.preparer");
    const approver = await user("demo.finance.approver");
    const shareholder = await one(
      `SELECT profile.id
         FROM abos.shareholder_profiles profile
         JOIN abos.business_parties party ON party.id=profile.business_party_id
        WHERE profile.legal_entity_id=$1 AND party.display_name='Synthetic Shareholder One'`, [entity]);
    const cashLedger = await one(
      `SELECT id FROM abos.ledger_accounts
        WHERE legal_entity_id=$1 AND account_type='ASSET' AND control_account_type='CASH'
          AND account_currency_code='USD' AND status='ACTIVE' AND posting_allowed
          AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center
        ORDER BY account_code LIMIT 1`, [entity]);
    const capitalLedger = await one(
      `SELECT id FROM abos.ledger_accounts
        WHERE legal_entity_id=$1 AND account_type='EQUITY' AND control_account_type='SHAREHOLDER_CAPITAL'
          AND account_currency_code='USD' AND status='ACTIVE' AND posting_allowed
          AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center
        ORDER BY account_code LIMIT 1`, [entity]);

    const treasuryAccount = randomUUID();
    await client.query(
      `INSERT INTO abos.operational_treasury_accounts
         (id,legal_entity_id,name_en,name_fa,account_type,currency_code,ledger_account_id,status,version,
          created_by_user_account_id,last_changed_by_user_account_id)
       VALUES ($1,$2,'Synthetic Capital Safe','صندوق سرمایه آزمایشی','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [treasuryAccount, entity, cashLedger, bootstrap]);

    await client.query(
      `INSERT INTO abos.finance_workflow_policy_versions
         (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
       VALUES ($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',1,true,$3,
               'Disposable browser fixture: independent approval required.'),
              ($4,$2,'EXPENSE',1,false,$3,'Disposable browser fixture: expense approval off.')`,
      [randomUUID(), entity, bootstrap, randomUUID()]);

    const expenseLedger = randomUUID();
    await client.query(
      `INSERT INTO abos.ledger_accounts
         (id,legal_entity_id,account_code,account_name,account_type,control_account_type,
          posting_allowed,account_currency_code,status)
       VALUES ($1,$2,'SYN-6180','Synthetic Capital Activation Expense','EXPENSE',NULL,true,'USD','ACTIVE')`,
      [expenseLedger, entity]);
    await client.query(
      `INSERT INTO abos.operational_expense_categories
         (id,legal_entity_id,category_code,name_en,name_fa,ledger_account_id,status,version,
          created_by_user_account_id,last_changed_by_user_account_id)
       VALUES ($1,$2,'SYN-CAP-ACT','Synthetic Capital Activation Expense','هزینه آزمایشی فعال‌سازی سرمایه',
               $3,'ACTIVE',1,$4,$4)`,
      [randomUUID(), entity, expenseLedger, bootstrap]);

    const contribution = randomUUID();
    await client.query(
      `INSERT INTO abos.shareholder_contributions
         (id,legal_entity_id,shareholder_profile_id,contribution_type,business_date,description,reference,
          record_status,receipt_status,valuation_status,amount,currency_code,version,
          created_by_user_account_id,declared_by_user_account_id,declared_at)
       VALUES ($1,$2,$3,'CASH','2026-09-20','Disposable browser declaration',
               'SYN-CAP-DECLARATION-0038','DECLARED','NOT_RECEIVED','NOT_APPLICABLE',50000,'USD',1,$4,$4,
               clock_timestamp())`,
      [contribution, entity, shareholder, bootstrap]);

    const grants: readonly (readonly [string, readonly string[]])[] = [
      [recorder, ["shareholder.capital-receipt.read", "shareholder.capital-receipt.record"]],
      [verifier, ["shareholder.capital-receipt.read", "treasury.capital-receipt.verify"]],
      [preparer, ["shareholder.capital-receipt.read", "finance.capital-receipt.configure",
        "finance.capital-receipt.prepare", "finance.expense.create", "finance.expense.read"]],
      [approver, ["shareholder.capital-receipt.read", "finance.capital-receipt.approve",
        "finance.capital-receipt.post"]]
    ];
    for (const [actor, permissions] of grants) {
      for (const permission of permissions) {
        await client.query(
          `INSERT INTO abos.user_permission_grants
             (user_account_id,legal_entity_id,permission_code,granted_by_user_account_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [actor, entity, permission, bootstrap]);
      }
    }

    await client.query("COMMIT");
    process.stdout.write(`CAPITAL_FIXTURE_JSON=${JSON.stringify({ entity, contribution, treasuryAccount, capitalLedger, expenseLedger })}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
