import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, embedded, ReportDatabase, SEPT, type ReportCompany, type ReportEvents, type Session } from "./report-world.ts";

/**
 * Migration 0058: the Shareholder Statement and the Financial Summary. Equity and debt stay apart, transfers and reversals never
 * count as company money, and every total reconciles to the ledger. A report reader gets totals with nobody named.
 */

type Figures = { opening: string; closing: string; capitalReceived: string; loansReceived: string; otherReceipts: string; moneyReceived: string; expensesPaid: string;
  paymentsMade: string; loanRepayments: string; moneyPaid: string; openingBalancesRecorded: string; transfersIn: string; transfersOut: string; unclassified: string;
  reversalsIn: string; reversalsOut: string; reversalCount: number; flowsClosing: string };
type Summary = { baseCurrency: string; range: { mode: string; from: string; to: string; fiscalYear: { closed: boolean } | null }; base: Figures; currencies: Record<string, Figures>;
  accounts: { id: string; currency: string; opening: string; closing: string; baseClosing: string }[]; profit: { income: string; expenses: string; netResult: string };
  reconciliation: { treasuryClosing: string; flowsClosing: string; ledgerClosing: string; matches: boolean } };
type Capital = { currency: string; agreed: string | null; opening: string; received: string; reversed: string; effective: string; baseEffective: string; outstanding: string | null };
type Loan = { currency: string; opening: string; received: string; repaid: string; outstanding: string; baseOutstanding: string };
type Transaction = { id: string; date: string; kind: string; section: string; amount: string; effect: string; balance: string; currency: string; restricted: boolean; journalId: string | null;
  journalReference: string | null; safe: { id: string; nameEn: string } | null; source: { reference?: string | null; description?: string | null; counterparty: string | null; id: string | null };
  reversedBy: { journalId: string | null } | null; reverses: { journalId: string | null } | null };
type Statement = { canReadCapital: boolean; canReadLoans: boolean;
  totals: { capital: { currency: string; effective: string; baseEffective: string }[] | null; loans: { currency: string; outstanding: string; baseOutstanding: string }[] | null };
  people: { partyId: string; name: string; isShareholder: boolean; capital: unknown[] | null; loans: unknown[] | null }[];
  reconciliation: { capital: { subledgerBase: string; ledgerBase: string; matches: boolean } | null; loans: { subledgerBase: string; ledgerBase: string; matches: boolean } | null };
  statement: { party: { id: string; name: string; shareholderProfileId: string | null }; capital: Capital[] | null; loans: Loan[] | null; transactions: Transaction[]; canOpenLedger: boolean } | null };

