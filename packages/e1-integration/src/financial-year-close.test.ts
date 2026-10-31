import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { addSecondEntity, grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/**
 * Migration 0052 (owner correction of 2026-10-31): Al-Beruniy closes a financial year, never a month. The monthly
 * close / reopen of 0050 is retired; every lane opens the month covering its date; closing a financial year is stored on
 * the year (fiscal_years.closed_at), changes no month row, and the journal guard refuses every posting dated in it; a
 * reversal of a journal in a closed year posts on the business day.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Year = { id: string; status: string; label: string; postedJournals: number; closedBy: string | null; months: { id: string }[] };

function session(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0052 financial year close", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0052: financial year close replaces the monthly close / reopen", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_fy_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    async function fixture() {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const e = world.legalEntityId; const u = world.bootstrapUserId;
      await grant(h.executor, world, world.intentCreatorId, ["treasury.safe.read", "treasury.receipt.record", "treasury.payment.record",
        "finance.expense.create", "finance.expense.read", "finance.reversal.direct", "finance.report.operational.read"]);
      await grant(h.executor, world, world.treasuryApproverId, ["finance.period.manage"]);
      for (const workflow of ["OTHER_INCOME", "SUPPLIER_PAYMENT", "EXPENSE"]) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), e, workflow, u]);
      }
      const [{ today }] = (await h.pool.query<{ today: string }>("SELECT abos.business_today()::text AS today")).rows as [{ today: string }];
      // A past financial year (2025, two PENDING months) and the current month inside an active financial year.
      const past = randomUUID(); const november = randomUUID(); const december = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2025,'FY 2025','سال مالی ۲۰۲۵','2025-01-01','2025-12-31',$3)`, [past, e, u]);
      for (const [id, name, from, to, seq] of [[november, "November 2025", "2025-11-01", "2025-11-30", 11], [december, "December 2025", "2025-12-01", "2025-12-31", 12]] as const) {
        await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,fiscal_year_id,period_sequence,period_name_fa)
          VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7,$3)`, [id, e, name, from, to, past, seq]);
      }
      let current = (await h.pool.query<{ id: string }>("SELECT id FROM abos.accounting_periods WHERE legal_entity_id=$1 AND $2::date BETWEEN starts_on AND ends_on",
        [e, today])).rows[0]?.id;
      if (!current) {
        const fy = randomUUID(); current = randomUUID();
        await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
          VALUES($1,$2,'GREGORIAN',$3,'FY current','سال جاری',date_trunc('month',$4::date)::date,(date_trunc('month',$4::date)+interval '1 month'-interval '1 day')::date,$5)`,
        [fy, e, Number(today.slice(0, 4)), today, u]);
        await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,fiscal_year_id,period_sequence,period_name_fa)
          VALUES($1,$2,$3,date_trunc('month',$4::date)::date,(date_trunc('month',$4::date)+interval '1 month'-interval '1 day')::date,'PENDING',$5,1,'ماه جاری')`,
        [current, e, today.slice(0, 7), today, fy]);
      }
      const safe = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, e, world.cashLedgerAccountId, u]);
      const ledger = async (code: string, type: string) => {
        const id = randomUUID();
        await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
          VALUES ($1,$2,$3,$4,$5,NULL,true,'USD','ACTIVE')`, [id, e, code, `Synthetic ${code}`, type]);
        return id;
      };
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-FY','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, await ledger("SYN-FY-EXP", "EXPENSE"), u]);
      const s = async (user: string) => session((await issueOperationalSession(h, user, e)).token);
      return { world, e, today, past, november, december, current, safe, category, revenue: await ledger("SYN-FY-INC", "REVENUE"),
        payable: await ledger("SYN-FY-PAY", "LIABILITY"), creator: await s(world.intentCreatorId), manager: await s(world.treasuryApproverId) };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
      const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `fy-${randomUUID()}`, correlationId: randomUUID() });
    const receive = (f: Fixture, amount: string, date: string) => call<{ journalId: string }>("treasury_receipt_record", f.creator, {
      treasuryAccountId: f.safe, amount, currencyCode: "USD", businessDate: date, payerBusinessPartyId: null, payerName: "Synthetic payer",
      revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
    const pay = (f: Fixture, amount: string, date: string) => call<{ journalId: string }>("treasury_payment_record", f.creator, {
      treasuryAccountId: f.safe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable,
      amount, currencyCode: "USD", businessDate: date, reference: null, note: null, ...keys() });
    const expense = (f: Fixture, amount: string, date: string) => call<{ expense: { status: string; journalId: string } }>("operational_expense_create", f.creator, {
      treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null,
      reference: "FY-EXP", description: "Synthetic supplies", note: null, businessDate: date, originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys() });
    const statusOf = async (id: string) => (await h.pool.query<{ s: string }>("SELECT status AS s FROM abos.accounting_periods WHERE id = $1", [id])).rows[0]?.s;
    const closeYear = (f: Fixture, year = f.past, s = f.manager) => call<{ status: string; replayed: boolean }>(
      "finance_financial_year_close", s, { fiscalYearId: year, correlationId: randomUUID() });

    test("monthly close / reopen and the manual month opening are retired; the reopen permission and approval setting are withdrawn", async () => {
      const f = await fixture();
      for (const [fn, arg] of [["finance_period_close", { periodId: f.december, expectedVersion: 1 }], ["finance_period_reopen", { periodId: f.december, expectedVersion: 1, reason: "x" }],
        ["finance_period_reopen_request", { periodId: f.december, expectedVersion: 1, reason: "x" }], ["finance_period_reopen_decide", { requestId: randomUUID() }]] as const) {
        await assert.rejects(() => call(fn, f.manager, arg), /permission denied for function/, `${fn} is not callable`);
      }
      await assert.rejects(() => call("finance_periods_workspace", f.manager), /permission denied for function/);
      await assert.rejects(() => call("finance_period_close_preview", f.manager, f.december), /permission denied for function/);
      await assert.rejects(() => runtime.query("SELECT abos.finance_open_accounting_period($1,$2,$3,$4::uuid,1,'Synthetic open')",
        [f.manager.proof, f.manager.runtimeDigest, f.manager.tokenDigest, f.december]), /permission denied for function/);
      const retired = (await h.pool.query("SELECT retired_in_migration FROM abos.permission_retirements WHERE permission_code = 'finance.period.reopen'")).rows[0];
      assert.equal(retired?.retired_in_migration, "0052_v1_financial_year_close");
      assert.equal((await h.pool.query("SELECT abos.finance_workflow_approval_available('PERIOD_REOPEN') AS a")).rows[0]?.a, false);
      assert.equal((await h.pool.query("SELECT abos.finance_workflow_approval_available('JOURNAL_REVERSAL') AS a")).rows[0]?.a, true, "reversal approval stays");
    });

    test("every lane opens the month covering its date: an expense in a PENDING month posts without anyone opening it", async () => {
      const f = await fixture();
      assert.equal(await statusOf(f.november), "PENDING");
      await receive(f, "500.00", "2025-11-05");
      assert.equal(await statusOf(f.december), "PENDING");
      // The expense lane itself opens December (before 0052 it required someone to open the month by hand).
      const spent = await expense(f, "40.00", "2025-12-20");
      assert.equal(spent.expense.status, "POSTED");
      assert.deepEqual([await statusOf(f.november), await statusOf(f.december)], ["OPEN", "OPEN"], "the receipt opened November and the expense opened December");
      const options = await call<{ period: { id: string } | null }>("operational_expense_entry_options", f.creator, f.today);
      assert.ok(options.period !== null, "the entry options see the current month even before it opens");
    });

    test("closing a financial year: preview, then the year itself is closed (no month row changes); postings dated in it are refused", async () => {
      const f = await fixture();
      const receipt = await receive(f, "500.00", "2025-12-05");
      const before = (await h.pool.query("SELECT to_jsonb(j) AS r FROM abos.journals j WHERE id = $1", [receipt.journalId])).rows[0]?.r;
      const months = async () => (await h.pool.query("SELECT jsonb_agg(to_jsonb(p) ORDER BY starts_on) AS m FROM abos.accounting_periods p WHERE fiscal_year_id = $1",
        [f.past])).rows[0]?.m;
      const workspace = await call<{ canClose: boolean; years: Year[] }>("finance_financial_years_workspace", f.manager);
      const year = workspace.years.find((y) => y.id === f.past);
      assert.deepEqual([workspace.canClose, year?.status, year?.postedJournals, year?.months.length], [true, "ACTIVE", 1, 2]);
      const preview = await call<{ summary: { postedJournals: number; debits: string; credits: string }; unpostedJournals: number; warnings: string[] }>(
        "finance_financial_year_close_preview", f.manager, f.past);
      assert.deepEqual([preview.summary.postedJournals, preview.summary.debits, preview.summary.credits, preview.unpostedJournals, preview.warnings],
        [1, "500.00", "500.00", 0, []]);
      // 0054: a year that has not ended, with an earlier year still active, previews with both warnings (0052 failed here).
      const currentYear = (await h.pool.query<{ y: string }>("SELECT fiscal_year_id AS y FROM abos.accounting_periods WHERE id = $1", [f.current])).rows[0]?.y;
      const early = await call<{ warnings: string[] }>("finance_financial_year_close_preview", f.manager, currentYear);
      assert.deepEqual(early.warnings, ["YEAR_NOT_ENDED", "EARLIER_YEAR_ACTIVE"]);
      await assert.rejects(() => closeYear(f, f.past, f.creator), /finance\.period\.manage/);
      const monthsBefore = await months();
      const closed = await closeYear(f);
      assert.deepEqual([closed.status, closed.replayed], ["CLOSED", false]);
      // The close is stored on the financial year; the month rows are not touched (November PENDING, December OPEN).
      assert.deepEqual(await months(), monthsBefore, "closing the year changes no month row");
      assert.deepEqual([await statusOf(f.november), await statusOf(f.december)], ["PENDING", "OPEN"]);
      const stored = (await h.pool.query(`SELECT closed_at IS NOT NULL AS c, closed_by_user_account_id AS by, close_correlation_id IS NOT NULL AS k
        FROM abos.fiscal_years WHERE id = $1`, [f.past])).rows[0];
      assert.deepEqual(stored, { c: true, by: f.world.treasuryApproverId, k: true });
      const shownYear = (await call<{ years: Year[] }>("finance_financial_years_workspace", f.manager)).years.find((y) => y.id === f.past);
      assert.deepEqual([shownYear?.status, typeof shownYear?.closedBy], ["CLOSED", "string"]);
      assert.equal((await closeYear(f)).replayed, true, "closing twice is a replay");
      assert.deepEqual((await h.pool.query("SELECT to_jsonb(j) AS r FROM abos.journals j WHERE id = $1", [receipt.journalId])).rows[0]?.r, before, "closing changes no journal");
      // Refusal derives from the year: December's month row is OPEN, yet nothing posts into it.
      await assert.rejects(() => receive(f, "1.00", "2025-12-20"), /financial year covering 2025-12-20 is closed/);
      await assert.rejects(() => expense(f, "1.00", "2025-11-20"), /financial year covering 2025-11-20 is closed/);
      assert.equal(await statusOf(f.november), "PENDING", "a refused posting opens nothing");
      await receive(f, "1.00", f.today);
      assert.equal(await statusOf(f.current), "OPEN", "the active year keeps working");
      const audit = (await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action = 'FINANCIAL_YEAR_CLOSED' AND entity_id = $1", [f.past])).rows[0]?.n;
      const events = (await h.pool.query("SELECT count(*)::int AS n FROM abos.accounting_period_events")).rows[0]?.n;
      assert.deepEqual([audit, events], [1, 0], "one year-level audit record; no month event");
      // Nothing reopens the year: no runtime path exists, posting never reopens it, and the year row itself refuses.
      await assert.rejects(() => h.pool.query("SELECT abos.open_period_for_business_date($1, $2, '2025-12-01')", [f.e, f.world.bootstrapUserId]),
        /financial year covering 2025-12-01 is closed/);
      await assert.rejects(() => h.pool.query(`UPDATE abos.fiscal_years SET closed_at = NULL, closed_by_user_account_id = NULL, close_correlation_id = NULL
        WHERE id = $1`, [f.past]), /never changed or reopened/);
      await assert.rejects(() => h.pool.query("DELETE FROM abos.fiscal_years WHERE id = $1", [f.past]), /append-only/);
      const active = (await h.pool.query<{ id: string }>("SELECT id FROM abos.fiscal_years WHERE legal_entity_id = $1 AND closed_at IS NULL LIMIT 1", [f.e])).rows[0]?.id;
      await assert.rejects(() => h.pool.query("UPDATE abos.fiscal_years SET label_en = 'Renamed' WHERE id = $1", [active]), /only closing a financial year/);
      // Another company cannot see or close this year.
      const other = await addSecondEntity(h.executor, f.world, ["finance.period.manage"]);
      const outsider = session(other.token);
      await assert.rejects(() => call("finance_financial_year_close", outsider, { fiscalYearId: f.past }), /not found in this legal entity|sign in|operational/);
    });

    test("the journal guard refuses any journal dated in a closed year, and serialises with a concurrent close", async () => {
      const f = await fixture();
      const receipt = await receive(f, "500.00", "2025-12-05");
      // A journal written past every lane (a direct copy of a real one) is still refused once the year is closed. Only the
      // processing-model boundary is lifted, inside the attempt's own transaction, which is rolled back whatever happens.
      const copy = async (client: pg.PoolClient, source: string, date: string) => {
        const row = (await h.pool.query(`SELECT to_jsonb(j) || jsonb_build_object('id', gen_random_uuid(), 'status', 'DRAFT',
            'journal_reference', 'SYN-GUARD-' || gen_random_uuid(), 'accounting_effective_date', $2::date) AS r
          FROM abos.journals j WHERE j.id = $1`, [source, date])).rows[0]?.r;
        await client.query("ALTER TABLE abos.journals DISABLE TRIGGER aa_journals_processing_model_guard");
        return client.query("INSERT INTO abos.journals SELECT (jsonb_populate_record(NULL::abos.journals, $1::jsonb)).*", [row])
          .then(() => "posted", (error: Error) => error.message);
      };
      const closer = await h.pool.connect(); const poster = await h.pool.connect();
      try {
        // Before the close, the same copy passes the year guard (it stops later, at the one-journal-per-intent key).
        await poster.query("BEGIN");
        const open = await copy(poster, receipt.journalId, "2025-12-21");
        assert.doesNotMatch(open, /financial year/);
        assert.match(open, /journals_posting_intent_id_key/);
        await poster.query("ROLLBACK");
        // READ COMMITTED: a posting that meets a close in progress waits for it, then sees the closed year.
        await closer.query("BEGIN");
        await closer.query(`UPDATE abos.fiscal_years SET closed_at = clock_timestamp(), closed_by_user_account_id = $2,
          close_correlation_id = gen_random_uuid() WHERE id = $1`, [f.past, f.world.treasuryApproverId]);
        await poster.query("BEGIN");
        const waiting = copy(poster, receipt.journalId, "2025-12-21");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await closer.query("COMMIT");
        assert.match(await waiting, /financial year covering 2025-12-21 is closed/);
        await poster.query("ROLLBACK");
        await poster.query("BEGIN");
        assert.match(await copy(poster, receipt.journalId, "2025-11-03"), /financial year covering 2025-11-03 is closed/);
      } finally {
        await closer.query("ROLLBACK"); await poster.query("ROLLBACK");
        closer.release(); poster.release();
      }
      // REPEATABLE READ: a snapshot taken before the close cannot post into the year after it.
      const g = await fixture();
      const early = await receive(g, "500.00", "2025-12-05");
      const rr = await h.pool.connect();
      try {
        await rr.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await rr.query("SELECT count(*) FROM abos.fiscal_years");
        await closeYear(g);
        assert.match(await copy(rr, early.journalId, "2025-12-22"), /could not serialize access|financial year covering 2025-12-22 is closed/);
      } finally { await rr.query("ROLLBACK"); rr.release(); }
    });

    test("every operational writer (USD and AFN) reaches the journal-level guard: with the lanes' own year check switched off, the guard alone refuses", async () => {
      const f = await fixture();
      const u = f.world.bootstrapUserId;
      await grant(h.executor, f.world, f.world.intentCreatorId, ["treasury.transfer.record", "treasury.opening-balance.record",
        "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
        "finance.capital-receipt.prepare", "finance.capital-receipt.post"]);
      for (const workflow of ["TREASURY_TRANSFER", "SHAREHOLDER_CAPITAL_RECEIPT"]) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), f.e, workflow, u]);
      }
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-FY-OBE','Synthetic opening balance equity','EQUITY','OPENING_BALANCE_EQUITY',true,'USD','ACTIVE')`, [randomUUID(), f.e]);
      const newSafe = async () => {
        const id = randomUUID(); const cash = randomUUID(); const code = `SYN-FY-${id.slice(0, 8)}`;
        await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
          VALUES ($1,$2,$3,'Synthetic extra cash','ASSET','CASH',true,'USD','ACTIVE')`, [cash, f.e, code]);
        await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
          status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,'SAFE','USD',$4,'ACTIVE',1,$5,$5)`,
        [id, f.e, `Synthetic Safe ${code}`, cash, u]);
        return id;
      };
      const second = await newSafe();
      // AFN: an AFN cash ledger and Safe, and the day's market rate (the default FX policy applies).
      const afnCash = randomUUID(); const afnSafe = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-FY-AFN','Synthetic AFN cash','ASSET','CASH',true,'AFN','ACTIVE')`, [afnCash, f.e]);
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic AFN Safe','SAFE','AFN',$3,'ACTIVE',1,$4,$4)`,
      [afnSafe, f.e, afnCash, u]);
      await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,saraf_business_party_id,unit_currency_code,quote_currency_code,
        rate_value,note,entered_by_user_account_id) VALUES ($1,$2,'2025-12-10','MARKET',NULL,'USD','AFN','70','Synthetic rate',$3)`, [randomUUID(), f.e, u]);
      const actor = session((await issueOperationalSession(h, f.world.intentCreatorId, f.e)).token);
      const day = "2025-12-10";
      const writers: Record<string, () => Promise<unknown>> = {
        receipt: () => call("treasury_receipt_record", actor, { treasuryAccountId: f.safe, amount: "5.00", currencyCode: "USD", businessDate: day,
          payerBusinessPartyId: null, payerName: "Synthetic payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() }),
        afnReceipt: () => call("treasury_receipt_record", actor, { treasuryAccountId: afnSafe, amount: "700.00", currencyCode: "AFN", businessDate: day,
          payerBusinessPartyId: null, payerName: "Synthetic AFN payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() }),
        afnPayment: () => call("treasury_payment_record", actor, { treasuryAccountId: afnSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null,
          payeeName: "Synthetic AFN supplier", payableLedgerAccountId: f.payable, amount: "70.00", currencyCode: "AFN", businessDate: day, reference: null, note: null, ...keys() }),
        payment: () => call("treasury_payment_record", actor, { treasuryAccountId: f.safe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null,
          payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable, amount: "5.00", currencyCode: "USD", businessDate: day, reference: null, note: null, ...keys() }),
        transfer: () => call("treasury_transfer_record", actor, { sourceTreasuryAccountId: f.safe, destinationTreasuryAccountId: second, amount: "5.00",
          currencyCode: "USD", businessDate: day, reference: null, note: null, ...keys() }),
        expense: () => call("operational_expense_create", actor, { treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null,
          projectId: null, departmentId: null, costCenterId: null, reference: "FY-GUARD", description: "Synthetic supplies", note: null, businessDate: day,
          originalAmount: "5.00", currencyCode: "USD", exchangeRateId: null, ...keys() }),
        openingBalance: async () => call("treasury_opening_balance_record", actor, { treasuryAccountId: await newSafe(), amount: "5.00", currencyCode: "USD",
          asOfDate: day, reference: null, note: null, ...keys() }),
        capital: async () => {
          const added = await call<{ shareholderProfileId: string }>("direct_shareholder_add", actor, { displayName: `Synthetic Holder ${randomUUID()}`,
            agreedTotal: null, currencyCode: "USD", externalReference: null, note: null, businessDate: day, firstContribution: null, ...keys() });
          return call("direct_shareholder_receive", actor, { shareholderProfileId: added.shareholderProfileId, fundingMethod: "CASH", amount: "5.00",
            currencyCode: "USD", receiptDate: day, destinationAccountId: f.safe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
            paymentReference: "FY-GUARD-CAP", note: null, ...keys() });
        }
      };
      // While the year is active every writer posts (this also proves each payload is valid).
      await receive(f, "500.00", day);
      for (const [name, write] of Object.entries(writers)) await assert.doesNotReject(write, `${name} posts in an active year`);
      const payment = await pay(f, "5.00", day);
      const journals = async () => (await h.pool.query("SELECT count(*)::int AS n, md5(string_agg(to_jsonb(j)::text, '' ORDER BY id)) AS h FROM abos.journals j")).rows[0];
      await closeYear(f);
      const before = await journals();
      // Switch off the shared lane-level year check on this disposable database: only the journal guard can refuse now.
      await h.pool.query(`CREATE OR REPLACE FUNCTION abos.financial_year_closed_on(p_entity uuid, p_date date) RETURNS boolean
        LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $neutral$ SELECT false $neutral$`);
      for (const [name, write] of Object.entries({ ...writers,
        reversal: () => call("finance_journal_reversal_direct", actor, { journalId: payment.journalId, reason: "Synthetic guard proof", ...keys() }) })) {
        await assert.rejects(write, /financial year covering 2025-12-10 is closed; nothing can be posted into it/, `${name} is refused by the journal guard`);
      }
      assert.deepEqual(await journals(), before, "no journal entered the closed year and no existing journal changed");
    });

    test("a reversal of a journal in a closed financial year posts on the business day in the active year; the closed year stays closed", async () => {
      const f = await fixture();
      await receive(f, "500.00", "2025-12-05");
      const payment = await pay(f, "70.00", "2025-12-06");
      await closeYear(f);
      const reversal = await call<{ effectiveDate: string; postedInOriginalPeriod: boolean; reversalJournalId: string }>("finance_journal_reversal_direct", f.creator,
        { journalId: payment.journalId, reason: "Synthetic supplier refund after year end", ...keys() });
      assert.deepEqual([reversal.effectiveDate, reversal.postedInOriginalPeriod], [f.today, false]);
      assert.equal(await statusOf(f.december), "OPEN", "the decision came from the closed year, not from the month row");
      const shown = await call<{ journals: { id: string; periodStatus: string }[] }>("finance_journal_reversal_workspace", f.creator);
      assert.equal(shown.journals.find((j) => j.id === payment.journalId)?.periodStatus, "CLOSED", "the reversal screen reports the closed year");
      const link = (await h.pool.query("SELECT original_journal_id AS o FROM abos.journal_reversal_links WHERE reversal_journal_id = $1", [reversal.reversalJournalId])).rows[0];
      assert.equal(link?.o, payment.journalId);
      // While the year is active the reversal keeps the original date.
      const g = await fixture();
      await receive(g, "500.00", "2025-12-05");
      const early = await pay(g, "70.00", "2025-12-06");
      const kept = await call<{ effectiveDate: string; postedInOriginalPeriod: boolean }>("finance_journal_reversal_direct", g.creator,
        { journalId: early.journalId, reason: "Synthetic duplicate supplier payment", ...keys() });
      assert.deepEqual([kept.effectiveDate, kept.postedInOriginalPeriod], ["2025-12-06", true]);
    });
  });
}
