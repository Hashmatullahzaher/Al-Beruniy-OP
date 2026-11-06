import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { addSyntheticSaraf } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, keys, ReportDatabase, SEPT, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Migration 0064: a foreign-currency Treasury account carries weighted-average value, derived from posted movements, so native zero
 * always means carrying zero. Each case takes its own new account, so no case depends on another's balance. The tests run in order on
 * purpose: the same-rate and transfer cases finish before any FX account exists, which is the proof ordinary postings never need one.
 * Rates are USD 1 = this many AFN, so a lower number is a stronger AFN.
 */

type Line = { account: string; debit: string; credit: string; party: string | null; project: string | null };
type Posted = { journalId: string; movementId: string; baseAmount: string; carryingAmount: string; realizedFx: string; replayed: boolean };
type Expense = { expense: { id: string; journalId: string; baseAmount: string; treasuryCarryingAmount: string; realizedFx: string | null; status: string }; replayed: boolean };
type Repaid = { repaymentId: string; journalId: string; baseAmount: string; carryingAmount: string; treasuryCarryingAmount: string; realizedFx: string };
type StatementLine = { baseAmount: string; runningBase: string; balance: string; fx: { transactionBaseAmount: string } | null };
type Statement = { statement: { closing: { native: string; base: string }; carryingStatus: string; lines: StatementLine[]; reconciliation: { matches: boolean } } };
type Income = { totalIncome: string; totalExpenses: string; netResult: string };
type Summary = { profit: { income: string; expenses: string; realizedFxGain: string; realizedFxLoss: string; netResult: string }; reconciliation: { matches: boolean } };

const LOAN = "2520";
const GAIN = "4910";
const LOSS = "5910";
const EXPENSE = "SYN-RW-EXP";
const INCOME = "SYN-RW-INC";
const PAYABLE = "SYN-RW-PAY";
const AT_70 = "2026-09-14";
const AT_70_LATER = "2026-09-15";
const AT_80 = "2026-09-20";
const AT_50 = "2026-09-21";
const AT_64 = "2026-09-22";
const AT_56 = "2026-09-23";
const AT_40 = "2026-09-24";

