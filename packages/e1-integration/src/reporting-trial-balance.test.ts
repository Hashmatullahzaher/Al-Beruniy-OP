import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0053 (Slice 7): the trial balance, the account statement and the journal detail derive only from posted
 * journals; scope and source permissions hide detail, never money. The General Ledger keeps every line.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const POLICIES = ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "EXPENSE", "SHAREHOLDER_CAPITAL_RECEIPT"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string; token: string };
type Row = { accountId: string; accountCode: string; openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string;
  endingDebit: string; endingCredit: string; native: { currency: string; endingNet: string; periodDebit: string }[] };
type Totals = { openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string; endingDebit: string; endingCredit: string };
type TrialBalance = { accounts: Row[]; totals: Totals; balanced: boolean; unbalancedJournals: number; range: { from: string; to: string; mode: string; fiscalYear: { closed: boolean } | null } };
type Line = { journalId: string; date: string; debit: string; credit: string; balance: string; restricted: boolean; journalReference: string | null;
  originalAmount: string; originalCurrency: string; rate: { rate: string } | null;
  source: { type: string; label: { en: string }; counterparty: string | null; detailRestricted?: boolean; route: string | null } | null;
  reversedBy: { journalId: string } | null; reverses: { journalId: string } | null };
type Statement = { opening: { net: string }; closing: { net: string }; lines: Line[]; periodDebit: string; periodCredit: string };