if (databaseUrl() === undefined) {
  test("0058 Shareholder Statement and Financial Summary", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0058: Shareholder Statement and Financial Summary", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let j: ReportEvents;
    before(async () => { await db.open(); f = await db.company(); j = await db.populate(f); });
    after(async () => { await db.close(); });

    const summary = (s: Session, payload: object = SEPT) => db.call<Summary>("finance_management_summary", s, payload);
    const shareholders = (s: Session, payload: object = SEPT) => db.call<Statement>("finance_shareholder_statement", s, payload);
    const statement = async (s: Session, partyId: string, range: object = SEPT) => {
      const view = await shareholders(s, { partyId, ...range }); assert.ok(view.statement); return view.statement;
    };

    test("the summary's money: capital, loans and receipts in; expenses, payments and repayments out, each net of its reversals", async () => {
      const view = await summary(f.creator);
      const b = view.base;
      // Capital 700 + 300 + 1,000, with the 300 reversed. Loans into a Safe only: the lender's 150 never touched Treasury.
      assert.deepEqual([Number(b.capitalReceived), Number(b.loansReceived), Number(b.otherReceipts)], [1700, 600, 1200]);
      assert.equal(Number(b.moneyReceived), 3500);
      // Expenses 200 + 50 + 30 with the 30 reversed. Payments 100 reversed, AFN 20, Saraf 400. Repaid 250.
      assert.deepEqual([Number(b.expensesPaid), Number(b.paymentsMade), Number(b.loanRepayments)], [250, 420, 250]);
      assert.equal(Number(b.moneyPaid), 920);
      assert.deepEqual([Number(b.opening), Number(b.openingBalancesRecorded), Number(b.closing)], [0, 2500, 5080]);
      assert.equal(Number(b.unclassified), 0, "every Treasury source is classified");
    });

    test("transfers stay out of company money and appear on their own, and their reversal stays internal", async () => {
      const b = (await summary(f.creator)).base;
      assert.deepEqual([Number(b.transfersIn), Number(b.transfersOut)], [300, 300], "300 moved; the 20 was reversed, so it nets away");
      assert.equal(Number(b.moneyReceived) + Number(b.opening) + Number(b.openingBalancesRecorded) - Number(b.moneyPaid), Number(b.closing), "the closing needs no transfer to explain it");
    });

    test("reversals are shown as activity but are never new money", async () => {
      const b = (await summary(f.creator)).base;
      // In: payment 100, expense 30, transfer 20. Out: capital 300, transfer 20.
      assert.deepEqual([Number(b.reversalsIn), Number(b.reversalsOut), b.reversalCount], [150, 320, 5]);
    });

    test("the closing Treasury position is proved three ways and equals the canonical account balances", async () => {
      const view = await summary(f.creator);
      assert.equal(view.reconciliation.matches, true);
      assert.deepEqual([Number(view.reconciliation.treasuryClosing), Number(view.reconciliation.flowsClosing), Number(view.reconciliation.ledgerClosing)], [5080, 5080, 5080]);
      for (const account of view.accounts) {
        const canonical = await db.h.pool.query<{ book: string }>("SELECT book_balance::text AS book FROM abos.treasury_account_balances($1, '2026-09-30', $2)", [f.e, account.id]);
        assert.equal(Number(account.closing), Number(canonical.rows[0]?.book));
      }
      assert.equal(view.accounts.reduce((sum, a) => sum + Number(a.baseClosing), 0), 5080, "the accounts add up to the position");
      const raw = await db.h.pool.query<{ n: string }>(`SELECT (sum(l.base_debit) - sum(l.base_credit))::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
        WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND l.ledger_account_id IN (SELECT ledger_account_id FROM abos.operational_treasury_accounts WHERE legal_entity_id = $1)`, [f.e]);
      assert.equal(Number(raw.rows[0]?.n), 5080, "posted journal lines are the truth");
    });

    test("AFN keeps its own figures beside the accounting currency; a Saraf's negative balance stays negative", async () => {
      const view = await summary(f.creator);
      const afn = view.currencies.AFN;
      assert.deepEqual([Number(afn?.closing), Number(afn?.otherReceipts), Number(afn?.paymentsMade), Number(afn?.flowsClosing)], [5600, 7000, 1400, 5600]);
      assert.equal(Number(view.currencies.USD?.closing), 5000, "USD accounts alone");
      assert.equal(Number(view.accounts.find((a) => a.id === f.saraf)?.closing), -300);
      assert.equal(Number(view.accounts.find((a) => a.id === f.afnSafe)?.baseClosing), 80, "the AFN Safe's accounting value is the frozen conversion, not today's rate");
    });

    test("profit comes from classified ledger accounts, not from the Expense module", async () => {
      const { profit } = await summary(f.creator);
      // Income 1,000 + 100 + 100. Expenses 200 + 50 + the lender's 150; the mistaken 30 nets away.
      assert.deepEqual([Number(profit.income), Number(profit.expenses), Number(profit.netResult)], [1200, 400, 800]);
    });

    test("a range: September splits cleanly, and the second half opens where the first closed", async () => {
      const first = await summary(f.creator, { from: "2026-09-01", to: "2026-09-10" });
      const second = await summary(f.creator, { from: "2026-09-11", to: "2026-09-30" });
      assert.equal(second.base.opening, first.base.closing);
      assert.equal(Number(first.base.moneyReceived) + Number(second.base.moneyReceived), 3500);
      assert.equal(Number(first.profit.netResult) + Number(second.profit.netResult), 800);
      assert.deepEqual([first.reconciliation.matches, second.reconciliation.matches], [true, true]);
    });

    test("a financial year can be chosen; closing it changes no figure and the summary says so", async () => {
      const year = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','سال مالی ۲۰۲۶','2026-01-01','2026-12-31',$3)`, [year, f.e, f.u]);
      const open = await summary(f.creator, { fiscalYearId: year });
      assert.deepEqual([open.range.mode, open.range.from, open.range.to, open.range.fiscalYear?.closed], ["YEAR", "2026-01-01", "2026-12-31", false]);
      await assert.rejects(() => summary(f.creator, { fiscalYearId: randomUUID() }), /financial year was not found in this legal entity/);
      await db.call("finance_financial_year_close", f.manager, { fiscalYearId: year, correlationId: randomUUID() });
      const closed = await summary(f.creator, { fiscalYearId: year });
      assert.equal(closed.range.fiscalYear?.closed, true);
      assert.deepEqual([closed.base, closed.profit], [open.base, open.profit]);
    });

    test("equity: agreed, received, reversed, effective and outstanding, with the agreement as information only", async () => {
      const s = await statement(f.creator, j.partyA);
      const capital = s.capital?.[0];
      assert.deepEqual([capital?.currency, Number(capital?.received), Number(capital?.reversed), Number(capital?.effective), Number(capital?.agreed), Number(capital?.outstanding)],
        ["USD", 1000, 300, 700, 5000, 4300]);
      const second = await statement(f.creator, j.partyB);
      assert.deepEqual([second.capital?.[0]?.agreed, second.capital?.[0]?.outstanding, Number(second.capital?.[0]?.effective)], [null, null, 1000], "nothing is implied by a missing agreement");
    });

    test("debt is kept apart from equity: received, repaid and outstanding", async () => {
      const s = await statement(f.creator, j.partyA);
      const loan = s.loans?.[0];
      assert.deepEqual([Number(loan?.received), Number(loan?.repaid), Number(loan?.outstanding)], [600, 250, 350]);
      assert.equal(Number(s.capital?.[0]?.effective), 700, "the loan is not capital");
      const lender = await statement(f.creator, f.provider);
      assert.deepEqual([lender.capital, Number(lender.loans?.[0]?.outstanding)], [[], 150], "a lender who is not a shareholder has debt and no equity");
      const list = await shareholders(f.creator);
      assert.equal(list.people.find((p) => p.partyId === f.provider)?.isShareholder, false);
    });

    test("transactions drill down: source, journal, Safe movement, reversal state and a running balance per section", async () => {
      const s = await statement(f.creator, j.partyA);
      assert.deepEqual(s.transactions.map((t) => [t.kind, t.amount, t.balance]), [
        ["CAPITAL_RECEIVED", "700.00", "700.00"], ["CAPITAL_RECEIVED", "300.00", "1000.00"], ["CAPITAL_REVERSAL", "300.00", "700.00"], ["LOAN_RECEIVED", "600.00", "600.00"], ["LOAN_REPAID", "250.00", "350.00"]]);
      const first = s.transactions[0];
      assert.deepEqual([first?.source.reference, first?.source.description, first?.journalId, first?.safe?.id], ["RW-CAP-PRIVATE", "Synthetic private capital note", j.capitalA, f.usdSafe]);
      assert.equal(s.transactions[1]?.reversedBy?.journalId, j.capitalReversal);
      assert.equal(s.transactions[2]?.reverses?.journalId, j.capitalWrong);
      const safe = await db.call<{ statement: { lines: { journalId: string; moneyIn: string }[] } }>("treasury_account_statement", f.creator, { accountId: f.usdSafe, ...SEPT });
      assert.equal(safe.statement.lines.find((l) => l.journalId === j.capitalA)?.moneyIn, "700.00", "the same transaction is on the Safe's statement");
    });

    test("every position equals its ledger: equity to the capital accounts, debt to the payable accounts", async () => {
      const view = await shareholders(f.creator);
      assert.deepEqual([view.reconciliation.capital?.matches, Number(view.reconciliation.capital?.subledgerBase), Number(view.reconciliation.capital?.ledgerBase)], [true, 1700, 1700]);
      assert.deepEqual([view.reconciliation.loans?.matches, Number(view.reconciliation.loans?.subledgerBase), Number(view.reconciliation.loans?.ledgerBase)], [true, 500, 500]);
      assert.equal(Number(view.totals.capital?.[0]?.effective), 1700);
      assert.equal(Number(view.totals.loans?.[0]?.outstanding), 500);
      const raw = await db.h.pool.query<{ n: string }>("SELECT sum(capital_posted)::text AS n FROM abos.shareholder_capital_balances($1)", [f.e]);
      assert.equal(Number(raw.rows[0]?.n), 1700, "the existing capital balance agrees");
    });

    test("a report-only reader gets company totals and nobody named", async () => {
      const view = await shareholders(f.reportReader);
      assert.deepEqual([view.people, view.canReadCapital, view.canReadLoans], [[], false, false]);
      assert.equal(Number(view.totals.capital?.[0]?.effective), 1700, "the mathematics is complete");
      assert.equal(Number(view.totals.loans?.[0]?.outstanding), 500);
      assertAbsent(view, ["Synthetic Private Holder", "Synthetic Second Holder", "Synthetic Outside Lender", j.partyA, j.partyB, f.provider], "a report-only reader");
      await assert.rejects(() => shareholders(f.reportReader, { partyId: j.partyA, ...SEPT }), /shareholder was not found in this legal entity/);
      const summaryView = await summary(f.reportReader);
      assert.equal(summaryView.reconciliation.matches, true);
      const receipt = await db.sourceId(j.capitalA);
      assertAbsent(summaryView, ["Synthetic Private Holder", "RW-CAP-PRIVATE", receipt, embedded(receipt), "Synthetic tenant"], "the summary");
    });

    test("capital and loan readers see only their own section", async () => {
      const capital = await statement(f.capitalReader, j.partyA);
      assert.equal(capital.loans, null, "no debt for a capital reader");
      assert.equal(capital.transactions.every((t) => t.section === "CAPITAL"), true);
      assertAbsent(capital, ["Synthetic shareholder loan", "RW-REPAY"], "a capital reader");
      assert.equal(capital.transactions[0]?.journalId, null, "no ledger link without report permission");
      assert.equal(capital.transactions[0]?.safe, null, "no Safe link without Safe permission");
      assert.equal(capital.transactions[0]?.source.reference, "RW-CAP-PRIVATE", "capital detail is theirs to read");
      const capitalList = await shareholders(f.capitalReader);
      assert.equal(capitalList.totals.loans, null);
      assert.equal(capitalList.reconciliation.loans, null);
      assert.equal(capitalList.people.some((p) => p.partyId === f.provider), false, "a lender is not a shareholder");
      const loan = await statement(f.loanReader, j.partyA);
      assert.equal(loan.capital, null, "no equity for a loan reader");
      assert.equal(loan.transactions.every((t) => t.section === "LOAN"), true);
      assertAbsent(loan, ["RW-CAP-PRIVATE", "Synthetic private capital note"], "a loan reader");
      assert.equal((await shareholders(f.loanReader)).people.some((p) => p.partyId === j.partyB), false, "someone with no loan is not listed");
      await assert.rejects(() => shareholders(f.loanReader, { partyId: j.partyB, ...SEPT }), /shareholder was not found/);
    });

    test("no permission, another company, bad requests", async () => {
      await assert.rejects(() => shareholders(f.nobody), /current authority is missing shareholder\.read/);
      await assert.rejects(() => summary(f.nobody), /current authority is missing finance\.report\.operational\.read/);
      await assert.rejects(() => shareholders(f.creator, { partyId: randomUUID(), ...SEPT }), /shareholder was not found in this legal entity/);
      await assert.rejects(() => shareholders(f.creator, { partyId: "nonsense", ...SEPT }), /choose a valid shareholder/);
      await assert.rejects(() => shareholders(f.creator, { surprise: 1, ...SEPT }), /unknown report fields/);
      await assert.rejects(() => summary(f.creator, { surprise: 1, ...SEPT }), /unknown report fields/);
      await assert.rejects(() => summary(f.creator, {}), /choose one: a period, a date range or an as-of date/);
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
        VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `RW2-${other.slice(0, 8)}`]);
      const foreign = randomUUID();
      await db.h.pool.query("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status) VALUES ($1,$2,'Synthetic Foreign Party',$3,'ACTIVE')", [foreign, other, `SYN-${foreign.slice(0, 8)}`]);
      await assert.rejects(() => shareholders(f.creator, { partyId: foreign, ...SEPT }), /shareholder was not found in this legal entity/);
    });

    test("reading writes nothing", async () => {
      const count = async () => (await db.h.pool.query<{ j: string; l: string; s: string }>(
        "SELECT (SELECT count(*) FROM abos.journals)::text j, (SELECT count(*) FROM abos.journal_lines)::text l, (SELECT count(*) FROM abos.subledger_entries)::text s")).rows[0];
      const before = await count();
      await summary(f.creator); await shareholders(f.creator); await statement(f.creator, j.partyA);
      assert.deepEqual(await count(), before);
    });
  });
}