if (databaseUrl() === undefined) {
  test("0064 Treasury carrying value", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0064: foreign-currency Treasury carrying value", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let officer: Session; let serial = 0;

    const rate = (day: string, value: string) => db.h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
      VALUES ($1,$2,$3,'MARKET','USD','AFN',$4,'Synthetic rate',$5)`, [randomUUID(), f.e, day, value, f.u]);
    /** A new account, with its own ledger, so a case starts from nothing. Returns its id and ledger code. */
    const account = async (type = "SAFE") => {
      const code = `AFN-${++serial}`;
      const control = type === "SARAF" ? "SARAF" : "CASH";
      const ledgerId = await db.ledger(f.e, code, "ASSET", control, "AFN");
      const saraf = type === "SARAF" ? await addSyntheticSaraf(db.h.executor, f.world, `Synthetic AFN Saraf ${serial}`) : null;
      return { id: await db.treasury(f.world, `Synthetic ${code}`, type, "AFN", ledgerId, saraf), code };
    };
    const lines = async (journal: string | null | undefined) => (await db.h.pool.query<Line>(`SELECT a.account_code AS account, l.base_debit::text AS debit, l.base_credit::text AS credit,
      l.business_party_id AS party, l.project_id AS project FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const shape = async (journal: string | null | undefined) => (await lines(journal)).map((l) => [l.account, Number(l.debit), Number(l.credit)]);
    const receive = (id: string, amount: string, businessDate: string, extra: object = {}) => db.call<Posted>("treasury_receipt_record", officer, { treasuryAccountId: id, amount, currencyCode: "AFN", businessDate,
      payerBusinessPartyId: null, payerName: "Synthetic AFN payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys(), ...extra });
    const spend = (id: string, amount: string, businessDate: string, extra: object = {}, s: Session = officer) => db.call<Expense>("operational_expense_create", s, { treasuryAccountId: id, expenseCategoryId: f.category,
      payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "FX-EXP", description: "Synthetic AFN expense", note: null, businessDate, originalAmount: amount, currencyCode: "AFN",
      exchangeRateId: null, ...keys(), ...extra });
    const pay = (id: string, amount: string, businessDate: string) => db.call<Posted>("treasury_payment_record", officer, { treasuryAccountId: id, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null,
      payableLedgerAccountId: f.payable, amount, currencyCode: "AFN", businessDate, reference: null, note: null, ...keys() });
    const move = (from: string, to: string, amount: string, businessDate: string) => db.call<Posted>("treasury_transfer_record", officer, { sourceTreasuryAccountId: from, destinationTreasuryAccountId: to, amount,
      currencyCode: "AFN", businessDate, reference: null, note: null, ...keys() });
    const borrow = (id: string, amount: string, businessDate: string, extra: object = {}) => db.call<{ loanId: string; journalId: string }>("finance_loan_record", officer, { lenderType: "COMPANY", lenderName: "Synthetic FX Bank",
      treasuryAccountId: id, currencyCode: "AFN", amount, businessDate, reference: null, note: null, ...keys(), ...extra });
    const repay = (loanId: string, id: string, amount: string, businessDate: string, extra: object = {}) => db.call<Repaid>("finance_loan_repay", officer, { loanId, treasuryAccountId: id, amount, businessDate, reference: null, note: null, ...keys(), ...extra });
    const reverse = (journalId: string | null | undefined, reason = "Synthetic correction of this movement") => db.call<{ reversalJournalId: string }>("finance_journal_reversal_direct", officer, { journalId, reason, ...keys() });
    const statement = async (id: string, asOf = "2026-09-30") => (await db.call<Statement>("treasury_account_statement", officer, { accountId: id, asOf })).statement;
    const held = async (id: string, asOf = "2026-09-30") => { const s = await statement(id, asOf); return [Number(s.closing.native), Number(s.closing.base)]; };
    const owed = async (id: string) => {
      const row = (await db.call<{ loans: { id: string; outstanding: string; baseOutstanding: string }[] }>("finance_loan_workspace", officer)).loans.find((l) => l.id === id);
      assert.ok(row);
      return [Number(row.outstanding), Number(row.baseOutstanding)];
    };
    const income = async (): Promise<[number, number, number]> => { const v = await db.call<Income>("finance_income_statement", officer, SEPT); return [Number(v.totalIncome), Number(v.totalExpenses), Number(v.netResult)]; };
    const count = async (sql: string, ...values: unknown[]) => Number((await db.h.pool.query<{ n: string }>(sql, values)).rows[0]?.n);
    const journals = () => count("SELECT count(*)::text AS n FROM abos.journals WHERE legal_entity_id = $1", f.e);

    before(async () => {
      await db.open();
      f = await db.company();
      await db.ledger(f.e, LOAN, "LIABILITY", "LOAN_PAYABLE");
      officer = await db.person(f.world, "Treasury FX Officer", ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record", "treasury.opening-balance.record",
        "finance.expense.create", "finance.expense.read", "finance.report.operational.read", "finance.reversal.direct", "finance.fx-policy.manage", "finance.loan.read", "finance.loan.record", "finance.loan.repay"]);
      await db.call("finance_fx_policy_set", officer, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
        reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
      await rate(AT_80, "80"); await rate(AT_50, "50"); await rate(AT_64, "64"); await rate(AT_56, "56"); await rate(AT_40, "40");
    });
    after(async () => { await db.close(); });

    // ---------------------------------------------------------------- no FX account exists yet
    test("1. AFN in and out at one rate: native 0, base 0, two lines, and no FX account is needed", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const out = await spend(safe.id, "7000.00", AT_70_LATER);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 100, 0], [safe.code, 0, 100]]);
      assert.deepEqual(await held(safe.id), [0, 0]);
      assert.equal(Number(out.expense.realizedFx), 0);
    });

    test("3. a part at the same rate leaves the proportional value behind, with no FX", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const out = await spend(safe.id, "2100.00", AT_70_LATER);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 30, 0], [safe.code, 0, 30]]);
      assert.deepEqual(await held(safe.id), [4900, 70]);
    });

    test("rounding alone realizes nothing on a part: one smallest unit stays in the position", async () => {
      const safe = await account();
      await receive(safe.id, "100.00", AT_70);
      assert.deepEqual(await held(safe.id), [100, 1.43]);
      const out = await spend(safe.id, "50.00", AT_70_LATER);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 0.71, 0], [safe.code, 0, 0.71]], "the formula says 0.72 and the day's value 0.71: a rounding gap, not a loss");
      assert.deepEqual(await held(safe.id), [50, 0.72]);
    });

    test("11. a transfer moves native and carrying value together, whatever the day's rate, with no FX", async () => {
      const [a, b] = [await account(), await account()];
      await receive(a.id, "7000.00", AT_70);
      const t = await move(a.id, b.id, "7000.00", AT_80);
      assert.deepEqual(await shape(t.journalId), [[b.code, 100, 0], [a.code, 0, 100]], "87.50 at the day's rate plays no part");
      assert.deepEqual([Number(t.baseAmount), Number(t.carryingAmount), Number(t.realizedFx)], [87.5, 100, 0]);
      assert.deepEqual([await held(a.id), await held(b.id)], [[0, 0], [7000, 100]]);
    });

    test("15. a gain with no gain account is refused, and nothing is written", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const before = await journals();
      await assert.rejects(() => spend(safe.id, "7000.00", AT_56), /REALIZED_FX_GAIN_ACCOUNT_REQUIRED/);
      assert.equal(await journals(), before);
      assert.deepEqual(await held(safe.id), [7000, 100]);
      assert.equal(await count("SELECT count(*)::text AS n FROM abos.operational_expenses WHERE operational_treasury_account_id = $1", safe.id), 0);
    });

    test("16. a loss with no loss account is refused, even when the gain account exists", async () => {
      await db.ledger(f.e, GAIN, "REVENUE", "REALIZED_FX_GAIN");
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const before = await journals();
      await assert.rejects(() => pay(safe.id, "7000.00", AT_80), /REALIZED_FX_LOSS_ACCOUNT_REQUIRED/);
      assert.equal(await journals(), before);
      await db.ledger(f.e, LOSS, "EXPENSE", "REALIZED_FX_LOSS");
    });

    // ---------------------------------------------------------------- both FX accounts exist from here
    test("2. the same AFN disposed of at a changed rate: native 0, base 0, and the expense keeps its day's value", async () => {
      const safe = await account();
      await receive(safe.id, "70000.00", AT_70);
      const before = await income();
      const out = await spend(safe.id, "70000.00", AT_56);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 1250, 0], [safe.code, 0, 1000], [GAIN, 0, 250]], "a stronger AFN: 70,000 buys more than it cost, so the holding gained");
      assert.deepEqual([Number(out.expense.baseAmount), Number(out.expense.treasuryCarryingAmount), Number(out.expense.realizedFx)], [1250, 1000, 250]);
      assert.deepEqual(await held(safe.id), [0, 0]);
      const after = await income();
      assert.deepEqual([after[0] - before[0], after[1] - before[1], after[2] - before[2]], [250, 1250, -1000], "the net cost is what the AFN cost: 1,000");

      const weak = await account();
      await receive(weak.id, "70000.00", AT_70);
      const worse = await spend(weak.id, "70000.00", AT_80);
      assert.deepEqual(await shape(worse.expense.journalId), [[EXPENSE, 875, 0], [weak.code, 0, 1000], [LOSS, 125, 0]], "a weaker AFN: the holding lost");
      assert.deepEqual(await held(weak.id), [0, 0]);
    });

    test("4. several receipts at different rates carry their weighted average", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      await receive(safe.id, "5000.00", AT_50);
      assert.deepEqual(await held(safe.id), [12000, 200], "7,000 at 70 and 5,000 at 50 are 100 each");
      const out = await spend(safe.id, "6000.00", AT_56);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 107.14, 0], [safe.code, 0, 100], [GAIN, 0, 7.14]], "half the AFN takes half the value, whichever receipt it came from");
      assert.deepEqual(await held(safe.id), [6000, 100]);
    });

    test("5. several partial disposals at different rates each take the current average", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      await receive(safe.id, "7000.00", AT_50);
      assert.deepEqual(await held(safe.id), [14000, 240]);
      const first = await spend(safe.id, "3500.00", AT_64);
      assert.deepEqual(await shape(first.expense.journalId), [[EXPENSE, 54.69, 0], [safe.code, 0, 60], [LOSS, 5.31, 0]]);
      assert.deepEqual(await held(safe.id), [10500, 180]);
      const second = await spend(safe.id, "3500.00", AT_56);
      assert.deepEqual(await shape(second.expense.journalId), [[EXPENSE, 62.5, 0], [safe.code, 0, 60], [GAIN, 0, 2.5]]);
      const last = await spend(safe.id, "7000.00", AT_40);
      assert.deepEqual(await shape(last.expense.journalId), [[EXPENSE, 175, 0], [safe.code, 0, 120], [GAIN, 0, 55]]);
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("6. the final disposal clears the exact rounding residue", async () => {
      const safe = await account();
      await receive(safe.id, "10000.00", AT_70);
      assert.deepEqual(await held(safe.id), [10000, 142.86]);
      await spend(safe.id, "3333.00", AT_80);
      await spend(safe.id, "3333.00", AT_50);
      const before = await held(safe.id);
      assert.equal(before[0], 3334);
      const last = await spend(safe.id, "3334.00", AT_64);
      assert.equal(Number((await lines(last.expense.journalId))[1]?.credit), before[1], "exactly what remained");
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("7. an expense and a payment at a changed rate: each clears at its day's value, and the FX line keeps the expense's project", async () => {
      const safe = await account();
      await receive(safe.id, "14000.00", AT_70);
      const out = await spend(safe.id, "7000.00", AT_56, { projectId: f.project }, f.creator);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 125, 0], [safe.code, 0, 100], [GAIN, 0, 25]]);
      assert.deepEqual((await lines(out.expense.journalId)).map((l) => l.project), [f.project, f.project, f.project]);
      const paid = await pay(safe.id, "7000.00", AT_40);
      assert.deepEqual(await shape(paid.journalId), [[PAYABLE, 175, 0], [safe.code, 0, 100], [GAIN, 0, 75]]);
      assert.deepEqual([Number(paid.baseAmount), Number(paid.carryingAmount), Number(paid.realizedFx)], [175, 100, 75]);
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("8. AFN borrowed and repaid from the same basis realizes nothing, at any rate: the asset and the liability offset", async () => {
      const safe = await account();
      const loan = await borrow(safe.id, "7000.00", AT_70);
      const paid = await repay(loan.loanId, safe.id, "7000.00", AT_56);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 100, 0], [safe.code, 0, 100]]);
      assert.deepEqual([Number(paid.baseAmount), Number(paid.carryingAmount), Number(paid.treasuryCarryingAmount), Number(paid.realizedFx)], [125, 100, 100, 0]);
      assert.deepEqual([await owed(loan.loanId), await held(safe.id)], [[0, 0], [0, 0]]);
    });

    test("9. a partial repayment from AFN that cost more realizes the difference between the two carrying values", async () => {
      const [lent, dear] = [await account(), await account()];
      const loan = await borrow(lent.id, "7000.00", AT_70);
      await receive(dear.id, "7000.00", AT_50);
      const paid = await repay(loan.loanId, dear.id, "3500.00", AT_64);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 50, 0], [dear.code, 0, 70], [LOSS, 20, 0]]);
      assert.deepEqual([await owed(loan.loanId), await held(dear.id)], [[3500, 50], [3500, 70]]);
    });

    test("10. the final repayment clears the liability's native and base and leaves the Treasury account correct", async () => {
      const [lent, cheap] = [await account(), await account()];
      const loan = await borrow(lent.id, "10000.00", AT_70);
      await receive(cheap.id, "10000.00", AT_80);
      assert.deepEqual([await owed(loan.loanId), await held(cheap.id)], [[10000, 142.86], [10000, 125]]);
      const part = await repay(loan.loanId, cheap.id, "3000.00", AT_64);
      assert.deepEqual(await shape(part.journalId), [[LOAN, 42.86, 0], [cheap.code, 0, 37.5], [GAIN, 0, 5.36]]);
      const last = await repay(loan.loanId, cheap.id, "7000.00", AT_56);
      assert.deepEqual(await shape(last.journalId), [[LOAN, 100, 0], [cheap.code, 0, 87.5], [GAIN, 0, 12.5]]);
      assert.deepEqual([await owed(loan.loanId), await held(cheap.id)], [[0, 0], [0, 0]]);
      const s = await db.call<{ closing: { native: string; base: string }; realizedFx: string; lines: { kind: string; treasuryBaseAmount: string; transactionBaseAmount: string | null }[] }>("finance_loan_statement", officer, { loanId: loan.loanId, asOf: "2026-09-30" });
      assert.deepEqual([Number(s.closing.native), Number(s.closing.base), Number(s.realizedFx)], [0, 0, 17.86]);
      assert.deepEqual(s.lines.filter((l) => l.kind === "REPAYMENT").map((l) => [Number(l.treasuryBaseAmount), Number(l.transactionBaseAmount)]), [[37.5, 46.88], [87.5, 125]], "carrying value and the day's value are two figures");
    });

    test("12. a transfer followed by a disposal realizes against the carrying value that moved", async () => {
      const [a, b] = [await account(), await account()];
      await receive(a.id, "10000.00", AT_70);
      const t = await move(a.id, b.id, "3000.00", AT_80);
      assert.deepEqual(await shape(t.journalId), [[b.code, 42.86, 0], [a.code, 0, 42.86]]);
      assert.deepEqual([await held(a.id), await held(b.id)], [[7000, 100], [3000, 42.86]]);
      const out = await spend(b.id, "3000.00", AT_56);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 53.57, 0], [b.code, 0, 42.86], [GAIN, 0, 10.71]]);
      assert.deepEqual(await held(b.id), [0, 0]);
    });

    test("13. reversing an outflow restores the exact prior state from the posted lines alone, whatever came after it", async () => {
      const safe = await account();
      await receive(safe.id, "10000.00", AT_70);
      const first = await spend(safe.id, "3000.00", AT_56);
      const afterFirst = await held(safe.id);
      const second = await spend(safe.id, "7000.00", AT_40);
      assert.deepEqual(await held(safe.id), [0, 0]);
      const undone = await reverse(second.expense.journalId);
      assert.deepEqual(await shape(undone.reversalJournalId), (await shape(second.expense.journalId)).map(([a, d, c]) => [a, c, d]), "every line is the exact inverse");
      assert.deepEqual(await held(safe.id), afterFirst);
      const undoneFirst = await reverse(first.expense.journalId);
      assert.deepEqual(await shape(undoneFirst.reversalJournalId), (await shape(first.expense.journalId)).map(([a, d, c]) => [a, c, d]));
      assert.deepEqual(await held(safe.id), [10000, 142.86]);
      assert.equal(await count(`SELECT COALESCE(sum(l.base_credit - l.base_debit), 0)::text AS n FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id
        WHERE l.journal_id = ANY($1::uuid[]) AND a.control_account_type IN ('REALIZED_FX_GAIN', 'REALIZED_FX_LOSS')`, [first.expense.journalId, second.expense.journalId, undone.reversalJournalId, undoneFirst.reversalJournalId]), 0, "the FX went out with its movement");
    });

    test("an earlier outflow reverses exactly even with a later one standing: it recalculates nothing, and the later journal is untouched", async () => {
      const safe = await account();
      await receive(safe.id, "10000.00", AT_70);
      const first = await spend(safe.id, "3000.00", AT_56);
      const second = await spend(safe.id, "7000.00", AT_40);
      const posted = await shape(second.expense.journalId);
      const undone = await reverse(first.expense.journalId);
      assert.deepEqual(await shape(undone.reversalJournalId), [[EXPENSE, 0, 53.57], [safe.code, 42.86, 0], [GAIN, 10.71, 0]]);
      assert.deepEqual(await held(safe.id), [3000, 42.86], "exactly what that journal removed comes back");
      assert.deepEqual(await shape(second.expense.journalId), posted);
    });

    test("a reversal copies stored amounts and converts nothing", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const out = await spend(safe.id, "7000.00", AT_56);
      const undone = await reverse(out.expense.journalId);
      assert.deepEqual(await shape(undone.reversalJournalId), [[EXPENSE, 0, 125], [safe.code, 100, 0], [GAIN, 25, 0]]);
      assert.equal(await count(`SELECT count(*)::text AS n FROM abos.fx_conversions WHERE source_id = $1`, undone.reversalJournalId), 0, "a reversal converts nothing");
    });

    test("the one reversal refused: money already spent cannot be un-received, because that would orphan a value", async () => {
      const safe = await account();
      const first = await receive(safe.id, "7000.00", AT_70);
      const other = await receive(safe.id, "7000.00", AT_50);
      const out = await spend(safe.id, "7000.00", AT_56);
      assert.deepEqual(await held(safe.id), [7000, 120]);
      const before = await journals();
      await assert.rejects(() => reverse(first.journalId), /TREASURY_LATER_MOVEMENT/, "native 0 with 20 left is the orphan the rule forbids");
      await assert.rejects(() => reverse(other.journalId), /TREASURY_LATER_MOVEMENT/, "native 0 with minus 20 left");
      assert.equal(await journals(), before, "refused before anything is written");
      const blocked = await db.call<{ journals: { id: string; blocker: string | null }[] }>("finance_journal_reversal_workspace", officer);
      assert.equal(blocked.journals.find((j) => j.id === first.journalId)?.blocker, "LATER_TREASURY_MOVEMENT");
      await reverse(out.expense.journalId);
      await reverse(other.journalId);
      await reverse(first.journalId);
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("a receipt reverses with later spending standing when a valid position remains", async () => {
      const safe = await account();
      const first = await receive(safe.id, "7000.00", AT_70);
      await receive(safe.id, "7000.00", AT_50);
      await spend(safe.id, "3500.00", AT_56);
      assert.deepEqual(await held(safe.id), [10500, 180]);
      await reverse(first.journalId);
      assert.deepEqual(await held(safe.id), [3500, 80], "the exact inverse, and the next full disposal realizes the rest");
      await spend(safe.id, "3500.00", AT_40);
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("14. reversing a transfer restores both accounts exactly, and money spent at the destination cannot be pulled back", async () => {
      const [a, b] = [await account(), await account()];
      await receive(a.id, "10000.00", AT_70);
      const t = await move(a.id, b.id, "3000.00", AT_80);
      const out = await spend(b.id, "1000.00", AT_56);
      await assert.rejects(() => reverse(t.journalId), /not enough money/, "the Safe guard refuses first");
      await reverse(out.expense.journalId);
      const undone = await reverse(t.journalId);
      assert.deepEqual(await shape(undone.reversalJournalId), [[b.code, 0, 42.86], [a.code, 42.86, 0]]);
      assert.deepEqual([await held(a.id), await held(b.id)], [[10000, 142.86], [0, 0]]);
    });

    test("a movement dated behind others is allowed unless it would break the rule on a later day", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      await spend(safe.id, "1000.00", AT_50);
      await receive(safe.id, "500.00", AT_70_LATER);
      assert.deepEqual((await held(safe.id))[0], 6500, "a late receipt only adds");
      const mixed = await account();
      await receive(mixed.id, "7000.00", AT_70);
      await receive(mixed.id, "7000.00", AT_50);
      await spend(mixed.id, "10500.00", AT_56);
      assert.deepEqual(await held(mixed.id), [3500, 60]);
      const before = await journals();
      await assert.rejects(() => spend(mixed.id, "3500.00", AT_70_LATER), /TREASURY_FX_OUT_OF_ORDER/, "it would take 50 on that day and leave native 0 with 10 left on the last");
      assert.equal(await journals(), before);
      await spend(mixed.id, "3500.00", AT_40);
      assert.deepEqual(await held(mixed.id), [0, 0]);
      const later = await account();
      await receive(later.id, "7000.00", AT_56);
      await receive(later.id, "7000.00", AT_70);
      assert.deepEqual(await held(later.id, AT_70), [7000, 100]);
      await spend(later.id, "7000.00", AT_50);
      assert.deepEqual(await held(later.id, AT_50), [0, 0], "only what was held on that day takes part");
      assert.deepEqual(await held(later.id), [7000, 125]);
    });

    test("an opening balance starts a position, and cannot land on an amount already owed at another value", async () => {
      const safe = await account();
      await db.call("treasury_opening_balance_record", officer, { treasuryAccountId: safe.id, amount: "7000.00", currencyCode: "AFN", asOfDate: AT_70, reference: null, note: null, ...keys() });
      assert.deepEqual(await held(safe.id), [7000, 100]);
      const out = await spend(safe.id, "7000.00", AT_56);
      assert.deepEqual(await shape(out.expense.journalId), [[EXPENSE, 125, 0], [safe.code, 0, 100], [GAIN, 0, 25]]);
      const owing = await account("SARAF");
      await pay(owing.id, "7000.00", AT_70);
      await assert.rejects(() => db.call("treasury_opening_balance_record", officer, { treasuryAccountId: owing.id, amount: "7000.00", currencyCode: "AFN", asOfDate: AT_56, reference: null, note: null, ...keys() }), /TREASURY_FX_OPENING_ORDER/);
    });

    test("17. an idempotent replay returns the same journal and posts nothing more, and a different payload on the key is refused", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const request = keys();
      const first = await db.call<Posted>("treasury_payment_record", officer, { treasuryAccountId: safe.id, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null, payableLedgerAccountId: f.payable,
        amount: "3500.00", currencyCode: "AFN", businessDate: AT_56, reference: null, note: null, ...request });
      const count1 = await journals();
      const again = await db.call<Posted>("treasury_payment_record", officer, { treasuryAccountId: safe.id, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null, payableLedgerAccountId: f.payable,
        amount: "3500.00", currencyCode: "AFN", businessDate: AT_56, reference: null, note: null, ...request });
      assert.equal(again.journalId, first.journalId);
      assert.equal(again.realizedFx, first.realizedFx);
      assert.equal(await journals(), count1);
      await assert.rejects(() => db.call("treasury_payment_record", officer, { treasuryAccountId: safe.id, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null, payableLedgerAccountId: f.payable,
        amount: "1000.00", currencyCode: "AFN", businessDate: AT_56, reference: null, note: null, ...request }), /already used|different/i);
      const expenseKeys = keys();
      const out = await spend(safe.id, "1000.00", AT_56, expenseKeys);
      const replayed = await spend(safe.id, "1000.00", AT_56, expenseKeys);
      assert.equal(replayed.expense.journalId, out.expense.journalId);
      assert.equal(replayed.replayed, true);
    });

    test("18. concurrent disposals and repayments never remove the same carrying value twice", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const race = await Promise.allSettled([spend(safe.id, "5000.00", AT_56), spend(safe.id, "5000.00", AT_56), spend(safe.id, "5000.00", AT_56)]);
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
      for (const x of race) if (x.status === "rejected") assert.match(String(x.reason), /not enough money/);
      assert.deepEqual(await held(safe.id), [2000, 28.57], "one winner took 71.43");

      const shared = await account();
      const loan = await borrow(shared.id, "4000.00", AT_70);
      await receive(shared.id, "4000.00", AT_70_LATER);
      const mixed = await Promise.allSettled([repay(loan.loanId, shared.id, "4000.00", AT_56), spend(shared.id, "4000.00", AT_56), pay(shared.id, "4000.00", AT_56)]);
      assert.equal(mixed.filter((x) => x.status === "fulfilled").length, 2, "8,000 is held, so two of the three fit");
      assert.deepEqual(await held(shared.id), [0, 0], "and the two together took exactly all of it");
    });

    test("19. a report reader sees the realized figure and nothing about where it came from", async () => {
      const [lent, dear] = [await account(), await account()];
      const loan = await borrow(lent.id, "7000.00", AT_70, { lenderName: "Synthetic Hidden Treasury Lender", reference: "TFX-PRIVATE-REF", note: "Private lender note" });
      await receive(dear.id, "7000.00", AT_50);
      const paid = await repay(loan.loanId, dear.id, "3500.00", AT_64, { reference: "TFX-REPAY-REF", note: "Private repayment note" });
      const reader = f.reportReader;
      const forbidden = ["Synthetic Hidden Treasury Lender", "TFX-PRIVATE-REF", "TFX-REPAY-REF", "Private lender note", "Private repayment note", loan.loanId, paid.repaymentId];
      const views = [await db.call("finance_trial_balance", reader, SEPT), await db.call("finance_income_statement", reader, SEPT), await db.call("finance_balance_sheet", reader, { asOf: "2026-09-30" }),
        await db.call("finance_management_summary", reader, SEPT), await db.call("treasury_account_statement", reader, { accountId: dear.id, asOf: "2026-09-30" }), await db.call("finance_journal_detail", reader, paid.journalId)];
      for (const view of views) assertAbsent(view, forbidden, "a report reader");
      assert.equal((await lines(paid.journalId))[2]?.party, null, "the FX line names no lender");

      // A movement outside the reader's scope keeps its mathematics and nothing else, in the raw response.
      const scoped = await account();
      await receive(scoped.id, "14000.00", AT_70);
      const hidden = await spend(scoped.id, "7000.00", AT_56, { projectId: f.project, reference: "TFX-SECRET-REF", description: "Synthetic secret works" }, f.creator);
      const corrected = await spend(scoped.id, "3500.00", AT_56, { reference: "TFX-CORRECTED-REF" });
      await reverse(corrected.expense.journalId, "Synthetic private reversal reason");
      const raw = await db.call<Statement>("treasury_account_statement", reader, { accountId: scoped.id, asOf: "2026-09-30" });
      assertAbsent(raw, ["TFX-SECRET-REF", "Synthetic secret works", hidden.expense.id, hidden.expense.journalId, "Synthetic private reversal reason", f.project], "a reader outside the project");
      const row = raw.statement.lines.find((l) => Number(l.baseAmount) === -100) as unknown as { restricted: boolean; journalId: string | null; journalReference: string | null; fx: unknown; runningBase: string; source: unknown };
      assert.deepEqual([row.restricted, row.journalId, row.journalReference, row.fx], [true, null, null, null], "the day's value and rate go with the rest of the detail");
      assert.equal(Number(row.runningBase), 100, "the carrying figures stay, so the statement still adds up");
      assert.equal(raw.statement.reconciliation.matches, true);
      const [masked, full] = [await db.call<Income>("finance_income_statement", reader, SEPT), await db.call<Income>("finance_income_statement", officer, SEPT)];
      assert.deepEqual([masked.totalIncome, masked.totalExpenses, masked.netResult], [full.totalIncome, full.totalExpenses, full.netResult], "confidentiality never changes a figure");
    });

    test("20. another company reaches none of these accounts", async () => {
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Carrying Other','USD','APPROVED')`, [other, f.world.companyId, `TFX-${other.slice(0, 8)}`]);
      const stranger = await db.person({ ...f.world, legalEntityId: other }, "Foreign Treasury Officer", ["treasury.safe.read", "treasury.payment.record", "treasury.transfer.record", "finance.report.operational.read", "finance.reversal.direct"]);
      const safe = await account();
      const received = await receive(safe.id, "7000.00", AT_70);
      await assert.rejects(() => db.call("treasury_account_statement", stranger, { accountId: safe.id, asOf: "2026-09-30" }), /not found in this legal entity/);
      await assert.rejects(() => db.call("treasury_transfer_record", stranger, { sourceTreasuryAccountId: safe.id, destinationTreasuryAccountId: f.afnSafe, amount: "100.00", currencyCode: "AFN", businessDate: AT_56, reference: null, note: null, ...keys() }), /not found in this legal entity|not available|currency/i);
      await assert.rejects(() => db.call("finance_journal_reversal_direct", stranger, { journalId: received.journalId, reason: "Synthetic foreign reversal", ...keys() }), /journal not found/);
      assert.deepEqual(await held(safe.id), [7000, 100]);
    });

    test("22. native zero means carrying zero on every type of Treasury account", async () => {
      for (const type of ["SAFE", "CASH_BOX", "PETTY_CASH", "BANK", "SARAF", "OTHER"]) {
        const a = await account(type);
        await receive(a.id, "10000.00", AT_70);
        await pay(a.id, "3333.00", AT_80);
        await spend(a.id, "6667.00", AT_56);
        assert.deepEqual(await held(a.id), [0, 0], type);
      }
    });

    test("an account that owes this currency closes that position at its own value, so a receipt can realize too", async () => {
      const saraf = await account("SARAF");
      const first = await pay(saraf.id, "7000.00", AT_70);
      assert.deepEqual(await shape(first.journalId), [[PAYABLE, 100, 0], [saraf.code, 0, 100]], "from nothing, the amount owed starts at this movement's value");
      assert.deepEqual(await held(saraf.id), [-7000, -100]);
      const settled = await receive(saraf.id, "7000.00", AT_56);
      assert.deepEqual(await shape(settled.journalId), [[saraf.code, 100, 0], [INCOME, 0, 125], [LOSS, 25, 0]], "what was owed got dearer");
      assert.deepEqual(await held(saraf.id), [0, 0]);
    });

    test("a movement through zero closes the old position and opens the new one at this movement's value", async () => {
      const saraf = await account("SARAF");
      await receive(saraf.id, "7000.00", AT_70);
      const through = await pay(saraf.id, "10500.00", AT_56);
      assert.deepEqual(await shape(through.journalId), [[PAYABLE, 187.5, 0], [saraf.code, 0, 162.5], [GAIN, 0, 25]]);
      assert.deepEqual(await held(saraf.id), [-3500, -62.5]);
      const closed = await receive(saraf.id, "3500.00", AT_40);
      assert.deepEqual(await held(saraf.id), [0, 0]);
      assert.equal((await shape(closed.journalId)).length, 3);
    });

    test("money sent to settle what an account owes realizes the gap between the two positions, and an empty one simply takes it", async () => {
      const [safe, saraf] = [await account(), await account("SARAF")];
      await pay(saraf.id, "7000.00", AT_70);
      await receive(safe.id, "7000.00", AT_56);
      const t = await move(safe.id, saraf.id, "7000.00", AT_40);
      assert.deepEqual(await shape(t.journalId), [[saraf.code, 100, 0], [safe.code, 0, 125], [LOSS, 25, 0]]);
      assert.deepEqual([await held(safe.id), await held(saraf.id)], [[0, 0], [0, 0]]);
    });

    test("a Saraf gets the same check in both directions", async () => {
      const saraf = await account("SARAF");
      await pay(saraf.id, "7000.00", AT_80);
      assert.deepEqual(await held(saraf.id), [-7000, -87.5]);
      await assert.rejects(() => receive(saraf.id, "7000.00", AT_70_LATER), /TREASURY_FX_OUT_OF_ORDER/, "100 in on that day would leave native 0 with 12.50 left on the next");
      assert.deepEqual(await held(saraf.id), [-7000, -87.5]);
    });

    test("A. full disposal at a changed rate: both zero, the journal balances, FX is recognized once, and the Balance Sheet holds", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      const out = await spend(safe.id, "7000.00", AT_40);
      assert.deepEqual(await held(safe.id), [0, 0]);
      const posted = await shape(out.expense.journalId);
      assert.equal(posted.reduce((sum, [, debit]) => sum + Number(debit), 0), posted.reduce((sum, [, , credit]) => sum + Number(credit), 0), "the journal balances");
      assert.deepEqual(posted, [[EXPENSE, 175, 0], [safe.code, 0, 100], [GAIN, 0, 75]]);
      assert.equal(await count(`SELECT count(*)::text AS n FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id
        WHERE l.journal_id = $1 AND a.control_account_type IN ('REALIZED_FX_GAIN', 'REALIZED_FX_LOSS')`, out.expense.journalId), 1, "once");
      const sheet = await db.call<{ validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.deepEqual([sheet.validation.balanced, Number(sheet.validation.difference)], [true, 0]);
    });

    test("B. partial disposal: the remainder and the removal are proportional, and the last movement clears the exact residual", async () => {
      const safe = await account();
      await receive(safe.id, "10000.00", AT_70);
      const part = await spend(safe.id, "2500.00", AT_56);
      assert.equal(Number((await lines(part.expense.journalId))[1]?.credit), 35.72, "142.86 x 2,500 / 10,000, half up");
      assert.deepEqual(await held(safe.id), [7500, 107.14]);
      const last = await spend(safe.id, "7500.00", AT_40);
      assert.equal(Number((await lines(last.expense.journalId))[1]?.credit), 107.14, "exactly what remained");
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("C. a same-currency transfer moves native and the identical carrying value, and the company's total is unchanged", async () => {
      const [a, b] = [await account(), await account()];
      await receive(a.id, "10000.00", AT_70);
      const total = async () => (await held(a.id))[1]! + (await held(b.id))[1]!;
      const before = await total();
      const incomeBefore = await income();
      const t = await move(a.id, b.id, "2500.00", AT_40);
      const [source, destination] = [await held(a.id), await held(b.id)];
      assert.deepEqual([source[0], destination[0]], [7500, 2500]);
      assert.equal(Number((142.86 - source[1]!).toFixed(2)), destination[1], "the destination gains exactly what the source gave up");
      assert.equal(Number((await total()).toFixed(2)), before, "the company's carrying total is unchanged");
      assert.equal(Number(t.realizedFx), 0);
      assert.equal((await shape(t.journalId)).length, 2, "no FX line, no income, no expense");
      assert.deepEqual(await income(), incomeBefore);
    });

    test("so little value that it cannot be split moves in full", async () => {
      const safe = await account();
      await receive(safe.id, "1.00", AT_70);
      assert.deepEqual(await held(safe.id), [1, 0.01]);
      await assert.rejects(() => spend(safe.id, "0.50", AT_56), /TREASURY_DISPOSE_IN_FULL/);
      await spend(safe.id, "1.00", AT_56);
      assert.deepEqual(await held(safe.id), [0, 0]);
    });

    test("the Safe statement stays native first and keeps carrying value and the day's value as two figures", async () => {
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      await spend(safe.id, "3500.00", AT_56);
      const s = await statement(safe.id);
      assert.deepEqual(s.lines.map((l) => [Number(l.balance), Number(l.baseAmount), Number(l.runningBase), Number(l.fx?.transactionBaseAmount)]), [[7000, 100, 100, 100], [3500, -50, 50, 62.5]]);
      assert.equal(s.carryingStatus, "OK");
      assert.equal(s.reconciliation.matches, true);
    });

    test("21. every report agrees: realized FX counted once, and never as principal, income received or an operating cost", async () => {
      const before = await db.call<Summary>("finance_management_summary", officer, SEPT);
      const incomeBefore = await income();
      const safe = await account();
      await receive(safe.id, "7000.00", AT_70);
      await spend(safe.id, "7000.00", AT_56);
      const after = await db.call<Summary>("finance_management_summary", officer, SEPT);
      const incomeAfter = await income();
      assert.deepEqual([Number(after.profit.realizedFxGain) - Number(before.profit.realizedFxGain), Number(after.profit.income) - Number(before.profit.income), Number(after.profit.expenses) - Number(before.profit.expenses)],
        [25, 100, 125], "the receipt is income of 100, the expense 125, and the gain stands alone");
      assert.equal(incomeAfter[0] - incomeBefore[0], 125, "the Income Statement holds it once, as income");
      assert.equal(after.reconciliation.matches, true);
      assert.equal((Number(after.profit.income) + Number(after.profit.realizedFxGain) - Number(after.profit.expenses) - Number(after.profit.realizedFxLoss)).toFixed(2), Number(after.profit.netResult).toFixed(2));

      const tb = await db.call<{ balanced: boolean }>("finance_trial_balance", officer, SEPT);
      const sheet = await db.call<{ validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.deepEqual([tb.balanced, sheet.validation.balanced, Number(sheet.validation.difference)], [true, true, 0]);
      assert.equal(await count(`SELECT count(*)::text AS n FROM (
        SELECT t.id, COALESCE((SELECT sum(e.base_amount) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED'
                                WHERE e.subledger_type = 'OPERATIONAL_TREASURY' AND e.operational_treasury_account_id = t.id), 0) AS sub,
               COALESCE((SELECT sum(l.base_debit - l.base_credit) FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED' WHERE l.ledger_account_id = t.ledger_account_id), 0) AS led
          FROM abos.operational_treasury_accounts t WHERE t.legal_entity_id = $1) x WHERE sub <> led`, f.e), 0, "every Treasury subledger equals its ledger account");
      const liabilities = await count(`SELECT COALESCE(sum(l.base_credit) - sum(l.base_debit), 0)::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED'
        JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE j.legal_entity_id = $1 AND a.control_account_type = 'LOAN_PAYABLE'`, f.e);
      const register = (await db.call<{ loans: { baseOutstanding: string }[] }>("finance_loan_workspace", officer)).loans.reduce((total, l) => total + Number(l.baseOutstanding), 0);
      assert.equal(Number(register.toFixed(2)), Number(liabilities.toFixed(2)), "the loan register equals the liability account");
    });

    test("22, across all of the above: on no account, on no day, is there native zero with a value left", async () => {
      const orphans = await db.h.pool.query<{ account: string; day: string; base: string }>(`
        WITH days AS (SELECT DISTINCT e.operational_treasury_account_id AS account, j.accounting_effective_date AS day FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
                        JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED' WHERE e.subledger_type = 'OPERATIONAL_TREASURY' AND e.legal_entity_id = $1),
             position AS (SELECT d.account, d.day, p.native, p.carrying FROM days d CROSS JOIN LATERAL abos.treasury_carrying_position(d.account, d.day) p)
        SELECT p.account, p.day::text, p.carrying::text AS base FROM position p JOIN abos.operational_treasury_accounts t ON t.id = p.account
         WHERE t.currency_code <> 'USD' AND ((p.native = 0 AND p.carrying <> 0) OR sign(p.native) <> sign(p.carrying))`, [f.e]);
      assert.deepEqual(orphans.rows, []);
    });

    test("the registry allows the third line on the lanes that carry foreign currency, and no account appeared on its own", async () => {
      const sources = await db.h.pool.query<{ source_type: string }>("SELECT source_type FROM abos.posting_sources WHERE line_count_max = 3 ORDER BY 1");
      assert.deepEqual(sources.rows.map((r) => r.source_type), ["CASH_RECEIPT", "LOAN_RECEIPT", "LOAN_REPAYMENT", "OPERATIONAL_EXPENSE", "PAYMENT", "REVERSAL", "TREASURY_TRANSFER"]);
      const opening = await db.h.pool.query<{ line_count_max: number | null }>("SELECT line_count_max FROM abos.posting_sources WHERE source_type = 'OPENING_BALANCE'");
      assert.equal(opening.rows[0]?.line_count_max, null);
    });
  });
}