function session(token: string): Session {
  return { token, proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0053 trial balance and statements", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0053: trial balance, account statement and journal detail", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_tb_${randomUUID().replaceAll("-", "")}`;

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

    const ledger = async (entity: string, code: string, type: string, control: string | null, currency = "USD") => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,'ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control, currency]);
      return id;
    };
    const treasury = async (world: SyntheticWorld, name: string, currency: string, ledgerId: string) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,'SAFE',$4,$5,'ACTIVE',1,$6,$6)`,
      [id, world.legalEntityId, name, currency, ledgerId, world.bootstrapUserId]);
      return id;
    };

    async function fixture() {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const e = world.legalEntityId; const u = world.bootstrapUserId;
      await grant(h.executor, world, world.intentCreatorId, ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record",
        "treasury.payment.record", "treasury.opening-balance.record", "finance.expense.create", "finance.expense.read", "finance.report.operational.read",
        "finance.reversal.direct", "shareholder.setup.manage", "shareholder.read", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
        "finance.capital-receipt.prepare", "finance.capital-receipt.post"]);
      // A Finance reader without any shareholder permission, and a period manager.
      await grant(h.executor, world, world.approverId, ["finance.report.operational.read"]);
      await grant(h.executor, world, world.reverserId, ["finance.period.manage", "finance.report.operational.read"]);
      for (const workflow of POLICIES) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), e, workflow, u]);
      }
      const usdSafe = await treasury(world, "Synthetic main Safe", "USD", world.cashLedgerAccountId);
      const secondLedger = await ledger(e, "SYN-TB-CASH-2", "ASSET", "CASH");
      const secondSafe = await treasury(world, "Synthetic second Safe", "USD", secondLedger);
      const afnLedger = await ledger(e, "SYN-TB-CASH-AFN", "ASSET", "CASH", "AFN");
      const afnSafe = await treasury(world, "Synthetic AFN Safe", "AFN", afnLedger);
      const revenue = await ledger(e, "SYN-TB-INC", "REVENUE", null);
      const payable = await ledger(e, "SYN-TB-PAY", "LIABILITY", null);
      const expenseLedger = await ledger(e, "SYN-TB-EXP", "EXPENSE", null);
      const equity = await ledger(e, "SYN-TB-OBE", "EQUITY", "OPENING_BALANCE_EQUITY");
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-TB','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseLedger, u]);
      const project = randomUUID();
      await h.pool.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'TB-P','Synthetic restricted project',true)", [project, e]);
      await h.pool.query("INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id) VALUES ($1,$2,'PROJECT',$3,$4)",
        [world.intentCreatorId, e, project, u]);
      for (const [day, rate] of [["2026-09-14", "70"], ["2026-09-15", "70"]]) {
        await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
          VALUES ($1,$2,$3,'MARKET','USD','AFN',$4,'Synthetic rate',$5)`, [randomUUID(), e, day, rate, u]);
      }
      const s = async (user: string) => session((await issueOperationalSession(h, user, e)).token);
      return { world, e, usdSafe, secondSafe, secondLedger, afnSafe, afnLedger, revenue, payable, expenseLedger, equity, category, project,
        creator: await s(world.intentCreatorId), reader: await s(world.approverId), manager: await s(world.reverserId) };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
      const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `tb-${randomUUID()}`, correlationId: randomUUID() });
    const tb = (s: Session, payload: object) => call<TrialBalance>("finance_trial_balance", s, payload);
    const statement = (s: Session, accountId: string, payload: object) => call<Statement>("finance_account_statement", s, { accountId, ...payload });
    const SEPT = { from: "2026-09-01", to: "2026-09-30" };
    const row = (view: TrialBalance, id: string) => view.accounts.find((r) => r.accountId === id);

    /** The business month: opening balance, capital, income, an expense (one in a restricted project), payment, transfer, a reversal and AFN. */
    async function populate(f: Fixture) {
      const c = f.creator;
      await call("treasury_opening_balance_record", c, { treasuryAccountId: f.usdSafe, amount: "2500.00", currencyCode: "USD", asOfDate: "2026-09-01",
        reference: "OB-TB", note: null, ...keys() });
      const holder = await call<{ shareholderProfileId: string }>("direct_shareholder_add", c, { displayName: "Synthetic Report Holder", agreedTotal: null,
        currencyCode: "USD", externalReference: null, note: null, businessDate: "2026-09-05", firstContribution: null, ...keys() });
      const capital = await call<{ journalId: string }>("direct_shareholder_receive", c, { shareholderProfileId: holder.shareholderProfileId,
        fundingMethod: "CASH", amount: "700.00", currencyCode: "USD", receiptDate: "2026-09-06", destinationAccountId: f.usdSafe, providerName: null,
        itemDescription: null, expenseLedgerAccountId: null, paymentReference: "TB-CAP-1", note: null, ...keys() });
      const receipt = await call<{ journalId: string }>("treasury_receipt_record", c, { treasuryAccountId: f.usdSafe, amount: "1000.00", currencyCode: "USD",
        businessDate: "2026-09-10", payerBusinessPartyId: null, payerName: "Synthetic tenant", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
      const expense = (amount: string, extra: object) => call<{ expense: { journalId: string } }>("operational_expense_create", c, { treasuryAccountId: f.usdSafe,
        expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "TB-EXP",
        description: "Synthetic site supplies", note: null, businessDate: "2026-09-11", originalAmount: amount, currencyCode: "USD", exchangeRateId: null,
        ...keys(), ...extra });
      await expense("200.00", {});
      const restricted = await expense("50.00", { projectId: f.project, reference: "TB-SECRET" });
      const payment = await call<{ journalId: string }>("treasury_payment_record", c, { treasuryAccountId: f.usdSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null,
        payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-12", reference: null, note: null, ...keys() });
      await call("treasury_transfer_record", c, { sourceTreasuryAccountId: f.usdSafe, destinationTreasuryAccountId: f.secondSafe, amount: "300.00", currencyCode: "USD",
        businessDate: "2026-09-13", reference: null, note: null, ...keys() });
      const reversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", c, { journalId: payment.journalId,
        reason: "Synthetic duplicate supplier payment", ...keys() });
      const afn = await call<{ journalId: string }>("treasury_receipt_record", c, { treasuryAccountId: f.afnSafe, amount: "7000.00", currencyCode: "AFN",
        businessDate: "2026-09-14", payerBusinessPartyId: null, payerName: "Synthetic AFN tenant", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
      await call("operational_expense_create", c, { treasuryAccountId: f.afnSafe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null,
        departmentId: null, costCenterId: null, reference: "TB-AFN-EXP", description: "Synthetic AFN supplies", note: null, businessDate: "2026-09-15",
        originalAmount: "1400.00", currencyCode: "AFN", exchangeRateId: null, ...keys() });
      return { capital: capital.journalId, receipt: receipt.journalId, restricted: restricted.expense.journalId, payment: payment.journalId,
        reversal: reversal.reversalJournalId, afn: afn.journalId };
    }
    /** Every account's net straight from posted journal lines: the reference the reports must equal. */
    const ledgerNet = async (f: Fixture, from: string, to: string) => new Map((await h.pool.query<{ id: string; n: string }>(
      `SELECT l.ledger_account_id AS id, (sum(l.base_debit) - sum(l.base_credit))::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
        WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND j.accounting_effective_date BETWEEN $2 AND $3 GROUP BY 1`, [f.e, from, to])).rows.map((r) => [r.id, r.n]));
    const net = (r: Row | undefined, side: "ending" | "opening" = "ending") => r === undefined ? 0
      : Number(side === "ending" ? r.endingDebit : r.openingDebit) - Number(side === "ending" ? r.endingCredit : r.openingCredit);

    test("a company with no journal has an empty, balanced trial balance; every account can be listed at zero", async () => {
      const f = await fixture();
      const empty = await tb(f.creator, { asOf: "2026-09-30" });
      assert.deepEqual([empty.accounts, empty.balanced, empty.unbalancedJournals, empty.range.from, empty.range.mode], [[], true, 0, "2026-01-01", "AS_OF"]);
      assert.deepEqual(empty.totals, { openingDebit: "0", openingCredit: "0", periodDebit: "0", periodCredit: "0", endingDebit: "0", endingCredit: "0" });
      const all = await tb(f.creator, { asOf: "2026-09-30", includeZero: true });
      assert.ok(all.accounts.length >= 8 && all.accounts.every((r) => r.endingDebit === "0" && r.endingCredit === "0"));
      await assert.rejects(() => tb(f.creator, { from: "2026-09-30", to: "2026-09-01" }), /choose a valid period or valid dates/);
      await assert.rejects(() => tb(f.creator, { asOf: "2026-09-30", periodId: f.world.accountingPeriodId }), /choose one: a period, a date range or an as-of date/);
      assert.equal((await tb(f.creator, { asOf: "2031-03-15" })).range.from, "2031-01-01", "with no financial year, as-of starts the calendar year");
    });

    test("the trial balance equals posted ledger truth: debit and credit per account, totals balance, native AFN detail kept", async () => {
      const f = await fixture();
      await populate(f);
      const sept = await tb(f.creator, { periodId: f.world.accountingPeriodId });
      assert.equal(sept.range.mode, "PERIOD");
      assert.equal(sept.balanced, true);
      assert.equal(sept.totals.endingDebit, sept.totals.endingCredit);
      assert.equal(sept.totals.periodDebit, sept.totals.periodCredit);
      const truth = await ledgerNet(f, SEPT.from, SEPT.to);
      for (const r of sept.accounts) assert.equal(net(r), Number(truth.get(r.accountId) ?? 0), `${r.accountCode} equals the ledger`);
      assert.equal(sept.accounts.length, truth.size, "every account with activity appears once");
      // Opening balance 2,500 + capital 700 + income 1,000 - expenses 250 - payment 100 + its reversal 100 - transfer 300 = 3,650.
      assert.deepEqual([row(sept, f.world.cashLedgerAccountId)?.endingDebit, row(sept, f.world.cashLedgerAccountId)?.endingCredit], ["3650.00", "0"]);
      assert.deepEqual([row(sept, f.secondLedger)?.endingDebit], ["300.00"]);
      // The reversed payment shows both movements gross and nets to zero.
      assert.deepEqual([row(sept, f.payable)?.periodDebit, row(sept, f.payable)?.periodCredit, row(sept, f.payable)?.endingDebit,
        row(sept, f.payable)?.endingCredit], ["100.00", "100.00", "0.00", "0.00"]);
      assert.deepEqual([row(sept, f.revenue)?.endingCredit, row(sept, f.expenseLedger)?.endingDebit], ["1100.00", "270.00"]);
      assert.deepEqual([row(sept, f.equity)?.endingCredit], ["2500.00"], "opening balance equity stays visible");
      // The AFN Safe: USD in the trial balance, native AFN as detail.
      const afn = row(sept, f.afnLedger);
      assert.deepEqual([afn?.endingDebit, afn?.native.map((n) => [n.currency, n.endingNet])], ["80.00", [["AFN", "5600.00"]]]);
    });

    test("period boundaries: the ending of September is the opening of October; August is empty; as-of and range agree; closing changes nothing", async () => {
      const f = await fixture();
      await populate(f);
      const sept = await tb(f.creator, SEPT);
      const october = await tb(f.creator, { from: "2026-10-01", to: "2026-10-31" });
      for (const r of sept.accounts) {
        const o = row(october, r.accountId);
        if (net(r) === 0) { assert.equal(o, undefined, `${r.accountCode} closed at zero and has no October activity`); continue; }
        assert.deepEqual([o?.openingDebit, o?.openingCredit], [r.endingDebit, r.endingCredit], `${r.accountCode} carries forward`);
        assert.deepEqual([o?.periodDebit, o?.periodCredit], ["0", "0"]);
      }
      assert.deepEqual((await tb(f.creator, { from: "2026-08-01", to: "2026-08-31" })).accounts, []);
      const lastDay = await tb(f.creator, { from: "2026-09-30", to: "2026-09-30" });
      const nonZero = (view: TrialBalance) => view.accounts.filter((r) => net(r) !== 0).map((r) => [r.accountId, net(r)]);
      assert.deepEqual(nonZero(lastDay), nonZero(sept), "the last day's ending is the month's ending");
      const asOf = await tb(f.creator, { asOf: "2026-09-30" });
      assert.deepEqual(asOf.accounts.map((r) => [r.accountId, r.endingDebit, r.endingCredit]), sept.accounts.map((r) => [r.accountId, r.endingDebit, r.endingCredit]));
      // Closing the financial year (0052) changes no number; the report then says the year is closed.
      const year = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','سال مالی ۲۰۲۶','2026-01-01','2026-12-31',$3)`, [year, f.world.legalEntityId, f.world.bootstrapUserId]);
      assert.equal((await tb(f.creator, { periodId: f.world.accountingPeriodId })).range.fiscalYear?.closed, false);
      await call("finance_financial_year_close", f.manager, { fiscalYearId: year, correlationId: randomUUID() });
      const closed = await tb(f.creator, { periodId: f.world.accountingPeriodId });
      assert.deepEqual(closed.totals, sept.totals);
      assert.deepEqual(closed.accounts.map((r) => [r.accountId, r.endingDebit, r.endingCredit]), sept.accounts.map((r) => [r.accountId, r.endingDebit, r.endingCredit]));
      assert.equal(closed.range.fiscalYear?.closed, true);
    });

    test("account statement: opening, running balance and closing equal the trial balance; reversals linked both ways; FX rate shown", async () => {
      const f = await fixture();
      const j = await populate(f);
      const safe = await statement(f.creator, f.world.cashLedgerAccountId, SEPT);
      assert.equal(safe.opening.net, "0");
      assert.equal(safe.closing.net, "3650.00");
      assert.equal(Number(safe.lines.at(-1)?.balance), 3650);
      let running = 0;
      for (const line of safe.lines) { running += Number(line.debit) - Number(line.credit); assert.equal(Number(line.balance), running); }
      const paid = safe.lines.find((l) => l.journalId === j.payment);
      const back = safe.lines.find((l) => l.journalId === j.reversal);
      assert.deepEqual([paid?.reversedBy?.journalId, back?.reverses?.journalId, back?.source?.type], [j.reversal, j.payment, "REVERSAL"]);
      // Deterministic order: date, posting time, journal, line; several journals on one date keep that order on every read.
      const key = (l: Line & { postedAt?: string; lineNumber?: number }) => [l.date, l.postedAt ?? "", l.journalId, String(l.lineNumber ?? 0).padStart(4, "0")].join("|");
      assert.deepEqual(safe.lines.map(key), [...safe.lines.map(key)].sort());
      assert.deepEqual((await statement(f.creator, f.world.cashLedgerAccountId, SEPT)).lines, safe.lines, "every read is identical");
      const sameDay = safe.lines.filter((l) => l.date === "2026-09-12");
      assert.ok(sameDay.length >= 2, "the payment and its reversal share a date");
      // An account with no line in the range: a valid zero statement, never an error.
      const quiet = await statement(f.creator, f.payable, { from: "2026-08-01", to: "2026-08-31" });
      assert.deepEqual([quiet.opening.net, quiet.lines, quiet.closing.net, quiet.periodDebit], ["0", [], "0", "0"]);
      // October opens with September's closing.
      assert.equal((await statement(f.creator, f.world.cashLedgerAccountId, { from: "2026-10-01", to: "2026-10-31" })).opening.net, "3650.00");
      const afn = await statement(f.creator, f.afnLedger, SEPT);
      const received = afn.lines.find((l) => l.journalId === j.afn);
      assert.deepEqual([received?.originalAmount, received?.originalCurrency, received?.debit, received?.rate?.rate], ["7000.00", "AFN", "100.00", "70"]);
      // The journal detail drills from the statement to the source and back.
      const detail = await call<{ reference: string; source: { type: string; route: string }; lines: { debit: string }[];
        fx: { rate: string; roundingMode: string; baseScale: number } | null }>("finance_journal_detail", f.creator, j.afn);
      assert.deepEqual([detail.source.type, detail.source.route, detail.fx?.rate, detail.fx?.roundingMode, detail.lines.length],
        ["CASH_RECEIPT", "/finance/safes", "70", "HALF_UP", 2]);
      const original = await call<{ reversedBy: { journalId: string; reason: string } | null }>("finance_journal_detail", f.creator, j.payment);
      assert.deepEqual([original.reversedBy?.journalId, original.reversedBy?.reason], [j.reversal, "Synthetic duplicate supplier payment"]);
    });

    test("a scope-restricted reader gets identical totals with masked detail; the General Ledger keeps every line", async () => {
      const f = await fixture();
      const j = await populate(f);
      const full = await tb(f.creator, SEPT);
      const restricted = await tb(f.reader, SEPT);
      assert.deepEqual(restricted.accounts, full.accounts, "the reader's trial balance is the company's");
      const theirs = await statement(f.reader, f.expenseLedger, SEPT);
      const mine = await statement(f.creator, f.expenseLedger, SEPT);
      assert.equal(theirs.closing.net, mine.closing.net);
      const hidden = theirs.lines.find((l) => l.journalId === j.restricted);
      assert.deepEqual([hidden?.restricted, hidden?.journalReference, hidden?.source?.type, hidden?.debit], [true, null, "RESTRICTED", "50.00"]);
      assert.equal(mine.lines.find((l) => l.journalId === j.restricted)?.restricted, false);
      // The General Ledger activity and pages: the same totals as the trial balance's period columns, the restricted line masked.
      const activity = (await runtime.query<{ v: { accounts: { accountId: string; debitTotal: string; creditTotal: string }[] } }>(
        "SELECT abos.finance_general_ledger_activity($1, $2::date, $3::date, NULL) AS v", [f.reader.token, SEPT.from, SEPT.to])).rows[0]?.v;
      for (const r of full.accounts) {
        const a = activity?.accounts.find((x) => x.accountId === r.accountId);
        assert.deepEqual([a?.debitTotal, a?.creditTotal], [r.periodDebit, r.periodCredit], `GL activity ${r.accountCode} equals the trial balance`);
      }
      const page = (await runtime.query<{ v: { lines: { journalId: string; journalReference: string | null; sourceType: string; restricted: boolean }[] } }>(
        "SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, NULL, NULL, 100) AS v", [f.reader.token, SEPT.from, SEPT.to])).rows[0]?.v;
      const masked = page?.lines.filter((l) => l.journalId === j.restricted) ?? [];
      assert.equal(masked.length, 2);
      assert.ok(masked.every((l) => l.restricted && l.journalReference === null && l.sourceType === "RESTRICTED"));
      const detail = await call<{ restricted: boolean; reference: string | null; source: { type: string }; lines: { debit: string }[] }>(
        "finance_journal_detail", f.reader, j.restricted);
      assert.deepEqual([detail.restricted, detail.reference, detail.source.type, detail.lines[0]?.debit], [true, null, "RESTRICTED", "50.00"]);
    });

    test("a reader without shareholder permission sees capital in the Safe's balance under a generic description", async () => {
      const f = await fixture();
      const j = await populate(f);
      const theirs = await statement(f.reader, f.world.cashLedgerAccountId, SEPT);
      const mine = await statement(f.creator, f.world.cashLedgerAccountId, SEPT);
      assert.equal(theirs.closing.net, mine.closing.net, "the capital deposit counts in the reader's Safe balance");
      const generic = theirs.lines.find((l) => l.journalId === j.capital);
      const named = mine.lines.find((l) => l.journalId === j.capital);
      assert.deepEqual([generic?.debit, generic?.source?.type, generic?.source?.label.en, generic?.source?.counterparty, generic?.source?.detailRestricted,
        generic?.source?.route], ["700.00", "DIRECT_SHAREHOLDER_CAPITAL", "Capital received", null, true, null]);
      assert.deepEqual([named?.source?.counterparty, named?.source?.route], ["Synthetic Report Holder", "/shareholders"]);
    });

    test("another company, a synthetic session and a missing permission are refused", async () => {
      const f = await fixture();
      const j = await populate(f);
      const other = randomUUID();
      await h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
        VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `TB2-${other.slice(0, 8)}`]);
      const foreignAccount = await ledger(other, "OTH-CASH", "ASSET", "CASH");
      await assert.rejects(() => statement(f.creator, foreignAccount, SEPT), /ledger account was not found in this legal entity/);
      await assert.rejects(() => tb(f.creator, { periodId: randomUUID() }), /accounting period was not found in this legal entity/);
      // A grant in another company does not open this company's reports.
      const outsider = randomUUID();
      await h.pool.query("INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1,$2,'Synthetic Outsider','ACTIVE')",
        [outsider, `outsider.${outsider.slice(0, 8)}@synthetic.invalid`]);
      await grant(h.executor, f.world, outsider, ["finance.report.operational.read"], other);
      const stranger = session((await issueOperationalSession(h, outsider, other)).token);
      assert.deepEqual((await tb(stranger, SEPT)).accounts, [], "the other company sees only its own (empty) ledger");
      await assert.rejects(() => call("finance_journal_detail", stranger, j.receipt), /journal was not found in this legal entity/);
      // A person without the report permission.
      const plain = session((await issueOperationalSession(h, f.world.treasuryManagerId, f.e)).token);
      await assert.rejects(() => tb(plain, SEPT), /current authority is missing finance\.report\.operational\.read/);
      // A synthetic sandbox session.
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,
        runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)",
        [f.e, f.world.bootstrapUserId]);
      const developer = session((await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.e as never })).token);
      await assert.rejects(() => tb(developer, SEPT), /sign in|missing|session/);
      // Reports never write.
      const before = (await h.pool.query("SELECT (SELECT count(*) FROM abos.journals) + (SELECT count(*) FROM abos.audit_records) AS n")).rows[0]?.n;
      await tb(f.creator, SEPT); await statement(f.creator, f.revenue, SEPT); await call("finance_journal_detail", f.creator, j.receipt);
      assert.equal((await h.pool.query("SELECT (SELECT count(*) FROM abos.journals) + (SELECT count(*) FROM abos.audit_records) AS n")).rows[0]?.n, before);
    });
  });
}
