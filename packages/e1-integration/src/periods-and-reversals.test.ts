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
 * Migration 0050 (Slice 5): REVERSAL posting through the one kernel. Simple Mode reverses directly; Advanced
 * Mode needs a second person. A reversal is an exact inverse linked immutably to its original, on the original
 * date while that date's financial year is open and otherwise on the business day. The original journal never
 * changes. The monthly close / reopen of 0050 is retired by 0052 (financial-year-close.test.ts covers the year
 * close and a reversal after it).
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Fixture = { world: SyntheticWorld; entity: string; today: string; currentPeriod: string; september: string;
  creator: Session; reverser: Session; requester: Session; approver: Session; manager: Session;
  safe: string; revenue: string; payable: string; category: string };
type Posted = { reversalJournalId: string; reference: string; effectiveDate: string; postedInOriginalPeriod: boolean; replayed: boolean };

function session(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0050 periods and reversals", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0050: period close / reopen and reversal posting", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_slice5_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 6 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    const ledger = async (entity: string, code: string, type: string, control: string | null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,'USD','ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control]);
      return id;
    };
    const policy = async (world: SyntheticWorld, workflow: string, approval: boolean) => {
      const version = Number((await h.pool.query("SELECT COALESCE(max(version),0)+1 AS v FROM abos.finance_workflow_policy_versions WHERE legal_entity_id=$1 AND workflow_type=$2",
        [world.legalEntityId, workflow])).rows[0]?.v);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,'Synthetic explicit setting')`, [randomUUID(), world.legalEntityId, workflow, version, approval, world.bootstrapUserId]);
    };

    async function fixture(): Promise<Fixture> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const e = world.legalEntityId;
      await grant(h.executor, world, world.intentCreatorId, ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record",
        "treasury.payment.record", "finance.expense.create", "finance.expense.read", "finance.report.operational.read",
        "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
        "finance.capital-receipt.prepare", "finance.capital-receipt.post"]);
      await grant(h.executor, world, world.reverserId, ["finance.reversal.direct", "finance.period.manage",
        "finance.report.operational.read", "finance.expense.read"]);
      await grant(h.executor, world, world.treasuryManagerId, ["finance.reversal.request"]);
      await grant(h.executor, world, world.approverId, ["finance.reversal.approve", "finance.expense.approve", "finance.expense.read"]);
      await grant(h.executor, world, world.treasuryApproverId, ["finance.period.manage"]);
      const [{ today }] = (await h.pool.query<{ today: string }>("SELECT abos.business_today()::text AS today")).rows as [{ today: string }];
      // The current month exists PENDING inside a financial year, so a posting may open it (unless it is September).
      let currentPeriod = (await h.pool.query<{ id: string }>("SELECT id FROM abos.accounting_periods WHERE legal_entity_id=$1 AND $2::date BETWEEN starts_on AND ends_on",
        [e, today])).rows[0]?.id;
      if (!currentPeriod) {
        const fy = randomUUID(); currentPeriod = randomUUID();
        await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
          VALUES($1,$2,'GREGORIAN',$3,'FY current','سال جاری',date_trunc('month',$4::date)::date,(date_trunc('month',$4::date)+interval '1 month'-interval '1 day')::date,$5)`,
        [fy, e, Number(today.slice(0, 4)), today, world.bootstrapUserId]);
        await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,fiscal_year_id,period_sequence,period_name_fa)
          VALUES($1,$2,$3,date_trunc('month',$4::date)::date,(date_trunc('month',$4::date)+interval '1 month'-interval '1 day')::date,'PENDING',$5,1,'ماه جاری')`,
        [currentPeriod, e, today.slice(0, 7), today, fy]);
      }
      const safe = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,'Synthetic Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, e, world.cashLedgerAccountId, world.bootstrapUserId]);
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-S5','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, await ledger(e, "SYN-S5-EXP", "EXPENSE", null), world.bootstrapUserId]);
      await policy(world, "SHAREHOLDER_CAPITAL_RECEIPT", false);
      const s = async (user: string) => session((await issueOperationalSession(h, user, e)).token);
      return { world, entity: e, today, currentPeriod, september: world.accountingPeriodId, safe, category,
        revenue: await ledger(e, "SYN-S5-INC", "REVENUE", null), payable: await ledger(e, "SYN-S5-PAY", "LIABILITY", null),
        creator: await s(world.intentCreatorId), reverser: await s(world.reverserId), requester: await s(world.treasuryManagerId),
        approver: await s(world.approverId), manager: await s(world.treasuryApproverId) };
    }
    async function call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
      const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `s5-${randomUUID()}`, correlationId: randomUUID() });
    const receive = (f: Fixture, amount: string, date = "2026-09-10") => call<{ journalId: string }>("treasury_receipt_record", f.creator, {
      treasuryAccountId: f.safe, amount, currencyCode: "USD", businessDate: date, payerBusinessPartyId: null, payerName: "Synthetic payer",
      revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
    const pay = (f: Fixture, amount: string, date = "2026-09-12") => call<{ journalId: string }>("treasury_payment_record", f.creator, {
      treasuryAccountId: f.safe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable,
      amount, currencyCode: "USD", businessDate: date, reference: null, note: null, ...keys() });
    const reverse = (f: Fixture, journalId: string, s = f.reverser, extra: object = {}) => call<Posted>("finance_journal_reversal_direct", s,
      { journalId, reason: "Synthetic correction of a mistaken entry", ...keys(), ...extra });
    const book = async (f: Fixture) => (await h.pool.query<{ b: string }>("SELECT book_balance::text AS b FROM abos.treasury_account_balances($1,NULL,$2)", [f.entity, f.safe])).rows[0]?.b;
    const linesOf = async (journal: string) => (await h.pool.query(`SELECT l.line_number AS n, l.ledger_account_id AS ledger, l.base_debit::text AS dr, l.base_credit::text AS cr,
        l.business_party_id AS party, e.subledger_type AS sub, e.operational_treasury_account_id AS safe, e.original_amount::text AS amount
      FROM abos.journal_lines l LEFT JOIN abos.subledger_entries e ON e.journal_line_id = l.id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const journalRow = async (journal: string) => (await h.pool.query("SELECT to_jsonb(j) AS r FROM abos.journals j WHERE id = $1", [journal])).rows[0]?.r;

    test("a direct reversal posts the exact inverse, restores the Safe, keeps the original and links them immutably", async () => {
      const f = await fixture();
      await receive(f, "500.00");
      const payment = await pay(f, "120.00");
      assert.equal(await book(f), "380.00");
      const original = await journalRow(payment.journalId);
      const originalLines = await linesOf(payment.journalId);
      await assert.rejects(() => reverse(f, payment.journalId, f.creator), /finance\.reversal\.direct/, "the poster lacks direct reversal");
      const request = keys();
      const posted = await reverse(f, payment.journalId, f.reverser, request);
      assert.deepEqual([posted.effectiveDate, posted.postedInOriginalPeriod], ["2026-09-12", true]);
      assert.match(posted.reference, /^RV-20260912-[0-9A-F]{32}$/);
      assert.equal(await book(f), "500.00", "the Safe is restored");
      const inverted = await linesOf(posted.reversalJournalId);
      assert.deepEqual(inverted, originalLines.map((l) => ({ ...l, dr: l.cr, cr: l.dr, amount: l.amount === null ? null : (-Number(l.amount)).toFixed(2) })));
      assert.deepEqual(await journalRow(payment.journalId), original, "the original journal never changes");
      const replay = await reverse(f, payment.journalId, f.reverser, request);
      assert.equal(replay.replayed, true); assert.equal(replay.reversalJournalId, posted.reversalJournalId);
      await assert.rejects(() => reverse(f, payment.journalId), /already been reversed/);
      await assert.rejects(() => reverse(f, posted.reversalJournalId), /itself a reversal|cannot be reversed/);
      await assert.rejects(() => h.pool.query("UPDATE abos.journal_reversal_links SET reason = 'changed' WHERE original_journal_id = $1", [payment.journalId]));
      const audit = (await h.pool.query("SELECT action FROM abos.audit_records WHERE entity_id = $1", [posted.reversalJournalId])).rows.map((r) => r.action);
      assert.deepEqual(audit, ["JOURNAL_REVERSAL_POSTED"]);
      const evidence = (await h.pool.query(`SELECT e.evidence_kind AS kind FROM abos.journal_reversal_links l JOIN abos.evidence_references e ON e.id = l.evidence_reference_id
        WHERE l.original_journal_id = $1`, [payment.journalId])).rows;
      assert.deepEqual(evidence, [{ kind: "REVERSAL_REASON" }]);
    });

    test("reversing shareholder capital restores the shareholder balance and the capital workspace", async () => {
      const f = await fixture();
      const added = await call<{ shareholderProfileId: string }>("direct_shareholder_add", f.creator, { displayName: "Synthetic Reversal Holder",
        agreedTotal: null, currencyCode: "USD", externalReference: null, note: null, businessDate: "2026-09-05", firstContribution: null, ...keys() });
      const receipt = await call<{ journalId: string }>("direct_shareholder_receive", f.creator, { shareholderProfileId: added.shareholderProfileId,
        fundingMethod: "CASH", amount: "700.00", currencyCode: "USD", receiptDate: "2026-09-06", destinationAccountId: f.safe, providerName: null,
        itemDescription: null, expenseLedgerAccountId: null, paymentReference: "S5-CAP-1", note: null, ...keys() });
      const capital = async () => (await h.pool.query("SELECT COALESCE(sum(capital_posted), 0)::text AS c FROM abos.shareholder_capital_balances($1)", [f.entity])).rows[0]?.c;
      assert.equal(await capital(), "700.00");
      await reverse(f, receipt.journalId);
      assert.equal(await capital(), "0.00", "shareholder capital is restored");
      assert.equal(await book(f), "0.00", "the Safe gives the money back");
      const workspace = await call<{ shareholders: { capitals: { contributed: string }[]; transactions: { status: string }[] }[] }>(
        "direct_shareholder_capital_workspace", f.creator);
      const holder = workspace.shareholders[0];
      assert.deepEqual([holder?.capitals.map((c) => c.contributed), holder?.transactions.map((t) => t.status)], [[], ["REVERSED"]]);
    });

    test("Advanced Mode: request, independent approval, and the same writer posts; direct is refused; participants cannot", async () => {
      const f = await fixture();
      await policy(f.world, "JOURNAL_REVERSAL", true);
      await receive(f, "300.00");
      const payment = await pay(f, "50.00");
      await assert.rejects(() => reverse(f, payment.journalId), /requires an approved request/);
      const asked = await call<{ requestId: string }>("finance_journal_reversal_request", f.requester, { journalId: payment.journalId,
        reason: "Synthetic duplicate supplier payment" });
      await assert.rejects(() => call("finance_journal_reversal_decide", f.requester, { requestId: asked.requestId, expectedVersion: 1, decision: "APPROVED" }),
        /finance\.reversal\.approve/);
      const decided = await call<Posted & { status: string }>("finance_journal_reversal_decide", f.approver,
        { requestId: asked.requestId, expectedVersion: 1, decision: "APPROVED" });
      assert.equal(decided.status, "APPROVED"); assert.ok(decided.reversalJournalId);
      assert.equal(await book(f), "300.00");
      const link = (await h.pool.query("SELECT approved_by_user_account_id AS a FROM abos.journal_reversal_links WHERE original_journal_id = $1", [payment.journalId])).rows[0];
      assert.equal(link?.a, f.world.approverId);
      const again = await call<{ replayed: boolean }>("finance_journal_reversal_decide", f.approver, { requestId: asked.requestId, expectedVersion: 1, decision: "APPROVED" });
      assert.equal(again.replayed, true);
      const second = await pay(f, "10.00");
      await assert.rejects(() => call("finance_journal_reversal_request", f.creator, { journalId: second.journalId, reason: "Synthetic own correction" }),
        /finance\.reversal\.request|cannot request/);
    });

    test("two people reversing the same journal at once: exactly one reversal", async () => {
      const f = await fixture();
      await grant(h.executor, f.world, f.world.treasuryApproverId, ["finance.reversal.direct"]);
      const second = session((await issueOperationalSession(h, f.world.treasuryApproverId, f.entity)).token);
      await receive(f, "200.00");
      const payment = await pay(f, "60.00");
      const results = await Promise.allSettled([reverse(f, payment.journalId, f.reverser), reverse(f, payment.journalId, second)]);
      const outcomes = results.map((r) => r.status === "fulfilled" ? "ok" : /already been reversed/.test(String((r.reason as Error).message)) ? "already" : `other: ${(r.reason as Error).message}`);
      assert.deepEqual(outcomes.sort(), ["already", "ok"]);
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.journal_reversal_links WHERE original_journal_id = $1", [payment.journalId])).rows[0]?.count), 1);
      assert.equal(await book(f), "200.00");
    });

    test("reversing a receipt cannot take a Safe below zero; the Daily Report and the expense show reversals", async () => {
      const f = await fixture();
      const receipt = await receive(f, "100.00");
      await pay(f, "90.00");
      await assert.rejects(() => reverse(f, receipt.journalId), /not enough money/, "the 0049 guard holds for reversals");
      const expense = await call<{ expense: { id: string; journalId: string } }>("operational_expense_create", f.creator, { treasuryAccountId: f.safe,
        expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "S5-EXP",
        description: "Synthetic reversed expense", note: null, businessDate: "2026-09-12", originalAmount: "4.00", currencyCode: "USD", exchangeRateId: null, ...keys() });
      const report = async (date: string) => call<{ baseTotal: { amount: string } }>("operational_finance_daily_report", f.reverser, date);
      assert.equal((await report("2026-09-12")).baseTotal.amount, "4.00");
      await reverse(f, expense.expense.journalId);
      assert.equal((await report("2026-09-12")).baseTotal.amount, "0.00", "reversed on the same open day: the day nets to zero");
      const listed = await call<{ expenses: { id: string; reversal?: { journalId: string; reason: string } }[] }>("operational_expense_workspace",
        f.creator, "2026-09-01", "2026-09-30");
      const shown = listed.expenses.find((item) => item.id === expense.expense.id);
      assert.equal(shown?.reversal?.reason, "Synthetic correction of a mistaken entry", "the expense shows its reversal");
    });

    test("Simple Mode self-correction: the poster with finance.reversal.direct reverses their own entry, flagged and audited", async () => {
      const f = await fixture();
      await grant(h.executor, f.world, f.world.intentCreatorId, ["finance.reversal.direct"]);
      await receive(f, "300.00");
      const own = await pay(f, "40.00");
      const posted = await reverse(f, own.journalId, f.creator);
      assert.equal((posted as Posted & { selfReversal: boolean }).selfReversal, true);
      assert.equal(await book(f), "300.00");
      const link = (await h.pool.query("SELECT reversal_mode AS m, self_reversal AS s, approved_by_user_account_id AS a FROM abos.journal_reversal_links WHERE original_journal_id = $1",
        [own.journalId])).rows[0];
      assert.deepEqual(link, { m: "DIRECT", s: true, a: f.world.intentCreatorId });
      const audit = (await h.pool.query("SELECT after_state->>'selfReversal' AS s, after_state->>'mode' AS m FROM abos.audit_records WHERE entity_id = $1 AND action = 'JOURNAL_REVERSAL_POSTED'",
        [posted.reversalJournalId])).rows[0];
      assert.deepEqual(audit, { s: "true", m: "DIRECT" });
      await assert.rejects(() => reverse(f, own.journalId, f.creator), /already been reversed/, "still exactly one reversal");
      const other = await pay(f, "10.00");
      await reverse(f, other.journalId, f.reverser);
      assert.equal((await h.pool.query("SELECT self_reversal AS s FROM abos.journal_reversal_links WHERE original_journal_id = $1", [other.journalId])).rows[0]?.s, false);
      // Advanced Mode: no self-approval and no direct path; the database refuses a forged direct link too.
      await policy(f.world, "JOURNAL_REVERSAL", true);
      const third = await pay(f, "5.00");
      await assert.rejects(() => reverse(f, third.journalId, f.creator), /requires an approved request/);
      await assert.rejects(() => call("finance_journal_reversal_request", f.creator, { journalId: third.journalId, reason: "Synthetic own correction request" }),
        /finance\.reversal\.request|cannot request/);
      await assert.rejects(() => h.pool.query(`INSERT INTO abos.journal_reversal_links (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id,
          evidence_reference_id, reversal_mode, self_reversal) SELECT $1, reversal_journal_id, 'forged', $2, evidence_reference_id, 'DIRECT', true
          FROM abos.journal_reversal_links WHERE original_journal_id = $3`, [third.journalId, f.world.intentCreatorId, own.journalId]),
        /not available while reversals require approval|duplicate key|reversal link requires|REVERSAL intent/);
    });

    test("a fully reversed opening balance shows an effective opening of 0, a book of 0, and keeps both entries in the history", async () => {
      const f = await fixture();
      await ledger(f.entity, "SYN-S5-OBE", "EQUITY", "OPENING_BALANCE_EQUITY");
      await grant(h.executor, f.world, f.world.intentCreatorId, ["treasury.opening-balance.record"]);
      const opening = await call<{ journalId: string; reference: string }>("treasury_opening_balance_record", f.creator, { treasuryAccountId: f.safe,
        amount: "2500.00", currencyCode: "USD", asOfDate: "2026-09-01", reference: "Counted on day one", note: null, ...keys() });
      const figures = async () => (await h.pool.query(`SELECT opening_balance::text AS o, inflows::text AS i, outflows::text AS x, book_balance::text AS b
        FROM abos.treasury_account_balances($1, NULL, $2)`, [f.entity, f.safe])).rows[0];
      assert.deepEqual(await figures(), { o: "2500.00", i: "0", x: "0", b: "2500.00" });
      const reversal = await reverse(f, opening.journalId);
      assert.deepEqual(await figures(), { o: "0.00", i: "0", x: "0", b: "0.00" }, "effective opening 0, book 0, nothing counted as money in or out");
      const safes = await call<{ safes: { id: string; balance: { opening: string; book: string };
        openingBalance: { amount: string; asOfDate: string; reference: string | null; journalId: string; reversal?: { journalId: string; date: string; reason: string } } | null;
        movements: { journalId: string; sourceType: string; direction: string; amount: string }[] }[] }>("treasury_safes_workspace", f.creator);
      const safe = safes.safes.find((s) => s.id === f.safe);
      assert.deepEqual([safe?.balance.opening, safe?.balance.book], ["0.00", "0.00"]);
      assert.deepEqual([safe?.openingBalance?.amount, safe?.openingBalance?.asOfDate, safe?.openingBalance?.reference, safe?.openingBalance?.journalId],
        ["2500.00", "2026-09-01", "Counted on day one", opening.journalId], "the original opening balance is kept");
      assert.deepEqual([safe?.openingBalance?.reversal?.journalId, safe?.openingBalance?.reversal?.reason],
        [reversal.reversalJournalId, "Synthetic correction of a mistaken entry"], "with its reversal");
      assert.deepEqual(safe?.movements.map((m) => [m.journalId, m.sourceType, m.direction, m.amount]).sort(),
        [[opening.journalId, "OPENING_BALANCE", "IN", "2500.00"], [reversal.reversalJournalId, "REVERSAL", "OUT", "2500.00"]].sort(), "both stay in the history");
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.treasury_opening_balances WHERE journal_id = $1", [opening.journalId])).rows[0]?.count), 1,
        "the original record is neither deleted nor changed");
    });

    test("a reversed opening balance can be recorded again; privileges stay narrow", async () => {
      const f = await fixture();
      await ledger(f.entity, "SYN-S5-OBE", "EQUITY", "OPENING_BALANCE_EQUITY");
      await grant(h.executor, f.world, f.world.intentCreatorId, ["treasury.opening-balance.record"]);
      const opening = (amount: string) => call<{ journalId: string }>("treasury_opening_balance_record", f.creator, { treasuryAccountId: f.safe,
        amount, currencyCode: "USD", asOfDate: "2026-09-01", reference: null, note: null, ...keys() });
      const first = await opening("1000.00");
      await assert.rejects(() => opening("900.00"), /already has an opening balance/);
      await reverse(f, first.journalId);
      await opening("900.00");
      assert.equal(await book(f), "900.00");
      const entry = (await h.pool.query(`SELECT p.proname AS name, has_function_privilege('abos_e1_runtime', p.oid, 'EXECUTE') AS runtime,
          has_function_privilege('public', p.oid, 'EXECUTE') AS everyone, p.prosecdef AS definer FROM pg_proc p
          WHERE p.pronamespace = 'abos'::regnamespace AND (p.proname LIKE 'finance_journal_reversal_%' OR p.proname LIKE 'finance_period%'
            OR p.proname IN ('reversal_post', 'validate_reversal_journal', 'period_event', 'period_reopen', 'operational_expense_effects'))
          ORDER BY 1`)).rows;
      for (const fn of entry) {
        assert.equal(fn.everyone, false, `${fn.name}: PUBLIC`);
        // 0052: the monthly close / reopen entry points are retired and no longer callable by the runtime.
        assert.equal(fn.runtime, fn.definer && !String(fn.name).startsWith("finance_period"), `${fn.name}: only live entry points are callable by the runtime`);
      }
      const writes = (await h.pool.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'abos'::regnamespace
          AND c.relname IN ('accounting_period_events','accounting_period_reopen_requests','journal_reversal_links','journal_reversal_requests')
          AND (has_table_privilege('abos_e1_runtime', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('abos_e1_runtime', c.oid, 'INSERT,UPDATE'))`)).rows;
      assert.deepEqual(writes, []);
    });
  });
}
