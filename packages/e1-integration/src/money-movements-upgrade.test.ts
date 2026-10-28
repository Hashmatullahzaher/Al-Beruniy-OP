import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { applyMigrations } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, withClusterLock, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/**
 * Upgrading a populated 0046 database to 0047/0048: an expense recorded before 0048 (no payment kind)
 * keeps its row byte for byte, still follows the EXPENSE approval setting when approved afterwards, and
 * reads exactly as before (no paymentKind key).
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const PREDECESSOR = "0046_v1_treasury_opening_balances";
type Session = { proof: string; runtimeDigest: string; tokenDigest: string };

if (databaseUrl() === undefined) {
  test("0047/0048 upgrade", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0047/0048: upgrade from a populated 0046", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_money_up_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    async function session(userId: string, entity: string): Promise<Session> {
      const issued = await issueOperationalSession(h, userId, entity);
      return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
        runtimeDigest: createHash("sha256").update(issued.token).digest("hex"),
        tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(issued.token).digest("hex") };
    }
    async function call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const placeholders = extra.map((_, index) => `$${index + 4}`).join(",");
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3${placeholders ? `,${placeholders}` : ""}) AS value`,
        [s.proof, s.runtimeDigest, s.tokenDigest, ...extra]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }

    test("an expense waiting for approval before 0048 is approved after it under EXPENSE, unchanged and without a kind", async () => {
      const migrations = await loadMigrations();
      const index = migrations.findIndex((m) => m.id === PREDECESSOR);
      assert.ok(index > 0);
      await withClusterLock(h.pool, async () => {
        const client = await h.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          await client.query(`CREATE SCHEMA abos; CREATE TABLE abos.schema_migrations (
            migration_id text PRIMARY KEY, checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
          for (const migration of migrations.slice(0, index + 1)) {
            await client.query(migration.sql);
            await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)", [migration.id, migration.checksumSha256]);
          }
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      });

      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, ["finance.expense.create", "finance.expense.read"]);
      await grant(h.executor, world, world.approverId, ["finance.expense.approve", "finance.expense.read"]);
      const entity = world.legalEntityId; const by = world.bootstrapUserId;
      const safe = randomUUID(); const category = randomUUID(); const expenseLedger = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic upgrade Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, entity, world.cashLedgerAccountId, by]);
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-UP-EXP','Synthetic upgrade expense','EXPENSE',NULL,true,'USD','ACTIVE')`, [expenseLedger, entity]);
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,
        created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'SYN-UP','Synthetic upgrade category',$3,'ACTIVE',1,$4,$4)`, [category, entity, expenseLedger, by]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'EXPENSE',1,true,$3,'Synthetic upgrade policy')`, [randomUUID(), entity, by]);
      const creator = await session(world.intentCreatorId, entity);
      const pending = await call<{ expense: Record<string, unknown> & { id: string; version: number; status: string } }>("operational_expense_create", creator,
        JSON.stringify({ treasuryAccountId: safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
          costCenterId: null, reference: "SYN-UP-1", description: "Synthetic expense recorded before 0048", note: null, businessDate: "2026-09-15",
          originalAmount: "75.25", currencyCode: "USD", exchangeRateId: null, correlationId: randomUUID(), idempotencyKey: `upgrade-${randomUUID()}` }));
      assert.equal(pending.expense.status, "PENDING_APPROVAL");
      const rowBefore = (await h.pool.query("SELECT to_jsonb(e) AS r FROM abos.operational_expenses e WHERE id = $1", [pending.expense.id])).rows[0]?.r;

      const applied = await withClusterLock(h.pool, async () => {
        const client = await h.pool.connect();
        const tx = { query: async (sql: string, parameters: readonly unknown[] = []) => {
          const result = await client.query(sql, [...parameters]); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; } };
        try {
          return await applyMigrations({ ...tx, transaction: async (work: (t: typeof tx) => Promise<unknown>) => {
            await client.query("BEGIN");
            try { const result = await work(tx); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; }
          } } as never, migrations);
        } finally { client.release(); }
      });
      assert.deepEqual(applied, ["0047_v1_basic_money_movements", "0048_v1_expense_payment_kind", "0049_v1_slice4_corrections"]);

      const rowAfter = (await h.pool.query("SELECT to_jsonb(e) - 'payment_kind' AS r, payment_kind FROM abos.operational_expenses e WHERE id = $1", [pending.expense.id])).rows[0];
      assert.deepEqual(rowAfter?.r, rowBefore, "the pre-0048 expense row is unchanged");
      assert.equal(rowAfter?.payment_kind, null, "nothing is backfilled");

      // 0049: the Safe must hold the money when the expense posts, so it receives some first.
      const revenue = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-UP-INC','Synthetic upgrade income','REVENUE',NULL,true,'USD','ACTIVE')`, [revenue, entity]);
      await grant(h.executor, world, world.intentCreatorId, ["treasury.receipt.record"]);
      await call("treasury_receipt_record", await session(world.intentCreatorId, entity), JSON.stringify({ treasuryAccountId: safe, amount: "100.00",
        currencyCode: "USD", businessDate: "2026-09-15", payerBusinessPartyId: null, payerName: "Synthetic payer", revenueLedgerAccountId: revenue,
        reference: null, note: null, idempotencyKey: `upgrade-receipt-${randomUUID()}`, correlationId: randomUUID() }));

      const approver = await session(world.approverId, entity);
      const approved = await call<{ expense: Record<string, unknown> & { status: string } }>("operational_expense_approve", approver,
        pending.expense.id, pending.expense.version, "Synthetic approval after the upgrade");
      assert.equal(approved.expense.status, "POSTED");
      assert.equal("paymentKind" in approved.expense, false, "an expense without a kind reads exactly as before 0048");
      const posted = (await h.pool.query(`SELECT v.workflow_type AS w, i.source_type AS s, j.status AS j FROM abos.operational_expenses e
        JOIN abos.finance_workflow_policy_versions v ON v.id = e.workflow_policy_version_id
        JOIN abos.journals j ON j.id = e.journal_id JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE e.id = $1`, [pending.expense.id])).rows;
      assert.deepEqual(posted, [{ w: "EXPENSE", s: "OPERATIONAL_EXPENSE", j: "POSTED" }]);
    });
  });
}
