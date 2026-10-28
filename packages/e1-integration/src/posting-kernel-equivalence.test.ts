import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, withClusterLock, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/**
 * Migration 0044 moves the expense and direct capital writers onto the posting kernel. The binding
 * rule is byte-equivalent accounting output, so the proof is behavioural: the same scenarios run on a
 * database built through 0043 (the writers' own posting blocks) and on the fully migrated catalogue
 * (the kernel writer), and every row they produce must be identical once generated ids and clock
 * timestamps are replaced by their order of appearance.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const PREDECESSOR = "0043_v1_posting_kernel";
const MIGRATION = "0044_v1_posting_kernel_writer";
const PERMISSIONS = ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
  "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read",
  "finance.expense.create", "finance.expense.read"];

/** Every table either writer touches, each in an order that does not depend on generated ids. */
const PROJECTION: readonly [string, string][] = [
  ["posting_intents", "x.created_at, x.idempotency_key"],
  ["journals", "x.created_at, x.journal_reference"],
  ["journal_lines", "(SELECT j.created_at FROM abos.journals j WHERE j.id = x.journal_id), x.line_number"],
  ["subledger_entries", `(SELECT j.created_at FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
     WHERE l.id = x.journal_line_id), (SELECT l.line_number FROM abos.journal_lines l WHERE l.id = x.journal_line_id)`],
  ["operational_expenses", "x.created_at, x.idempotency_key"],
  ["operational_expense_approvals", "x.approved_at"],
  ["direct_capital_receipts", "x.created_at, x.idempotency_key"],
  ["direct_capital_receipt_allocations", `(SELECT r.created_at FROM abos.direct_capital_receipts r WHERE r.id = x.receipt_id),
     (SELECT c.business_date FROM abos.shareholder_contributions c WHERE c.id = x.contribution_id), x.amount`],
  ["shareholder_contributions", "x.created_at, x.business_date, x.amount"],
  ["accounting_periods", "x.starts_on"],
  ["idempotency_records", "x.created_at, x.idempotency_key"],
  ["audit_records", "x.occurred_at, x.action, x.entity_type"],
  ["outbox_events", "x.occurred_at, x.event_type"]
];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };

