import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, embedded, ReportDatabase, SEPT, type ReportCompany, type ReportEvents, type Session } from "./report-world.ts";

/**
 * Migration 0059 and the permanent cross-report reconciliation. Each report has its own tests; this suite proves they agree with
 * each other and with posted journal lines, on one company holding every kind of event. It must never be weakened to fit a report.
 */

type Row = { accountId: string; code: string; name: string; amount: string; class: string; group?: string; control?: string | null };
type Income = { income: Row[]; expenses: Row[]; totalIncome: string; totalExpenses: string; netResult: string; range: { from: string; to: string };
  yearToDate: { from: string; to: string; netResult: string } };
type Sheet = { asOf: string; yearStart: string; accounts: Row[]; totalAssets: string; totalLiabilities: string; equityAccounts: string; earlierYearsResult: string; currentYearResult: string;
  totalEquity: string; totalLiabilitiesAndEquity: string; validation: { difference: string; balanced: boolean; unbalancedJournals: number }; treasury: { treasuryBase: string; ledgerBase: string; matches: boolean } };
type Trial = { accounts: { accountId: string; endingDebit: string; endingCredit: string }[]; totals: Record<string, string>; balanced: boolean };
type Summary = { base: { closing: string; moneyReceived: string; moneyPaid: string; capitalReceived: string; loansReceived: string; reversalsIn: string }; profit: { income: string; expenses: string; netResult: string };
  currencies: Record<string, { closing: string }>; accounts: { id: string; closing: string; baseClosing: string }[]; reconciliation: { matches: boolean } };
type Safe = { statement: { closing: { native: string; base: string }; lines: { moneyIn: string; moneyOut: string; balance: string; fx: unknown }[]; reconciliation: { matches: boolean } } };
type Shareholders = { totals: { capital: { effective: string }[]; loans: { outstanding: string }[] }; reconciliation: { capital: { matches: boolean; subledgerBase: string }; loans: { matches: boolean; subledgerBase: string } } };

