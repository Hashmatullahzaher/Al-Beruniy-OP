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
 * Migration 0043: the posting kernel and the source registry. One kernel trigger enforces the shared
 * accounting invariants of every operational journal, reads each source's rules from
 * abos.posting_sources and dispatches with a static CASE to one small validator per source.
 *
 * Faults are injected into real postings through disposable BEFORE INSERT triggers (a model of a
 * future broken writer; no runtime holds DDL authority) and must be refused with nothing persisted.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const OWNER = "abos_v1_operational_finance_owner";
const PERMISSIONS = ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
  "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read",
  "finance.expense.create", "finance.expense.read"];
// 0046 activates OPENING_BALANCE.
const ACTIVE = ["CASH_RECEIPT", "DIRECT_SHAREHOLDER_CAPITAL", "OPENING_BALANCE", "OPERATIONAL_EXPENSE", "PAYMENT", "TEMPORARY_FUNDING", "TEMPORARY_FUNDING_SETTLEMENT", "TREASURY_TRANSFER"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Fixture = { world: SyntheticWorld; actor: Session; safe: string; category: string; otherExpense: string; shareholder: string };

if (databaseUrl() === undefined) {
  test("0043 posting kernel", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0043: one posting kernel, a source registry and static dispatch", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_kernel_${randomUUID().replaceAll("-", "")}`;
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
      if (h !== undefined) { await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    async function fixture(): Promise<Fixture> {
      for (const name of injected.splice(0)) await h.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${name.startsWith("kt_line") ? "abos.journal_lines" : name.startsWith("kt_sub") ? "abos.subledger_entries" : "abos.journals"}`);
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, PERMISSIONS);
      const safe = randomUUID(); const category = randomUUID(); const expense = randomUUID(); const otherExpense = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
        (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Synthetic kernel Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`, [safe, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
      for (const [id, code] of [[expense, "SYN-K-EXP"], [otherExpense, "SYN-K-EXP2"]] as const) {
        await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
          VALUES($1,$2,$3,'Synthetic kernel expense','EXPENSE',true,'USD','ACTIVE')`, [id, world.legalEntityId, code]);
      }
      await h.pool.query(`INSERT INTO abos.operational_expense_categories
        (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-K','Synthetic kernel category',$3,'ACTIVE',1,$4,$4)`, [category, world.legalEntityId, expense, world.bootstrapUserId]);
      for (const workflow of ["SHAREHOLDER_CAPITAL_RECEIPT", "EXPENSE"]) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
          (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic kernel test policy')`, [randomUUID(), world.legalEntityId, workflow, world.bootstrapUserId]);
      }
      const issued = await issueOperationalSession(h, world.intentCreatorId, world.legalEntityId);
      const actor = {
        proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
        runtimeDigest: createHash("sha256").update(issued.token).digest("hex"),
        tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(issued.token).digest("hex")
      };
      const created = await call<{ shareholderProfileId: string }>("direct_shareholder_add", actor, {
        displayName: "Synthetic Kernel Holder", agreedTotal: null, currencyCode: null, externalReference: null, note: null,
        businessDate: "2026-09-20", firstContribution: null, ...keys() });
      return { world, actor, safe, category, otherExpense, shareholder: created.shareholderProfileId };
    }
    async function call<T>(name: string, s: Session, payload: object): Promise<T> {
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`,
        [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `kernel-${randomUUID()}`, correlationId: randomUUID() });
    const capital = (f: Fixture, extra: object = {}) => call<{ journalId: string }>("direct_shareholder_receive", f.actor, {
      shareholderProfileId: f.shareholder, fundingMethod: "CASH", amount: "500", currencyCode: "USD", receiptDate: "2026-09-21",
      destinationAccountId: f.safe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
      paymentReference: "SYN-KERNEL", note: null, ...keys(), ...extra });
    const expense = (f: Fixture) => call<{ journalId?: string; status: string }>("operational_expense_create", f.actor, {
      treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
      costCenterId: null, reference: `SYN-K-${randomUUID().slice(0, 8)}`, description: "Synthetic kernel expense", note: null,
      businessDate: "2026-09-22", originalAmount: "40.00", currencyCode: "USD", exchangeRateId: null, ...keys() });
    async function financialRows(): Promise<string> {
      return (await h.pool.query<{ v: string }>(`SELECT
        (SELECT count(*) FROM abos.posting_intents)||'/'||(SELECT count(*) FROM abos.journals)||'/'||
        (SELECT count(*) FROM abos.journal_lines)||'/'||(SELECT count(*) FROM abos.subledger_entries) AS v`)).rows[0]?.v ?? "";
    }
    /** A disposable BEFORE INSERT trigger that rewrites one row; the posting it breaks must be refused. */
    async function inject(table: "journal_lines" | "subledger_entries" | "journals", body: string): Promise<void> {
      const name = `${table === "journal_lines" ? "kt_line" : table === "subledger_entries" ? "kt_sub" : "a_kt_journal"}_${randomUUID().slice(0, 8)}`;
      await h.pool.query(`CREATE FUNCTION abos.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
      await h.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON abos.${table} FOR EACH ROW EXECUTE FUNCTION abos.${name}()`);
      injected.push(name);
    }

    test("the registry names every source, is lock-only, and only the operational Finance owner reads it", async () => {
      await resetSchema(h.pool);
      const rows = (await h.pool.query<{ source_type: string; status: string; validator: string | null; line_count: number | null }>(
        "SELECT source_type, status, validator, line_count FROM abos.posting_sources ORDER BY source_type")).rows;
      assert.deepEqual(rows.filter((r) => r.status === "ACTIVE").map((r) => r.source_type), ACTIVE);
      assert.deepEqual(rows.filter((r) => r.status === "FROZEN").map((r) => r.source_type), ["SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT"]);
      assert.deepEqual(rows.filter((r) => r.status === "PLANNED").map((r) => r.source_type).sort(),
        ["COUNT_DIFFERENCE", "REVERSAL"]);
      const kernel = (await h.pool.query<{ d: string }>("SELECT pg_get_functiondef('abos.posting_kernel_validate()'::regprocedure) AS d")).rows[0]?.d ?? "";
      for (const row of rows.filter((r) => r.status === "ACTIVE")) {
        assert.equal(row.line_count, 2, row.source_type);
        assert.ok((await h.pool.query("SELECT to_regprocedure($1) AS f", [`abos.${row.validator}(abos.journals,abos.posting_intents)`])).rows[0]?.f, `${row.validator} exists`);
        assert.match(kernel, new RegExp(`WHEN '${row.source_type}' THEN PERFORM abos\\.${row.validator}\\(NEW, v_intent\\)`), `static arm for ${row.source_type}`);
      }
      assert.doesNotMatch(kernel, /\bEXECUTE\s+(format|'|\$|[a-z_]+\s*\|\|)/i, "dispatch is static: no dynamic SQL in the kernel");
      await assert.rejects(() => h.pool.query("UPDATE abos.posting_sources SET reversible = NOT reversible"), /append-only|cannot be|immutable/i);
      await assert.rejects(() => h.pool.query("DELETE FROM abos.posting_sources WHERE status = 'PLANNED'"), /append-only|cannot be|immutable/i);
      const may = async (role: string, privilege: string) => (await h.pool.query<{ ok: boolean }>(
        "SELECT has_table_privilege($1, 'abos.posting_sources', $2) AS ok", [role, privilege])).rows[0]?.ok;
      assert.equal(await may(OWNER, "SELECT"), true);
      assert.equal(await may(OWNER, "INSERT"), false);
      for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime", "abos_e1_frozen_lane"]) {
        assert.equal(await may(role, "SELECT"), false, `${role} cannot read the registry`);
      }
      const triggers = (await h.pool.query<{ t: string }>(
        "SELECT tgname AS t FROM pg_trigger WHERE tgrelid = 'abos.journals'::regclass AND NOT tgisinternal AND tgname LIKE 'journals_operational%' ORDER BY 1")).rows.map((r) => r.t);
      assert.deepEqual(triggers, ["journals_operational_capital_posting_guard", "journals_operational_kernel_guard"]);
      for (const gone of ["validate_operational_journal_posting()", "validate_direct_capital_journal_posting()", "validate_temporary_funding_journal_posting()"]) {
        assert.equal((await h.pool.query("SELECT to_regprocedure($1) AS f", [`abos.${gone}`])).rows[0]?.f, null, `${gone} is gone`);
      }
      const publicExecute = (await h.pool.query(`SELECT p.proname FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.pronamespace = 'abos'::regnamespace AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
          AND (p.proname = 'posting_kernel_validate' OR p.proname LIKE 'validate\\_%\\_journal')`)).rows;
      assert.deepEqual(publicExecute, [], "nobody executes the kernel or the validators through PUBLIC");
      for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime"]) {
        assert.equal((await h.pool.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'abos.validate_expense_journal(abos.journals,abos.posting_intents)', 'EXECUTE') AS ok", [role])).rows[0]?.ok, false);
      }
    });

    test("real postings pass the kernel for direct capital and expense", async () => {
      const f = await fixture();
      const received = await capital(f);
      const spent = await expense(f);
      const status = (await h.pool.query<{ id: string; status: string; source: string }>(
        `SELECT j.id, j.status, i.source_type AS source FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id ORDER BY i.source_type`)).rows;
      assert.deepEqual(status.map((r) => [r.source, r.status]), [["DIRECT_SHAREHOLDER_CAPITAL", "POSTED"], ["OPERATIONAL_EXPENSE", "POSTED"]]);
      assert.ok(received.journalId); void spent;
    });

    test("shared invariants are refused by the kernel, whichever source is posting", async () => {
      const f = await fixture();
      const before = await financialRows();
      const cases: { label: string; table: "journal_lines" | "subledger_entries" | "journals"; body: string; error: RegExp; run: () => Promise<unknown> }[] = [
        { label: "a credit line on an account the source does not allow",
          table: "journal_lines", body: `IF NEW.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' AND NEW.line_number = 2 THEN NEW.ledger_account_id := '${f.world.cashLedgerAccountId}'; END IF;`,
          error: /operational journal line violates entity, currency, account or dimension rules/, run: () => capital(f) },
        { label: "unbalanced lines",
          table: "journal_lines", body: `IF NEW.source_type = 'OPERATIONAL_EXPENSE' AND NEW.line_number = 2 THEN NEW.base_credit := NEW.base_credit + 1; END IF;`,
          error: /must contain exactly 2 lines balanced to its intent amount/, run: () => expense(f) },
        { label: "a subledger movement whose magnitude differs from its line",
          table: "subledger_entries", body: `IF NEW.subledger_type = 'SHAREHOLDER_CAPITAL' THEN NEW.base_amount := NEW.base_amount - 1; NEW.original_amount := NEW.original_amount - 1; END IF;`,
          error: /operational subledger movement violates its source, currency, amount or registered shape/, run: () => capital(f) },
        { label: "a Treasury movement on the side the source does not register",
          table: "subledger_entries", body: `IF NEW.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' AND NEW.subledger_type = 'OPERATIONAL_TREASURY' THEN
            NEW.journal_line_id := (SELECT id FROM abos.journal_lines WHERE journal_id = (SELECT journal_id FROM abos.journal_lines WHERE id = NEW.journal_line_id) AND line_number = 2); END IF;`,
          error: /operational subledger movement violates its source, currency, amount or registered shape/, run: () => capital(f) },
        { label: "a journal booked into a period that is not open",
          table: "journals", body: `IF NEW.processing_model = 'OPERATIONAL_V1' THEN NEW.accounting_period_id := (SELECT id FROM abos.accounting_periods WHERE period_name = 'SYN-KERNEL-PENDING'); END IF;`,
          error: /operational posting requires an open accounting period covering its date/, run: () => expense(f) }
      ];
      await h.pool.query(`INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on)
        VALUES ($1, $2, 'SYN-KERNEL-PENDING', '2026-08-01', '2026-08-31')`, [randomUUID(), f.world.legalEntityId]);
      for (const scenario of cases) {
        await inject(scenario.table, scenario.body);
        await assert.rejects(scenario.run, scenario.error, scenario.label);
        const name = injected.pop() ?? "";
        await h.pool.query(`DROP TRIGGER ${name} ON abos.${scenario.table}`);
        assert.equal(await financialRows(), before, `${scenario.label}: nothing persisted`);
      }
      await capital(f); await expense(f);
      assert.notEqual(await financialRows(), before, "the same postings succeed once the fault is removed");
    });

    test("source validators still refuse what only their source knows", async () => {
      const f = await fixture();
      const before = await financialRows();
      await inject("journal_lines", `IF NEW.source_type = 'OPERATIONAL_EXPENSE' AND NEW.line_number = 1 THEN NEW.ledger_account_id := '${f.otherExpense}'; END IF;`);
      await assert.rejects(() => expense(f), /expense journal must debit its category and credit its Treasury mapping/,
        "another EXPENSE account satisfies the registry rule but is not the category's account");
      await h.pool.query(`DROP TRIGGER ${injected.pop()} ON abos.journal_lines`);
      await inject("journal_lines", "IF NEW.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' AND NEW.line_number = 2 THEN NEW.business_party_id := NULL; END IF;");
      await assert.rejects(() => capital(f), /direct capital requires its exact method debit and shareholder equity credit/);
      await h.pool.query(`DROP TRIGGER ${injected.pop()} ON abos.journal_lines`);
      assert.equal(await financialRows(), before, "nothing persisted");
    });

    test("posted journals are immutable, drafts come first, and unregistered or planned sources cannot post", async () => {
      const f = await fixture();
      const posted = await capital(f);
      const asOwner = async (work: (client: pg.PoolClient) => Promise<void>) => {
        const client = await h.pool.connect();
        try { await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${OWNER}`); await work(client); }
        finally { await client.query("ROLLBACK"); client.release(); }
      };
      /** Each expected refusal runs under its own savepoint so the transaction can continue. */
      const refused = async (c: pg.PoolClient, sql: string, values: unknown[], error: RegExp) => {
        await c.query("SAVEPOINT expected_refusal");
        await assert.rejects(() => c.query(sql, values), error);
        await c.query("ROLLBACK TO SAVEPOINT expected_refusal");
      };
      await asOwner(async (c) => {
        await assert.rejects(() => c.query("UPDATE abos.journals SET posted_at = clock_timestamp() WHERE id = $1", [posted.journalId]),
          /a posted operational journal is immutable/);
      });
      for (const [source, error] of [["REVERSAL", /operational posting source REVERSAL is not available yet/],
        ["BOGUS_SOURCE", /operational posting source BOGUS_SOURCE is not registered/]] as const) {
        await asOwner(async (c) => {
          const intent = randomUUID(); const journal = randomUUID(); const sourceId = randomUUID();
          await c.query(`INSERT INTO abos.posting_intents (id, legal_entity_id, source_type, source_id, intent_kind, original_amount,
              original_currency_code, base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key,
              status, created_by_user_account_id, processing_model, operational_version)
            VALUES ($1,$2,$3,$4,'REVERSAL',10,'USD',10,'USD','2026-09-21',gen_random_uuid(),$5,'POSTED',$6,'OPERATIONAL_V1',1)`,
          [intent, f.world.legalEntityId, source, sourceId, `kernel-${randomUUID()}`, f.world.intentCreatorId]);
          await refused(c, `INSERT INTO abos.journals (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
              accounting_effective_date, base_currency_code, status, created_by_user_account_id, processing_model)
            VALUES ($1,$2,$3,$4,$5,'2026-09-21','USD','POSTED',$6,'OPERATIONAL_V1')`,
          [randomUUID(), f.world.legalEntityId, f.world.accountingPeriodId, intent, `KT-${randomUUID()}`, f.world.intentCreatorId],
          /operational journals must be assembled as draft before posting/);
          await c.query(`INSERT INTO abos.journals (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
              accounting_effective_date, base_currency_code, status, created_by_user_account_id, processing_model)
            VALUES ($1,$2,$3,$4,$5,'2026-09-21','USD','DRAFT',$6,'OPERATIONAL_V1')`,
          [journal, f.world.legalEntityId, f.world.accountingPeriodId, intent, `KT-${randomUUID()}`, f.world.intentCreatorId]);
          await assert.rejects(() => c.query(
            "UPDATE abos.journals SET status = 'POSTED', posted_by_user_account_id = created_by_user_account_id, posted_at = clock_timestamp() WHERE id = $1",
            [journal]), error);
        });
      }
    });
  });
}