if (databaseUrl() === undefined) {
  test("0044 posting kernel equivalence", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0044: the kernel writer produces exactly the rows the source writers produced", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_kernel_eq_${randomUUID().replaceAll("-", "")}`;

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

    /** A committed catalogue through `last` (inclusive): each migration's reviewed SQL and registry row, as the runner records them. */
    async function buildThrough(last: string): Promise<void> {
      const migrations = await loadMigrations();
      const index = migrations.findIndex((m) => m.id === last);
      assert.ok(index > 0, `${last} is registered`);
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
      const latest = (await h.pool.query<{ id: string }>("SELECT max(migration_id) AS id FROM abos.schema_migrations")).rows[0]?.id;
      assert.equal(latest, last);
    }

    async function call<T>(name: string, s: Session, payload: object): Promise<T> {
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`,
        [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    async function session(userId: string, entity: string): Promise<Session> {
      const issued = await issueOperationalSession(h, userId, entity);
      return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
        runtimeDigest: createHash("sha256").update(issued.token).digest("hex"),
        tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(issued.token).digest("hex") };
    }
    /** Deterministic request identity: the same keys and correlation ids in both databases. */
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

    /** One business day of postings, refusals included; returns the outcome of every call. */
    async function scenario(): Promise<unknown[]> {
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, PERMISSIONS);
      await grant(h.executor, world, world.approverId, ["finance.expense.approve", "finance.expense.read"]);
      const entity = world.legalEntityId; const by = world.bootstrapUserId;
      const safe = id(9001); const category = id(9002); const expenseLedger = id(9003); const asset = id(9004); const bill = id(9005);
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic equivalence Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, entity, world.cashLedgerAccountId, by]);
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$4,'SYN-EQ-EXP','Synthetic equivalence expense','EXPENSE',NULL,true,'USD','ACTIVE'),
               ($2,$4,'SYN-EQ-ASSET','Synthetic contributed assets','ASSET','SHAREHOLDER_CONTRIBUTED_ASSETS',true,'USD','ACTIVE'),
               ($3,$4,'SYN-EQ-BILL','Synthetic bill a shareholder paid','EXPENSE',NULL,true,'USD','ACTIVE')`, [expenseLedger, asset, bill, entity]);
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,
        created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'SYN-EQ','Synthetic equivalence category',$3,'ACTIVE',1,$4,$4)`,
      [category, entity, expenseLedger, by]);
      const policy = (workflow: string, version: number, approval: boolean) => h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
        (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,'Synthetic equivalence policy')`, [randomUUID(), entity, workflow, version, approval, by]);
      await policy("EXPENSE", 1, false); await policy("SHAREHOLDER_CAPITAL_RECEIPT", 1, false);
      const fiscalYear = id(9006);
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','۱۴۰۵','2026-10-01','2026-10-31',$3)`, [fiscalYear, entity, by]);
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,fiscal_year_id,period_sequence,period_name_fa)
        VALUES($1,$2,'2026-10','2026-10-01','2026-10-31','PENDING',$3,1,'میزان')`, [id(9007), entity, fiscalYear]);
      // A month that exists and is CLOSED: no posting may open or use it, in either catalogue.
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,
          opened_by_user_account_id,opened_at,closed_by_user_account_id,closed_at)
        VALUES($1,$2,'2026-08','2026-08-01','2026-08-31','CLOSED',$3,clock_timestamp(),$3,clock_timestamp())`, [id(9008), entity, by]);
      const creator = await session(world.intentCreatorId, entity);
      const approver = await session(world.approverId, entity);
      const outcomes: unknown[] = [];
      const attempt = async (label: string, work: () => Promise<unknown>) => {
        try { outcomes.push([label, "ok", await work()]); } catch (error) { outcomes.push([label, "refused", (error as Error).message]); }
      };
      const expense = (n: number, extra: object = {}) => call<{ expense: { id: string; version: number } }>("operational_expense_create", creator, {
        treasuryAccountId: safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
        costCenterId: null, reference: `SYN-EQ-${n}`, description: `Synthetic equivalence expense ${n}`, note: null,
        businessDate: "2026-09-24", originalAmount: "125.50", currencyCode: "USD", exchangeRateId: null,
        correlationId: id(n), idempotencyKey: `equivalence-expense-${n}`, ...extra });
      const receive = (n: number, extra: object) => call("direct_shareholder_receive", creator, {
        shareholderProfileId: holder, fundingMethod: "CASH", amount: "600", currencyCode: "USD", receiptDate: "2026-09-23",
        destinationAccountId: safe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
        paymentReference: `SYN-EQ-CAP-${n}`, note: null, correlationId: id(n), idempotencyKey: `equivalence-capital-${n}`, ...extra });


      const added = await call<{ shareholderProfileId: string }>("direct_shareholder_add", creator, {
        displayName: "Synthetic Equivalence Holder", agreedTotal: "1000", currencyCode: "USD", externalReference: null, note: null,
        businessDate: "2026-09-20", firstContribution: null, correlationId: id(10), idempotencyKey: "equivalence-holder" });
      const holder = added.shareholderProfileId;
      outcomes.push(["shareholder added", added]);
      await attempt("cash capital consumes the declaration", () => receive(11, {}));
      await attempt("cash capital replays", () => receive(11, {}));
      await attempt("hawala capital beyond the declaration", () => receive(12, { fundingMethod: "HAWALA", providerName: "Synthetic Saraf", amount: "700.25" }));
      await attempt("asset capital moves no Safe", () => receive(13, { fundingMethod: "ASSET", destinationAccountId: null, itemDescription: "Synthetic generator", amount: "200" }));
      await attempt("a paid bill is capital", () => receive(14, { fundingMethod: "BILL_PAYMENT", destinationAccountId: null, itemDescription: "Synthetic electricity bill", expenseLedgerAccountId: bill, amount: "45.5" }));
      await attempt("capital opens a pending month once", () => receive(15, { receiptDate: "2026-10-05", amount: "10" }));
      await attempt("capital in a month outside the calendar is refused", () => receive(16, { receiptDate: "2026-07-05" }));
      await attempt("capital in a foreign currency is refused", () => receive(17, { currencyCode: "AFN" }));
      // 0049: a Safe is spent only after money arrives, so capital is received first and expenses are dated after it.
      await attempt("expense posts directly", () => expense(1));
      await attempt("expense replays", () => expense(1));
      await attempt("expense with a payee and an exact decimal", () => expense(2, { payeeBusinessPartyId: world.businessPartyId, originalAmount: "0.01" }));
      await attempt("expense in a CLOSED month is refused", () => expense(3, { businessDate: "2026-08-14" }));
      await attempt("expense outside the financial calendar is refused", () => expense(5, { businessDate: "2026-07-05" }));
      await policy("EXPENSE", 2, true);
      const pending = await call<{ expense: { id: string; version: number } }>("operational_expense_create", creator, {
        treasuryAccountId: safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
        costCenterId: null, reference: "SYN-EQ-4", description: "Synthetic approval-route expense", note: null,
        businessDate: "2026-09-24", originalAmount: "1000.000001", currencyCode: "USD", exchangeRateId: null,
        correlationId: id(4), idempotencyKey: "equivalence-expense-4" });
      outcomes.push(["expense awaits approval", pending]);
      await attempt("approval posts the expense", async () => (await runtime.query<{ value: unknown }>(
        "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
        [approver.proof, approver.runtimeDigest, approver.tokenDigest, pending.expense.id, pending.expense.version, "Synthetic approval"])).rows[0]?.value);
      void asset;
      // The closed month refuses for the same reason in both catalogues: it is not an open period.
      const closed = outcomes.find((o) => Array.isArray(o) && o[0] === "expense in a CLOSED month is refused") as [string, string, string] | undefined;
      assert.equal(closed?.[1], "refused");
      assert.match(closed?.[2] ?? "", /an open accounting period must cover the expense date/);
      return outcomes;
    }

    const common = new Map<string, string[]>();
    /** Every row the writers touch, with ids and hashes replaced by order of appearance. */
    async function projection(outcomes: unknown[]): Promise<string> {
      const tables: Record<string, unknown[]> = {};
      for (const [table, order] of PROJECTION) {
        // Only columns that exist in both catalogues are compared: a column a later migration adds (always null
        // for these sources) is not accounting output of either writer.
        const columns = (await h.pool.query<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'abos' AND table_name = $1", [table])).rows.map((r) => r.c);
        const shared = common.get(table) ?? columns;
        common.set(table, shared.filter((c) => columns.includes(c)));
        tables[table] = (await h.pool.query<{ r: Record<string, unknown> }>(`SELECT to_jsonb(x) AS r FROM abos.${table} x ORDER BY ${order}`)).rows
          .map((row) => Object.fromEntries(Object.entries(row.r).filter(([key]) => common.get(table)!.includes(key))));
      }
      const labels = new Map<string, string>();
      const label = (value: string, kind: string) => {
        if (!labels.has(value)) labels.set(value, `<${kind}${labels.size + 1}>`);
        return labels.get(value) ?? "";
      };
      return JSON.stringify({ outcomes, tables }, null, 1)
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)/g, "<timestamp>")
        .replace(/[0-9A-F]{32}/g, (hex) => label(hex.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"), "id"))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => label(uuid, "id"))
        .replace(/\b[0-9a-f]{64}\b/g, (hash) => label(hash, "hash"));
    }

    test("expense and direct capital rows are identical before and after the kernel writer", async () => {
      await buildThrough(PREDECESSOR);
      const before = await projection(await scenario());
      await resetSchema(h.pool);
      const migrations = await loadMigrations();
      assert.ok(migrations.some((m) => m.id === MIGRATION), "0044 is registered");
      const after = await projection(await scenario());
      const posted = (await h.pool.query<{ source_type: string; n: number }>(
        "SELECT source_type, count(*)::int AS n FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE j.status = 'POSTED' GROUP BY 1 ORDER BY 1")).rows;
      assert.deepEqual(posted, [{ source_type: "DIRECT_SHAREHOLDER_CAPITAL", n: 5 }, { source_type: "OPERATIONAL_EXPENSE", n: 3 }],
        "the scenario really posted through both writers");
      assert.deepEqual(after.split("\n"), before.split("\n"));
    });

    test("the writers post only through the kernel, and nobody else may call it", async () => {
      await resetSchema(h.pool);
      for (const writer of ["abos.operational_expense_post(uuid,uuid)", "abos.direct_shareholder_receive(text,text,text,jsonb)"]) {
        const definition = (await h.pool.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [writer])).rows[0]?.d ?? "";
        assert.match(definition, /PERFORM abos\.posting_kernel_draft\(/, `${writer} drafts through the kernel`);
        assert.match(definition, /PERFORM abos\.posting_kernel_commit\(/, `${writer} posts through the kernel`);
        assert.doesNotMatch(definition, /INSERT INTO abos\.(posting_intents|journals|journal_lines|subledger_entries)\b/i, `${writer} writes no posting row itself`);
        assert.doesNotMatch(definition, /UPDATE abos\.(posting_intents|journals)\b/i, `${writer} posts nothing itself`);
      }
      const kernel = (await h.pool.query<{ d: string }>(
        "SELECT string_agg(pg_get_functiondef(p.oid), E'\\n') AS d FROM pg_proc p WHERE p.pronamespace = 'abos'::regnamespace AND p.proname LIKE 'posting_kernel_%'")).rows[0]?.d ?? "";
      assert.doesNotMatch(kernel, /\bEXECUTE\s+(format|'|\$|[a-z_]+\s*\|\|)/i, "no dynamic SQL in the kernel");
      const may = async (role: string, routine: string) => (await h.pool.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, routine])).rows[0]?.ok;
      const draft = "abos.posting_kernel_draft(uuid,uuid,uuid,text,uuid,numeric,text,numeric,text,date,uuid,text,uuid,text,text,uuid,abos.posting_kernel_line[],uuid,uuid,uuid,text,uuid,integer)";
      for (const routine of [draft, "abos.posting_kernel_commit(uuid,uuid,uuid)"]) {
        assert.equal(await may("abos_v1_operational_finance_owner", routine), true);
        for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime", "abos_e1_frozen_lane", "abos_v1_shareholder_setup_owner", "public"]) {
          if (role === "public") {
            const acl = (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = $1::regprocedure AND a.grantee = 0`, [routine])).rows[0]?.n;
            assert.equal(acl, 0, `${routine}: nothing through PUBLIC`);
          } else {
            assert.equal(await may(role, routine), false, `${role} cannot call ${routine}`);
          }
        }
      }
      // Even the owner's own session cannot use the kernel outside a writer: the kernel validates the
      // result, and an unregistered or inactive source is refused before anything is written.
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
        await assert.rejects(() => client.query(`SELECT abos.posting_kernel_draft(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'COUNT_DIFFERENCE', gen_random_uuid(), 1, 'USD', 1, 'USD', '2026-09-22', gen_random_uuid(), 'X', gen_random_uuid(), 'k', 'VALIDATED',
          gen_random_uuid(), ARRAY[]::abos.posting_kernel_line[])`), /posting source COUNT_DIFFERENCE is not active/);
      } finally { await client.query("ROLLBACK"); client.release(); }
    });
  });
}