if (databaseUrl() === undefined) {
  test("0059 and cross-report reconciliation", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0059: financial statements and cross-report reconciliation", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let j: ReportEvents; let cleanSheet: Sheet; let cleanIncome: Income;
    before(async () => {
      await db.open();
      // A company with nothing posted, read before the populated company replaces it.
      const clean = await db.company();
      cleanSheet = await db.call<Sheet>("finance_balance_sheet", clean.creator, { asOf: "2026-09-30" });
      cleanIncome = await db.call<Income>("finance_income_statement", clean.creator, SEPT);
      f = await db.company(); j = await db.populate(f);
    });
    after(async () => { await db.close(); });

    const income = (s: Session, payload: object = SEPT) => db.call<Income>("finance_income_statement", s, payload);
    const sheet = (s: Session, payload: object = { asOf: "2026-09-30" }) => db.call<Sheet>("finance_balance_sheet", s, payload);
    const trial = (s: Session) => db.call<Trial>("finance_trial_balance", s, SEPT);
    const summary = (s: Session) => db.call<Summary>("finance_management_summary", s, SEPT);
    const safe = (s: Session, accountId: string) => db.call<Safe>("treasury_account_statement", s, { accountId, ...SEPT });
    const shareholders = (s: Session) => db.call<Shareholders>("finance_shareholder_statement", s, SEPT);
    const row = (rows: Row[], id: string) => rows.find((r) => r.accountId === id);
    /** The class total straight from posted journal lines: what every report must equal. */
    const ledger = async (type: string, to = "2026-09-30", from = "1900-01-01") => Number((await db.h.pool.query<{ n: string }>(
      `SELECT COALESCE(sum(l.base_debit) - sum(l.base_credit), 0)::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
         JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id
        WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND a.account_type = $2 AND j.accounting_effective_date BETWEEN $3 AND $4`, [f.e, type, from, to])).rows[0]?.n);

    test("the Income Statement: income less expenses by account, every source, reversals netted, AFN at its posted value", async () => {
      const view = await income(f.creator);
      // Rent 1,000, AFN 7,000 at 70 = 100, Saraf client 100.
      assert.deepEqual([Number(view.totalIncome), Number(row(view.income, f.revenue)?.amount)], [1200, 1200]);
      // Supplies 200 + restricted 50 + the lender's 150. The mistaken 30 is posted and reversed.
      assert.deepEqual([Number(view.totalExpenses), Number(row(view.expenses, f.expenseLedger)?.amount)], [400, 400]);
      assert.equal(Number(view.netResult), 800);
      assert.equal(view.income.reduce((sum, r) => sum + Number(r.amount), 0), Number(view.totalIncome), "the rows add up to the total");
      assert.equal(view.expenses.reduce((sum, r) => sum + Number(r.amount), 0), Number(view.totalExpenses));
    });

    test("the Income Statement equals the classified ledger, for any range, and its year to date is the sum of its parts", async () => {
      const view = await income(f.creator);
      assert.equal(Number(view.totalIncome), -(await ledger("REVENUE", SEPT.to, SEPT.from)));
      assert.equal(Number(view.totalExpenses), await ledger("EXPENSE", SEPT.to, SEPT.from));
      const first = await income(f.creator, { from: "2026-09-01", to: "2026-09-10" });
      const second = await income(f.creator, { from: "2026-09-11", to: "2026-09-30" });
      assert.equal(Number(first.netResult) + Number(second.netResult), Number(view.netResult));
      const asOf = await income(f.creator, { asOf: "2026-09-30" });
      assert.deepEqual([asOf.range.from, asOf.yearToDate.from, Number(asOf.netResult), Number(asOf.yearToDate.netResult)], ["2026-01-01", "2026-01-01", 800, 800]);
      assert.equal(Number((await income(f.creator, { from: "2026-08-01", to: "2026-08-31" })).netResult), 0);
    });

    test("any posting to an income or expense account appears, whichever module posted it", async () => {
      const sources = await db.h.pool.query<{ source: string }>(`SELECT DISTINCT i.source_type AS source FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
        JOIN abos.posting_intents i ON i.id = j.posting_intent_id JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE a.account_type = 'EXPENSE' AND l.legal_entity_id = $1 ORDER BY 1`, [f.e]);
      assert.deepEqual(sources.rows.map((r) => r.source), ["OPERATIONAL_EXPENSE", "REVERSAL", "TEMPORARY_FUNDING"], "expenses reach the ledger through more than the Expense module");
      const statement = await db.call<{ lines: { source: { type: string } }[] }>("finance_account_statement", f.creator, { accountId: f.expenseLedger, ...SEPT });
      assert.ok(statement.lines.some((l) => l.source.type === "TEMPORARY_FUNDING"));
      assert.equal(Number((await income(f.creator)).totalExpenses), 400, "and the lender's expense is in the total");
    });

    test("the Balance Sheet balances, in exact decimals, with every class equal to the ledger", async () => {
      const view = await sheet(f.creator);
      assert.deepEqual([view.validation.difference, view.validation.balanced, view.validation.unbalancedJournals], ["0.00", true, 0]);
      assert.equal(Number(view.totalAssets), await ledger("ASSET"));
      assert.equal(Number(view.totalLiabilities), -(await ledger("LIABILITY")));
      assert.equal(Number(view.equityAccounts), -(await ledger("EQUITY")));
      assert.equal(Number(view.currentYearResult), 800);
      assert.equal(Number(view.totalAssets), Number(view.totalLiabilitiesAndEquity));
      assert.equal(view.accounts.filter((a) => a.class === "ASSET").reduce((sum, a) => sum + Number(a.amount), 0), Number(view.totalAssets), "the asset rows add up");
    });

    test("the Balance Sheet's groups: Treasury, loans, payables, capital and a visible Opening Balance Equity", async () => {
      const view = await sheet(f.creator);
      const group = (name: string) => view.accounts.filter((a) => a.group === name).reduce((sum, a) => sum + Number(a.amount), 0);
      assert.equal(group("TREASURY"), 5080);
      assert.equal(group("LOANS"), 500, "350 owed to the shareholder and 150 to the outside lender");
      assert.equal(group("SHAREHOLDER_CAPITAL"), 1700);
      assert.equal(group("OPENING_BALANCE_EQUITY"), 2500);
      assert.equal(row(view.accounts, f.equity)?.group, "OPENING_BALANCE_EQUITY");
      // Payables: paid 20 + 400 without a bill, and the reversed 100 nets away. A debit on a liability stays a liability, shown negative.
      assert.equal(group("PAYABLES"), -420);
      assert.equal(Number(row(view.accounts, f.sarafLedger)?.amount), -300, "the Saraf's negative balance stays in Treasury, as a negative figure");
    });

    test("a clean company balances at zero", () => {
      assert.deepEqual([cleanSheet.totalAssets, cleanSheet.totalLiabilities, cleanSheet.totalEquity, cleanSheet.validation.difference, cleanSheet.validation.balanced], ["0", "0", "0", "0", true]);
      assert.deepEqual([cleanIncome.income, cleanIncome.expenses, cleanIncome.netResult], [[], [], "0"]);
    });

    test("the Balance Sheet balances at every date in the month, through each kind of event", async () => {
      for (const asOf of ["2026-09-01", "2026-09-06", "2026-09-08", "2026-09-09", "2026-09-11", "2026-09-13", "2026-09-15", "2026-09-16", "2026-09-20", "2026-09-30"]) {
        const view = await sheet(f.creator, { asOf });
        assert.equal(view.validation.balanced, true, `balanced on ${asOf}`);
        assert.equal(view.treasury.matches, true, `Treasury agrees on ${asOf}`);
      }
    });

    test("all reports reconcile: one company, every report, one truth", async () => {
      const [tb, sheetView, incomeView, summaryView, people] = [await trial(f.creator), await sheet(f.creator), await income(f.creator), await summary(f.creator), await shareholders(f.creator)];
      // Trial balance.
      assert.equal(tb.balanced, true);
      assert.equal(tb.totals.endingDebit, tb.totals.endingCredit);
      // Safe statements = canonical Treasury = ledger.
      let treasuryBase = 0;
      for (const [account, ledgerId] of [[f.usdSafe, f.world.cashLedgerAccountId], [f.secondSafe, f.secondLedger], [f.afnSafe, f.afnLedger], [f.saraf, f.sarafLedger]] as const) {
        const s = (await safe(f.creator, account)).statement;
        const canonical = await db.h.pool.query<{ book: string }>("SELECT book_balance::text AS book FROM abos.treasury_account_balances($1, '2026-09-30', $2)", [f.e, account]);
        assert.equal(Number(s.closing.native), Number(canonical.rows[0]?.book), "Safe statement = canonical Treasury balance");
        assert.equal(s.reconciliation.matches, true, "Treasury accounting value = ledger account");
        const tbRow = tb.accounts.find((r) => r.accountId === ledgerId);
        assert.equal(Number(tbRow?.endingDebit ?? 0) - Number(tbRow?.endingCredit ?? 0), Number(s.closing.base), "trial balance = Treasury accounting value");
        assert.equal(Number(row(sheetView.accounts, ledgerId)?.amount), Number(s.closing.base), "balance sheet = Treasury accounting value");
        assert.equal(Number(summaryView.accounts.find((a) => a.id === account)?.closing), Number(s.closing.native), "summary = Safe statement");
        treasuryBase += Number(s.closing.base);
      }
      assert.equal(treasuryBase, Number(summaryView.base.closing), "summary closing = sum of Treasury accounts");
      assert.equal(summaryView.reconciliation.matches, true);
      assert.deepEqual([Number(sheetView.treasury.treasuryBase), sheetView.treasury.matches], [treasuryBase, true]);
      // Shareholders: equity and debt to the balance sheet.
      assert.equal(Number(people.totals.capital[0]?.effective), Number(row(sheetView.accounts, f.world.capitalLedgerAccountId)?.amount), "effective capital = equity on the balance sheet");
      assert.equal(Number(people.totals.loans[0]?.outstanding), Number(row(sheetView.accounts, f.loanLedger)?.amount), "outstanding loans = liability on the balance sheet");
      assert.deepEqual([people.reconciliation.capital.matches, people.reconciliation.loans.matches], [true, true]);
      // Result: three reports, one number.
      assert.deepEqual([Number(incomeView.netResult), Number(summaryView.profit.netResult), Number(sheetView.currentYearResult)], [800, 800, 800]);
    });

    test("reversals net in every report", async () => {
      const [incomeView, sheetView, summaryView] = [await income(f.creator), await sheet(f.creator), await summary(f.creator)];
      // Capital 300, expense 30, payment 100 and transfer 20 were reversed: none of them remains in any total.
      assert.equal(Number(summaryView.base.capitalReceived), 1700);
      assert.equal(Number(incomeView.totalExpenses), 400);
      assert.equal(Number(row(sheetView.accounts, f.world.capitalLedgerAccountId)?.amount), 1700);
      assert.equal(Number((await safe(f.creator, f.saraf)).statement.closing.native), -300, "the transfer into the Saraf and its reversal net away");
    });

    test("AFN: native Treasury and USD ledger reconcile through the frozen conversion", async () => {
      const afn = (await safe(f.creator, f.afnSafe)).statement;
      assert.deepEqual([Number(afn.closing.native), Number(afn.closing.base), afn.reconciliation.matches], [5600, 80, true]);
      assert.equal(Number((await summary(f.creator)).currencies.AFN?.closing), 5600);
      assert.equal(Number(row((await sheet(f.creator)).accounts, f.afnLedger)?.amount), 80);
      const conversions = await db.h.pool.query<{ total: string }>("SELECT sum(CASE c.source_type WHEN 'CASH_RECEIPT' THEN c.base_amount ELSE -c.base_amount END)::text AS total FROM abos.fx_conversions c WHERE c.legal_entity_id = $1", [f.e]);
      assert.equal(Number(conversions.rows[0]?.total), 80, "the frozen conversions add up to the accounting value");
      // A new rate changes nothing: there is no revaluation.
      await db.h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
        VALUES ($1,$2,'2026-09-29','MARKET','USD','AFN','100','Synthetic later rate',$3)`, [randomUUID(), f.e, f.u]);
      assert.equal(Number(row((await sheet(f.creator)).accounts, f.afnLedger)?.amount), 80, "the later rate revalues nothing");
    });

    test("a restricted reader gets identical mathematics and no source detail, in every report", async () => {
      const r = f.reportReader; const c = f.creator;
      assert.deepEqual(await sheet(r), await sheet(c), "the statements carry no source at all, so they are the same for both");
      assert.deepEqual(await income(r), await income(c));
      assert.deepEqual((await trial(r)).totals, (await trial(c)).totals);
      assert.deepEqual((await summary(r)).base, (await summary(c)).base);
      assert.deepEqual((await safe(r, f.usdSafe)).statement.closing, (await safe(c, f.usdSafe)).statement.closing);
      assert.deepEqual((await shareholders(r)).totals, (await shareholders(c)).totals);
      const receipt = await db.sourceId(j.capitalA);
      const secrets = ["Synthetic Private Holder", "Synthetic Second Holder", "Synthetic Outside Lender", "RW-CAP-PRIVATE", "Synthetic private capital note", receipt, embedded(receipt), "Synthetic tenant", "RW-RENT", "RW-SECRET", "Synthetic restricted works"];
      for (const [name, view] of [["balance sheet", await sheet(r)], ["income statement", await income(r)], ["summary", await summary(r)], ["Safe statement", await safe(r, f.usdSafe)], ["shareholders", await shareholders(r)]] as const) {
        assertAbsent(view, secrets, `the ${name} of a restricted reader`);
      }
    });

    test("no permission, another company's data, bad requests, and reading writes nothing", async () => {
      await assert.rejects(() => income(f.nobody), /current authority is missing finance\.report\.operational\.read/);
      await assert.rejects(() => sheet(f.nobody), /current authority is missing finance\.report\.operational\.read/);
      await assert.rejects(() => income(f.creator, { surprise: 1, ...SEPT }), /unknown report fields/);
      await assert.rejects(() => sheet(f.creator, { from: "2026-09-01", to: "2026-09-30" }), /unknown report fields/);
      await assert.rejects(() => sheet(f.creator, {}), /choose one: a period, a date range or an as-of date/);
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
        VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `RC2-${other.slice(0, 8)}`]);
      await db.h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'OTHER-1','Synthetic foreign account','ASSET',NULL,true,'USD','ACTIVE')`, [randomUUID(), other]);
      assertAbsent(await sheet(f.creator), ["Synthetic foreign account"], "this company's balance sheet");
      const count = async () => (await db.h.pool.query<{ j: string; l: string }>("SELECT (SELECT count(*) FROM abos.journals)::text j, (SELECT count(*) FROM abos.journal_lines)::text l")).rows[0];
      const before = await count();
      await sheet(f.creator); await income(f.creator);
      assert.deepEqual(await count(), before, "no closing journal, no retained earnings entry");
    });

    test("a year that is closed moves to earlier years' result on the next year's balance sheet, with no journal", async () => {
      const year = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','سال مالی ۲۰۲۶','2026-01-01','2026-12-31',$3)`, [year, f.e, f.u]);
      const before = await sheet(f.creator, { fiscalYearId: year });
      await db.call("finance_financial_year_close", f.manager, { fiscalYearId: year, correlationId: randomUUID() });
      assert.deepEqual([(await sheet(f.creator, { fiscalYearId: year })).totalEquity, before.validation.balanced], [before.totalEquity, true]);
      const later = await sheet(f.creator, { asOf: "2027-03-31" });
      assert.deepEqual([Number(later.earlierYearsResult), Number(later.currentYearResult), later.validation.balanced], [800, 0, true]);
      assert.equal(later.totalEquity, before.totalEquity, "equity is unchanged: the result only moved from one line to the other");
    });
  });
}
