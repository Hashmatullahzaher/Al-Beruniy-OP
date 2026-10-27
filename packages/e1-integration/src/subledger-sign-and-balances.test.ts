import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, withClusterLock, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0045: one subledger sign convention (debit = positive, credit = negative) enforced by the
 * posting kernel, and one balance read model that every page uses. A balance takes every posted
 * movement; scope and source confidentiality hide details, never money.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const MIGRATION = "0045_v1_subledger_sign_and_balances";
const PERMISSIONS = ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
  "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read",
  "finance.expense.create", "finance.expense.read"];
const READ_MODEL = ["abos.treasury_account_balances(uuid,date,uuid)", "abos.treasury_account_movements(uuid,uuid,date,date,uuid)",
  "abos.ledger_account_balances(uuid,date,date)", "abos.shareholder_capital_balances(uuid)"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Fixture = { world: SyntheticWorld; actor: Session; safe: string; category: string; expenseLedger: string; shareholder: string; party: string };

if (databaseUrl() === undefined) {
  test("0045 subledger sign and balances", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0045: one sign convention and one balance read model", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_balance_${randomUUID().replaceAll("-", "")}`;
    const injected: string[] = [];

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 3 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    async function fixture(): Promise<Fixture> {
      for (const name of injected.splice(0)) await h.pool.query(`DROP TRIGGER IF EXISTS ${name} ON abos.subledger_entries`);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, PERMISSIONS);
      const safe = randomUUID(); const category = randomUUID(); const expenseLedger = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
        (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Synthetic balance Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`, [safe, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-BAL-EXP','Synthetic balance expense','EXPENSE',true,'USD','ACTIVE')`, [expenseLedger, world.legalEntityId]);
      await h.pool.query(`INSERT INTO abos.operational_expense_categories
        (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-BAL','Synthetic balance category',$3,'ACTIVE',1,$4,$4)`, [category, world.legalEntityId, expenseLedger, world.bootstrapUserId]);
      for (const workflow of ["SHAREHOLDER_CAPITAL_RECEIPT", "EXPENSE"]) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
          (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic balance test policy')`, [randomUUID(), world.legalEntityId, workflow, world.bootstrapUserId]);
      }
      const issued = await issueOperationalSession(h, world.intentCreatorId, world.legalEntityId);
      const actor = {
        proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
        runtimeDigest: createHash("sha256").update(issued.token).digest("hex"),
        tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(issued.token).digest("hex")
      };
      const created = await call<{ shareholderProfileId: string; businessPartyId: string }>("direct_shareholder_add", actor, {
        displayName: "Synthetic Balance Holder", agreedTotal: null, currencyCode: null, externalReference: null, note: null,
        businessDate: "2026-09-20", firstContribution: null, ...keys() });
      const [{ party }] = (await h.pool.query<{ party: string }>("SELECT business_party_id AS party FROM abos.shareholder_profiles WHERE id = $1",
        [created.shareholderProfileId])).rows as [{ party: string }];
      return { world, actor, safe, category, expenseLedger, shareholder: created.shareholderProfileId, party };
    }
    async function call<T>(name: string, s: Session, payload: object): Promise<T> {
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`,
        [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `balance-${randomUUID()}`, correlationId: randomUUID() });
    const capital = (f: Fixture, amount: string, date: string) => call("direct_shareholder_receive", f.actor, {
      shareholderProfileId: f.shareholder, fundingMethod: "CASH", amount, currencyCode: "USD", receiptDate: date,
      destinationAccountId: f.safe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
      paymentReference: "SYN-BALANCE", note: null, ...keys() });
    const expense = (f: Fixture, amount: string, date: string, extra: object = {}) => call("operational_expense_create", f.actor, {
      treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
      costCenterId: null, reference: `SYN-BAL-${randomUUID().slice(0, 8)}`, description: "Synthetic balance expense", note: null,
      businessDate: date, originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
    const balances = async (f: Fixture, asOf: string | null) => (await h.pool.query<Record<string, string>>(
      `SELECT opening_balance::text AS opening, inflows::text AS inflows, outflows::text AS outflows, book_balance::text AS book,
              movement_count::text AS count, last_movement_date::text AS last
         FROM abos.treasury_account_balances($1, $2::date, $3)`, [f.world.legalEntityId, asOf, f.safe])).rows[0];
    async function rows(): Promise<string> {
      return (await h.pool.query<{ v: string }>(`SELECT (SELECT count(*) FROM abos.journals)||'/'||(SELECT count(*) FROM abos.subledger_entries) AS v`)).rows[0]?.v ?? "";
    }

    test("the kernel refuses a subledger movement with the wrong sign, even at the right magnitude and side", async () => {
      await resetSchema(h.pool);
      const f = await fixture();
      const before = await rows();
      const name = `kt_sign_${randomUUID().slice(0, 8)}`;
      await h.pool.query(`CREATE FUNCTION abos.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.subledger_type = 'OPERATIONAL_TREASURY' THEN NEW.base_amount := -NEW.base_amount; NEW.original_amount := -NEW.original_amount; END IF;
        RETURN NEW; END $$`);
      await h.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON abos.subledger_entries FOR EACH ROW EXECUTE FUNCTION abos.${name}()`);
      injected.push(name);
      await assert.rejects(() => expense(f, "10.00", "2026-09-22"), /operational subledger movement violates its source, currency, amount or registered shape/);
      await assert.rejects(() => capital(f, "10", "2026-09-22"), /operational subledger movement violates its source, currency, amount or registered shape/);
      await h.pool.query(`DROP TRIGGER ${injected.pop()} ON abos.subledger_entries`);
      assert.equal(await rows(), before, "nothing persisted");
      const definition = (await h.pool.query<{ d: string }>("SELECT pg_get_functiondef('abos.posting_kernel_validate()'::regprocedure) AS d")).rows[0]?.d ?? "";
      assert.match(definition, /sign\(entry\.base_amount\) <> CASE WHEN line\.base_debit > 0 THEN 1 ELSE -1 END/);
      assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE sign(entry.base_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END`)).rows[0]?.n, 0);
    });

    test("Safe balances: opening, inflows, outflows and book balance from every posted movement, as of any date", async () => {
      await resetSchema(h.pool);
      const f = await fixture();
      assert.deepEqual(await balances(f, null), { opening: "0", inflows: "0", outflows: "0", book: "0", count: "0", last: null });
      await capital(f, "1000", "2026-09-20");
      await expense(f, "125.50", "2026-09-21");
      await expense(f, "0.25", "2026-09-22");
      assert.deepEqual(await balances(f, null), { opening: "0", inflows: "1000", outflows: "125.75", book: "874.25", count: "3", last: "2026-09-22" });
      assert.deepEqual(await balances(f, "2026-09-21"), { opening: "0", inflows: "1000", outflows: "125.50", book: "874.50", count: "2", last: "2026-09-21" });
      assert.deepEqual(await balances(f, "2026-09-19"), { opening: "0", inflows: "0", outflows: "0", book: "0", count: "0", last: null });
      // The ledger agrees: the Safe's ledger account nets to the same book balance in the base currency.
      const ledger = (await h.pool.query<{ debit: string; credit: string; net: string }>(
        `SELECT debit_total::text AS debit, credit_total::text AS credit, net_balance::text AS net FROM abos.ledger_account_balances($1, NULL, NULL)
          WHERE ledger_account_id = $2`, [f.world.legalEntityId, f.world.cashLedgerAccountId])).rows[0];
      assert.deepEqual(ledger, { debit: "1000", credit: "125.75", net: "874.25" });
      const expenseLedger = (await h.pool.query<{ net: string }>(`SELECT net_balance::text AS net FROM abos.ledger_account_balances($1, '2026-09-22', '2026-09-22')
          WHERE ledger_account_id = $2`, [f.world.legalEntityId, f.expenseLedger])).rows[0];
      assert.deepEqual(expenseLedger, { net: "0.25" });
      const capitalBalance = (await h.pool.query<{ party: string; currency: string; posted: string }>(
        `SELECT business_party_id AS party, currency_code AS currency, capital_posted::text AS posted FROM abos.shareholder_capital_balances($1)`,
        [f.world.legalEntityId])).rows;
      assert.deepEqual(capitalBalance, [{ party: f.party, currency: "USD", posted: "1000" }]);
      // Another company sees none of it.
      const other = await h.pool.query("SELECT count(*)::int AS n FROM abos.treasury_account_balances($1, NULL, NULL)", [randomUUID()]);
      assert.equal(other.rows[0]?.n, 0);
    });

    test("a movement outside the reader's scope keeps its money and hides only its reference", async () => {
      await resetSchema(h.pool);
      const f = await fixture();
      const project = randomUUID();
      await h.pool.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'SYN-HID','Synthetic hidden project',true)",
        [project, f.world.legalEntityId]);
      await h.pool.query(`INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id)
        VALUES ($1,$2,'PROJECT',$3,$4)`, [f.world.intentCreatorId, f.world.legalEntityId, project, f.world.bootstrapUserId]);
      await capital(f, "500", "2026-09-20");
      await expense(f, "200", "2026-09-21", { projectId: project });
      const read = async (actor: string) => (await h.pool.query<{ amount: string; source: string; reference: string | null; restricted: boolean }>(
        `SELECT amount::text AS amount, source_type AS source, journal_reference AS reference, restricted
           FROM abos.treasury_account_movements($1, $2, NULL, NULL, $3)`, [f.world.legalEntityId, f.safe, actor])).rows;
      const outsider = await read(f.world.approverId);
      assert.deepEqual(outsider.map((m) => [m.amount, m.source, m.reference === null, m.restricted]),
        [["-200", "OPERATIONAL_EXPENSE", true, true], ["500", "DIRECT_SHAREHOLDER_CAPITAL", false, false]]);
      const insider = await read(f.world.intentCreatorId);
      assert.deepEqual(insider.map((m) => [m.amount, m.reference === null, m.restricted]), [["-200", false, false], ["500", false, false]]);
      assert.equal((await balances(f, null))?.book, "300", "the balance never depends on who reads it");
    });

    test("the read model is internal: only the operational Finance owner executes it", async () => {
      await resetSchema(h.pool);
      for (const routine of READ_MODEL) {
        const may = async (role: string) => (await h.pool.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, routine])).rows[0]?.ok;
        assert.equal(await may("abos_v1_operational_finance_owner"), true, routine);
        for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime", "abos_e1_frozen_lane", "abos_v1_shareholder_setup_owner"]) {
          assert.equal(await may(role), false, `${role} cannot execute ${routine}`);
        }
        const publicGrant = (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p
          CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = $1::regprocedure AND a.grantee = 0`, [routine])).rows[0]?.n;
        assert.equal(publicGrant, 0, `${routine}: nothing through PUBLIC`);
        const definition = (await h.pool.query<{ d: string; secdef: boolean }>("SELECT pg_get_functiondef($1::regprocedure) AS d, prosecdef AS secdef FROM pg_proc WHERE oid = $1::regprocedure", [routine])).rows[0];
        assert.equal(definition?.secdef, false, `${routine} runs with its caller's rights`);
        assert.doesNotMatch(definition?.d ?? "", /\bEXECUTE\s+(format|'|\$)/i, "no dynamic SQL");
      }
    });

    test("upgrade from a populated 0044 database changes no row, and refuses a posted movement that breaks the convention", async () => {
      const migrations = await loadMigrations();
      const index = migrations.findIndex((m) => m.id === MIGRATION);
      assert.ok(index > 0);
      const build = async () => withClusterLock(h.pool, async () => {
        const client = await h.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          await client.query(`CREATE SCHEMA abos; CREATE TABLE abos.schema_migrations (migration_id text PRIMARY KEY,
            checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
          for (const migration of migrations.slice(0, index)) {
            await client.query(migration.sql);
            await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)", [migration.id, migration.checksumSha256]);
          }
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      });
      await build();
      const f = await fixture();
      await capital(f, "300", "2026-09-20");
      await expense(f, "45.10", "2026-09-21");
      const tables = (await h.pool.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'abos' AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.t);
      const snapshot = async () => {
        const out: Record<string, string> = {};
        for (const t of tables) out[t] = (await h.pool.query<{ h: string }>(`SELECT count(*)||':'||md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM abos.${t} x`)).rows[0]?.h ?? "";
        return out;
      };
      const before = await snapshot();
      const migration = migrations[index]!;
      await h.pool.query(migration.sql);
      assert.deepEqual(await snapshot(), before, "0045 changes no row of any existing table");
      assert.deepEqual((await balances(f, null))?.book, "254.90", "the read model reads the upgraded rows");

      // A database holding a posted movement against the convention is refused, not silently re-signed.
      await build();
      const g = await fixture();
      await capital(g, "300", "2026-09-20");
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query("UPDATE abos.subledger_entries SET base_amount = -base_amount, original_amount = -original_amount WHERE subledger_type = 'OPERATIONAL_TREASURY'");
        await client.query("SET LOCAL session_replication_role = origin");
        await assert.rejects(() => client.query(migration.sql), /0045 found 1 subledger movement\(s\) that do not follow debit = positive, credit = negative/);
      } finally { await client.query("ROLLBACK"); client.release(); }
      await resetSchema(h.pool);
    });
  });
}
