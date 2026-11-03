import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0056: a transition is never refused because two clock readings are equal or the wall clock stepped back.
 * Before 0056 the expense guard required updated_at to strictly increase; recording an expense with approval OFF writes
 * the row three times in one transaction, so equal clock_timestamp() readings intermittently refused a valid expense.
 * These tests fix the timestamps explicitly, so they fail on the old guard every time and pass on the new one every
 * time, and they prove the guard's real invariants (version, transitions, immutability, identity) are unchanged.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const AT = "2026-09-20T10:00:00.000Z";
const EARLIER = "2026-09-20T09:59:59.000Z";
const COLUMNS = `legal_entity_id, operational_treasury_account_id, operational_expense_category_id, payee_business_party_id, project_id,
  department_id, cost_center_id, reference, description, note, business_date, original_amount, original_currency_code, base_amount,
  base_currency_code, exchange_rate_snapshot_id, workflow_policy_version_id, approval_required, correlation_id, request_fingerprint,
  created_by_user_account_id, payment_kind`;

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };

function session(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0056 transition time is audit only", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0056: transition time is audit metadata, never a reason to refuse", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    let world: SyntheticWorld; let creator: Session; let safe: string; let category: string; let posted: string;
    const login = `abos_tt_${randomUUID().replaceAll("-", "")}`;

    const call = async <T>(name: string, payload: object): Promise<T> => {
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`,
        [creator.proof, creator.runtimeDigest, creator.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    };
    const keys = () => ({ idempotencyKey: `tt-${randomUUID()}`, correlationId: randomUUID() });
    const expense = (amount: string) => call<{ expense: { id: string; status: string; journalId: string | null } }>("operational_expense_create", {
      treasuryAccountId: safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null,
      reference: "TT-EXP", description: "Synthetic transition-time expense", note: null, businessDate: "2026-09-20", originalAmount: amount,
      currencyCode: "USD", exchangeRateId: null, ...keys() });

    /** A DRAFT copy of a real expense with fixed audit times, written by the owner only to exercise the row guard. */
    const draftAt = async (client: pg.PoolClient, at: string): Promise<string> => {
      const id = randomUUID();
      await client.query(`INSERT INTO abos.operational_expenses (id, ${COLUMNS}, idempotency_key, status, version, journal_id, created_at, updated_at)
        SELECT $1, ${COLUMNS}, $2, 'DRAFT', 1, NULL, $3, $3 FROM abos.operational_expenses WHERE id = $4`, [id, `tt-copy-${randomUUID()}`, at, posted]);
      return id;
    };
    const inRolledBackTransaction = async (work: (client: pg.PoolClient) => Promise<void>) => {
      const client = await h.pool.connect();
      try { await client.query("BEGIN"); await work(client); } finally { await client.query("ROLLBACK"); client.release(); }
    };
    const savepoint = async (client: pg.PoolClient, sql: string, parameters: unknown[], pattern: RegExp) => {
      await client.query("SAVEPOINT attempt");
      await assert.rejects(() => client.query(sql, parameters), pattern);
      await client.query("ROLLBACK TO SAVEPOINT attempt");
    };

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });

      world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const e = world.legalEntityId; const u = world.bootstrapUserId;
      await grant(h.executor, world, world.intentCreatorId, ["finance.expense.create", "finance.expense.read", "treasury.safe.read",
        "treasury.opening-balance.record"]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'EXPENSE',1,false,$3,'Synthetic Simple Mode setting')`, [randomUUID(), e, u]);
      safe = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, e, world.cashLedgerAccountId, u]);
      const expenseLedger = randomUUID(); const equity = randomUUID();
      for (const [id, code, type, control] of [[expenseLedger, "TT-EXP", "EXPENSE", null], [equity, "TT-OBE", "EQUITY", "OPENING_BALANCE_EQUITY"]] as const) {
        await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
          VALUES ($1,$2,$3,$3,$4,$5,true,'USD','ACTIVE')`, [id, e, code, type, control]);
      }
      category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'TT','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseLedger, u]);
      creator = session((await issueOperationalSession(h, world.intentCreatorId, e)).token);
      await call("treasury_opening_balance_record", { treasuryAccountId: safe, amount: "100000.00", currencyCode: "USD", asOfDate: "2026-09-01",
        reference: "TT-OB", note: null, ...keys() });
      posted = (await expense("1.00")).expense.id;
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    test("an expense transition whose time equals or precedes the previous one is accepted; the stored time never moves back", async () => {
      await inRolledBackTransaction(async (client) => {
        const equal = await draftAt(client, AT);
        await client.query("UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 2, updated_at = $2 WHERE id = $1", [equal, AT]);
        const stepBack = await draftAt(client, AT);
        await client.query("UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 2, updated_at = $2 WHERE id = $1", [stepBack, EARLIER]);
        const rows = (await client.query<{ id: string; status: string; version: number; at: string }>(
          "SELECT id, status, version, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS at FROM abos.operational_expenses WHERE id = ANY($1::uuid[])",
          [[equal, stepBack]])).rows;
        assert.deepEqual(rows.map((r) => [r.status, r.version, r.at]).sort(), [["VALIDATED", 2, "2026-09-20T10:00:00"], ["VALIDATED", 2, "2026-09-20T10:00:00"]]);
      });
    });

    test("the guard's real invariants are unchanged: version by exactly one, allowed transitions, identity and posted rows fixed, no delete", async () => {
      await inRolledBackTransaction(async (client) => {
        const id = await draftAt(client, AT);
        const later = "2026-09-20T10:00:05.000Z";
        await savepoint(client, "UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 1, updated_at = $2 WHERE id = $1", [id, later],
          /an expense transition must advance its version by exactly one/);
        await savepoint(client, "UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 3, updated_at = $2 WHERE id = $1", [id, later],
          /an expense transition must advance its version by exactly one/);
        await savepoint(client, "UPDATE abos.operational_expenses SET status = 'POSTED', version = 2, updated_at = $2 WHERE id = $1", [id, later],
          /invalid operational expense transition DRAFT -> POSTED/);
        await savepoint(client, "UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 2, original_amount = 2, updated_at = $2 WHERE id = $1",
          [id, later], /the accounting identity of an operational expense cannot change/);
        await savepoint(client, "DELETE FROM abos.operational_expenses WHERE id = $1", [id], /operational expenses are permanent records/);
        await savepoint(client, "UPDATE abos.operational_expenses SET version = version + 1, updated_at = updated_at WHERE id = $1", [posted],
          /a posted operational expense is immutable/);
        await client.query("UPDATE abos.operational_expenses SET status = 'VALIDATED', version = 2, updated_at = $2 WHERE id = $1", [id, later]);
        await savepoint(client, "UPDATE abos.operational_expenses SET status = 'DRAFT', version = 3, updated_at = $2 WHERE id = $1", [id, later],
          /invalid operational expense transition VALIDATED -> DRAFT/);
      });
    });

    test("recording with approval OFF (insert, validate and post in one transaction) posts every time, without waiting", async () => {
      const journalsBefore = Number((await h.pool.query("SELECT count(*) AS n FROM abos.journals")).rows[0]?.n);
      for (let i = 0; i < 200; i += 1) {
        const recorded = await expense("1.00");
        assert.equal(recorded.expense.status, "POSTED", `expense ${i} posted`);
        assert.ok(recorded.expense.journalId);
      }
      const rows = (await h.pool.query<{ n: string; bad: string }>(
        `SELECT count(*) AS n, count(*) FILTER (WHERE version <> 3 OR status <> 'POSTED' OR updated_at < created_at OR journal_id IS NULL) AS bad
           FROM abos.operational_expenses WHERE id <> $1 AND idempotency_key LIKE 'tt-%'`, [posted])).rows[0];
      assert.deepEqual([rows?.n, rows?.bad], ["200", "0"]);
      assert.equal(Number((await h.pool.query("SELECT count(*) AS n FROM abos.journals")).rows[0]?.n), journalsBefore + 200);
    });
  });
}
