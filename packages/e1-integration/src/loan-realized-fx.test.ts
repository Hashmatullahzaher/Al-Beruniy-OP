import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, keys, ReportDatabase, SEPT, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Migration 0063: a loan repayment removes carrying value, and the difference from the cash paid is a realized FX gain or loss in the same
 * journal. The tests run in order on purpose: the USD and same-rate cases finish before any FX account exists, which is the proof that
 * ordinary postings never need one. Rates are USD 1 = this many AFN.
 */

type Line = { account: string; debit: string; credit: string; party: string | null };
type Recorded = { loanId: string; journalId: string | null; status: string };
type Repaid = { repaymentId: string; journalId: string | null; status: string; replayed: boolean; baseAmount: string; carryingAmount?: string; realizedFx?: string };
type Loan = { id: string; outstanding: string; baseOutstanding: string };
type Statement = { closing: { native: string; base: string }; realizedFx: string; lines: { kind: string; baseAmount: string; treasuryBaseAmount: string | null; realizedFx: string }[];
  reconciliation: { matches: boolean } };
type Readiness = { accounts: { control: string; status: string }[]; permissions: Record<string, boolean>; canManageAccounts: boolean; canManageRoles: boolean };
type Income = { totalIncome: string; totalExpenses: string; netResult: string };

const LOAN = "2520";
const SHAREHOLDER_LOAN = "2510";
const GAIN = "4910";
const LOSS = "5910";
const AT_70 = "2026-09-14";
const AT_80 = "2026-09-20";
const AT_50 = "2026-09-21";
const AT_64 = "2026-09-22";

if (databaseUrl() === undefined) {
  test("0063 realized FX", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0063: realized FX on loan settlement", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let officer: Session; let approver: Session; let safeCode: string; let lossAccount: string;

    const ledger = async (code: string, type: string, control: string, currency: string | null = "USD") => {
      const id = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,'ACTIVE')`, [id, f.e, code, `Synthetic ${code}`, type, control, currency]);
      return id;
    };
    const rate = (day: string, value: string) => db.h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
      VALUES ($1,$2,$3,'MARKET','USD','AFN',$4,'Synthetic rate',$5)`, [randomUUID(), f.e, day, value, f.u]);
    const lines = async (journal: string | null | undefined) => (await db.h.pool.query<Line>(`SELECT a.account_code AS account, l.base_debit::text AS debit, l.base_credit::text AS credit, l.business_party_id AS party
      FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const shape = async (journal: string | null | undefined) => (await lines(journal)).map((l) => [l.account, Number(l.debit), Number(l.credit)]);
    const record = (payload: object) => db.call<Recorded>("finance_loan_record", officer, { lenderType: "COMPANY", lenderName: "Synthetic FX Bank", treasuryAccountId: f.afnSafe, currencyCode: "AFN",
      businessDate: AT_70, reference: null, note: null, ...keys(), ...payload });
    const afnLoan = (amount = "7000.00", extra: object = {}) => record({ amount, ...extra });
    const usdLoan = (amount: string) => record({ amount, treasuryAccountId: f.usdSafe, currencyCode: "USD" });
    const repay = (loanId: string, amount: string, businessDate: string, extra: object = {}, s: Session = officer) => db.call<Repaid>("finance_loan_repay", s, { loanId, treasuryAccountId: f.afnSafe, amount, businessDate,
      reference: null, note: null, ...keys(), ...extra });
    const reverse = (journalId: string | null, reason: string) => db.call<{ reversalJournalId: string }>("finance_journal_reversal_direct", officer, { journalId, reason, ...keys() });
    const statement = (loanId: string) => db.call<Statement>("finance_loan_statement", officer, { loanId, asOf: "2026-09-30" });
    const readiness = (s: Session = officer) => db.call<Readiness>("finance_loan_readiness", s);
    const position = async (id: string) => {
      const row = (await db.call<{ loans: Loan[] }>("finance_loan_workspace", officer)).loans.find((l) => l.id === id);
      assert.ok(row);
      return [Number(row.outstanding), Number(row.baseOutstanding)];
    };
    const income = async (): Promise<[number, number, number]> => { const v = await db.call<Income>("finance_income_statement", officer, SEPT); return [Number(v.totalIncome), Number(v.totalExpenses), Number(v.netResult)]; };
    const safeNative = async (account: string) => Number((await db.call<{ statement: { closing: { native: string } } }>("treasury_account_statement", officer, { accountId: account, asOf: "2026-09-30" })).statement.closing.native);
    const count = async (sql: string, ...values: unknown[]) => Number((await db.h.pool.query<{ n: string }>(sql, values)).rows[0]?.n);
    const journals = () => count("SELECT count(*)::text AS n FROM abos.journals WHERE legal_entity_id = $1", f.e);

    before(async () => {
      await db.open();
      f = await db.company();
      await ledger(SHAREHOLDER_LOAN, "LIABILITY", "SHAREHOLDER_LOAN", null);
      await ledger(LOAN, "LIABILITY", "LOAN_PAYABLE", null);
      officer = await db.person(f.world, "FX Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.report.operational.read", "finance.reversal.direct",
        "treasury.safe.read", "shareholder.read", "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "finance.capital-receipt.prepare",
        "finance.capital-receipt.post", "finance.fx-policy.manage", "treasury.opening-balance.record"]);
      approver = await db.person(f.world, "FX Approver", ["finance.loan.approve", "finance.loan.read"]);
      await db.call("finance_fx_policy_set", officer, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
        reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
      await rate(AT_80, "80"); await rate(AT_50, "50"); await rate(AT_64, "64");
      safeCode = (await db.h.pool.query<{ code: string }>("SELECT account_code AS code FROM abos.ledger_accounts WHERE id = $1", [f.afnLedger])).rows[0]?.code ?? "";
    });
    after(async () => { await db.close(); });

    test("the carrying share is exact: the final repayment takes what remains, and a part is never nothing or everything", async () => {
      const share = async (...args: unknown[]) => (await db.h.pool.query<{ n: string }>("SELECT abos.loan_carrying_share($1::numeric, $2::numeric, $3::numeric, $4::integer)::text AS n", args)).rows[0]?.n;
      assert.equal(Number(await share("142.86", "10000", "10000", 2)), 142.86, "the whole of what is owed removes the whole carrying value");
      assert.equal(Number(await share("142.86", "10000", "3000", 2)), 42.86, "half up at the policy's scale");
      assert.equal(Number(await share("0.05", "1000", "10", 2)), 0.01, "a part removes at least one smallest unit, never nothing");
      assert.equal(Number(await share("0.05", "1000", "999", 2)), 0.04, "a part leaves at least one smallest unit, never nothing");
      assert.equal(await share("1000000000000.01", "3", "1", 2).then((n) => Number(n).toFixed(2)), "333333333333.34", "no floating point: half up on the exact quotient");
      await assert.rejects(() => share("0.01", "1000", "10", 2), /LOAN_REPAY_IN_FULL/);
      await assert.rejects(() => share("100", "1000", "1001", 2), /within what is outstanding/);
    });

    test("1. USD loan receipt: two lines, Treasury and liability up, no income, and no FX account exists", async () => {
      assert.equal(await count("SELECT count(*)::text AS n FROM abos.ledger_accounts WHERE legal_entity_id = $1 AND control_account_type LIKE 'REALIZED_FX%'", f.e), 0);
      const before = await income();
      const r = await usdLoan("1000.00");
      assert.equal((await lines(r.journalId)).length, 2);
      assert.deepEqual(await income(), before);
      assert.deepEqual(await position(r.loanId), [1000, 1000]);
    });

    test("2. USD partial repayment: two lines, carrying equals the cash, and no difference", async () => {
      const r = await usdLoan("1000.00");
      const before = await income();
      const paid = await repay(r.loanId, "400.00", AT_70, { treasuryAccountId: f.usdSafe });
      assert.deepEqual((await shape(paid.journalId)).map((l) => [l[1], l[2]]), [[400, 0], [0, 400]]);
      assert.deepEqual([Number(paid.carryingAmount), Number(paid.realizedFx)], [400, 0]);
      assert.deepEqual(await income(), before, "principal is not an expense");
      assert.deepEqual(await position(r.loanId), [600, 600]);
    });

    test("3. USD full repayment clears both positions", async () => {
      const r = await usdLoan("1000.00");
      await repay(r.loanId, "400.00", AT_70, { treasuryAccountId: f.usdSafe });
      const paid = await repay(r.loanId, "600.00", AT_70, { treasuryAccountId: f.usdSafe });
      assert.equal((await lines(paid.journalId)).length, 2);
      assert.deepEqual(await position(r.loanId), [0, 0]);
    });

    test("4. AFN loan receipt keeps its native amount and its carrying value at the frozen rate", async () => {
      const before = await income();
      const r = await afnLoan();
      assert.deepEqual(await shape(r.journalId), [[safeCode, 100, 0], [LOAN, 0, 100]]);
      assert.deepEqual(await position(r.loanId), [7000, 100]);
      assert.deepEqual(await income(), before);
    });

    test("5. AFN partial repayment at the same rate: two lines, no difference, and no FX account is needed", async () => {
      const r = await afnLoan();
      const paid = await repay(r.loanId, "3500.00", AT_70);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 50, 0], [safeCode, 0, 50]]);
      assert.deepEqual(await position(r.loanId), [3500, 50]);
    });

    test("15. a gain with no gain account is refused before anything is written", async () => {
      const r = await afnLoan();
      const [journalsBefore, conversionsBefore] = [await journals(), await count("SELECT count(*)::text AS n FROM abos.fx_conversions WHERE legal_entity_id = $1", f.e)];
      await assert.rejects(() => repay(r.loanId, "3500.00", AT_80), /REALIZED_FX_GAIN_ACCOUNT_REQUIRED/);
      assert.equal(await journals(), journalsBefore);
      assert.equal(await count("SELECT count(*)::text AS n FROM abos.loan_repayments WHERE loan_id = $1", r.loanId), 0);
      assert.equal(await count("SELECT count(*)::text AS n FROM abos.fx_conversions WHERE legal_entity_id = $1", f.e), conversionsBefore, "no half-written conversion");
      assert.deepEqual(await position(r.loanId), [7000, 100]);
    });

    test("16. a loss with no loss account is refused, even when the gain account exists", async () => {
      const r = await afnLoan();
      await ledger(GAIN, "REVENUE", "REALIZED_FX_GAIN");
      const journalsBefore = await journals();
      await assert.rejects(() => repay(r.loanId, "3500.00", AT_50), /REALIZED_FX_LOSS_ACCOUNT_REQUIRED/);
      assert.equal(await journals(), journalsBefore);
      lossAccount = await ledger(LOSS, "EXPENSE", "REALIZED_FX_LOSS");
    });

    test("the two roles carry only their own account type, and two active accounts of one role are refused", async () => {
      const validate = (type: string, control: string) => db.h.pool.query("SELECT abos.coa_validate('X1', 'Synthetic', NULL, NULL, $1, $2, 'USD', true, 'ACTIVE')", [type, control]);
      await assert.rejects(() => validate("EXPENSE", "REALIZED_FX_GAIN"), /cannot have account type/);
      await assert.rejects(() => validate("REVENUE", "REALIZED_FX_LOSS"), /cannot have account type/);
      await validate("REVENUE", "REALIZED_FX_GAIN"); await validate("EXPENSE", "REALIZED_FX_LOSS");
      const second = await ledger("4911", "REVENUE", "REALIZED_FX_GAIN");
      const r = await afnLoan();
      await assert.rejects(() => repay(r.loanId, "3500.00", AT_80), /REALIZED_FX_ACCOUNT_INVALID/);
      assert.equal((await readiness()).accounts.find((a) => a.control === "REALIZED_FX_GAIN")?.status, "AMBIGUOUS");
      await db.h.pool.query("UPDATE abos.ledger_accounts SET status = 'INACTIVE' WHERE id = $1", [second]);
    });

    test("6. a partial repayment at a better rate realizes a gain, in the one journal", async () => {
      const r = await afnLoan();
      const before = await income();
      const paid = await repay(r.loanId, "3500.00", AT_80);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 50, 0], [safeCode, 0, 43.75], [GAIN, 0, 6.25]]);
      assert.deepEqual([Number(paid.baseAmount), Number(paid.carryingAmount), Number(paid.realizedFx)], [43.75, 50, 6.25]);
      assert.deepEqual(await position(r.loanId), [3500, 50]);
      const after = await income();
      assert.deepEqual([after[0] - before[0], after[1] - before[1], after[2] - before[2]], [6.25, 0, 6.25]);
    });

    test("7. a partial repayment at a worse rate realizes a loss, in the one journal", async () => {
      const r = await afnLoan();
      const before = await income();
      const paid = await repay(r.loanId, "3500.00", AT_50);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 50, 0], [safeCode, 0, 70], [LOSS, 20, 0]]);
      assert.deepEqual(await position(r.loanId), [3500, 50]);
      const after = await income();
      assert.deepEqual([after[0] - before[0], after[1] - before[1], after[2] - before[2]], [0, 20, -20]);
    });

    test("8 and 22. the final repayment clears native and base exactly, and the Balance Sheet keeps no residual", async () => {
      const r = await afnLoan();
      await repay(r.loanId, "3500.00", AT_80);
      const final = await repay(r.loanId, "3500.00", AT_50);
      assert.deepEqual(await shape(final.journalId), [[LOAN, 50, 0], [safeCode, 0, 70], [LOSS, 20, 0]]);
      assert.deepEqual(await position(r.loanId), [0, 0]);
      const s = await statement(r.loanId);
      assert.deepEqual([Number(s.closing.native), Number(s.closing.base), s.reconciliation.matches], [0, 0, true]);
      assert.equal(Number(s.realizedFx), -13.75, "a gain of 6.25 and a loss of 20");
      const sheet = await db.call<{ validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.deepEqual([sheet.validation.balanced, Number(sheet.validation.difference)], [true, 0]);
      const rows = await db.h.pool.query<{ native: string; base: string }>(`SELECT COALESCE(sum(e.original_amount), 0)::text AS native, COALESCE(sum(e.base_amount), 0)::text AS base
        FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE e.subledger_type = 'LOAN_PAYABLE' AND l.journal_id IN (SELECT journal_id FROM abos.loan_journals($1))`, [r.loanId]);
      assert.deepEqual([Number(rows.rows[0]?.native), Number(rows.rows[0]?.base)], [0, 0], "straight from the subledger, not through any report");
    });

    test("9. repayments at three rates, with a rounded carrying value, settle to exactly zero", async () => {
      const r = await afnLoan("10000.00");
      assert.deepEqual(await position(r.loanId), [10000, 142.86], "10,000 at 70 rounds to 142.86");
      const a = await repay(r.loanId, "3000.00", AT_80);
      assert.deepEqual(await shape(a.journalId), [[LOAN, 42.86, 0], [safeCode, 0, 37.5], [GAIN, 0, 5.36]]);
      assert.deepEqual(await position(r.loanId), [7000, 100]);
      const b = await repay(r.loanId, "3333.00", AT_50);
      assert.deepEqual(await shape(b.journalId), [[LOAN, 47.61, 0], [safeCode, 0, 66.66], [LOSS, 19.05, 0]]);
      assert.deepEqual(await position(r.loanId), [3667, 52.39]);
      const c = await repay(r.loanId, "3667.00", AT_64);
      assert.deepEqual(await shape(c.journalId), [[LOAN, 52.39, 0], [safeCode, 0, 57.3], [LOSS, 4.91, 0]]);
      assert.deepEqual(await position(r.loanId), [0, 0]);
      const s = await statement(r.loanId);
      assert.equal(Number(s.realizedFx).toFixed(2), "-18.60", "the sum of every difference is what came in less what went out: 142.86 - 161.46");
      assert.deepEqual(s.lines.filter((l) => l.kind === "REPAYMENT").map((l) => [Number(l.baseAmount), Number(l.treasuryBaseAmount), Number(l.realizedFx)]),
        [[42.86, 37.5, 5.36], [47.61, 66.66, -19.05], [52.39, 57.3, -4.91]]);
    });

    const inverted = async (original: string | null, reversal: string) => {
      const [a, b] = [await lines(original), await lines(reversal)];
      assert.deepEqual(b.map((l) => [l.account, Number(l.debit), Number(l.credit), l.party]), a.map((l) => [l.account, Number(l.credit), Number(l.debit), l.party]));
    };

    test("10. reversing a repayment with a gain is the exact inverse of its posted lines", async () => {
      const r = await afnLoan();
      const before = await income();
      const paid = await repay(r.loanId, "3500.00", AT_80);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 50, 0], [safeCode, 0, 43.75], [GAIN, 0, 6.25]]);
      const back = await reverse(paid.journalId, "Synthetic gain reversal");
      await inverted(paid.journalId, back.reversalJournalId);
      assert.deepEqual(await position(r.loanId), [7000, 100]);
      assert.deepEqual(await income(), before);
      const s = await statement(r.loanId);
      assert.equal(Number(s.realizedFx), 0);
      assert.equal(Number(s.lines.find((l) => l.kind === "REPAYMENT_REVERSAL")?.realizedFx), -6.25);
    });

    test("11. reversing a repayment with a loss is the exact inverse, and the loan can then settle afresh", async () => {
      const r = await afnLoan();
      const before = await income();
      const paid = await repay(r.loanId, "7000.00", AT_50);
      assert.deepEqual(await shape(paid.journalId), [[LOAN, 100, 0], [safeCode, 0, 140], [LOSS, 40, 0]]);
      const back = await reverse(paid.journalId, "Synthetic loss reversal");
      await inverted(paid.journalId, back.reversalJournalId);
      assert.deepEqual(await position(r.loanId), [7000, 100]);
      assert.deepEqual(await income(), before);
      await repay(r.loanId, "7000.00", AT_80);
      assert.deepEqual(await position(r.loanId), [0, 0], "out-of-order history still ends at zero");
    });

    test("a loan cannot be reversed while a repayment with FX stands, and can once it is reversed", async () => {
      const r = await afnLoan();
      const paid = await repay(r.loanId, "3500.00", AT_80);
      await assert.rejects(() => reverse(r.journalId, "Synthetic early reversal"), /reverse them before reversing the loan/);
      await reverse(paid.journalId, "Synthetic repayment reversal");
      await reverse(r.journalId, "Synthetic loan reversal");
      assert.deepEqual(await position(r.loanId), [0, 0]);
    });

    test("12. an idempotent replay returns the same journal and posts nothing more", async () => {
      const r = await afnLoan();
      const request = keys();
      const first = await repay(r.loanId, "3500.00", AT_80, request);
      const count1 = await journals();
      const again = await repay(r.loanId, "3500.00", AT_80, request);
      assert.deepEqual([again.repaymentId, again.journalId, again.realizedFx], [first.repaymentId, first.journalId, first.realizedFx]);
      assert.equal(await journals(), count1);
      assert.deepEqual(await position(r.loanId), [3500, 50]);
    });

    test("13. the same key with different economics is refused", async () => {
      const r = await afnLoan();
      const request = keys();
      await repay(r.loanId, "3500.00", AT_80, request);
      await assert.rejects(() => repay(r.loanId, "3400.00", AT_80, request), /idempotency|different/i, "another amount");
      await assert.rejects(() => repay(r.loanId, "3500.00", AT_50, request), /idempotency|different/i, "another date, so another rate");
      assert.deepEqual(await position(r.loanId), [3500, 50]);
    });

    test("14. concurrent repayments can over-settle neither the native nor the base liability", async () => {
      const r = await afnLoan();
      const results = await Promise.allSettled([repay(r.loanId, "5000.00", AT_80), repay(r.loanId, "5000.00", AT_50), repay(r.loanId, "5000.00", AT_64)]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      for (const x of results) if (x.status === "rejected") assert.match(String(x.reason), /cannot exceed what is outstanding/);
      const [native, base] = await position(r.loanId);
      assert.equal(native, 2000);
      assert.equal(Number(base?.toFixed(2)), 28.57, "the single winner removed 71.43 of carrying value");
      const race = await Promise.allSettled([repay(r.loanId, "2000.00", AT_80), repay(r.loanId, "2000.00", AT_50)]);
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1, "only one final repayment");
      assert.deepEqual(await position(r.loanId), [0, 0]);
    });

    test("a decision settles what is owed when it is made, and is refused whole if the account is no longer usable", async () => {
      const r = await afnLoan();
      const policy = (version: number, on: boolean) => db.h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES ($1,$2,'LOAN',$3,$4,$5,'Synthetic approval setting')`, [randomUUID(), f.e, version, on, f.u]);
      const decide = (id: string) => db.call<{ status: string; journalId: string | null }>("finance_loan_decide", approver, { kind: "REPAYMENT", id, decision: "APPROVED", reason: null, ...keys() });
      await policy(1, true);
      const first = await repay(r.loanId, "3500.00", AT_80);
      const second = await repay(r.loanId, "3500.00", AT_50);
      assert.deepEqual([first.status, first.journalId, first.realizedFx], ["PENDING_APPROVAL", null, undefined], "not known until posted");
      const rival = await ledger("4912", "REVENUE", "REALIZED_FX_GAIN");
      const before = await journals();
      await assert.rejects(() => decide(first.repaymentId), /REALIZED_FX_ACCOUNT_INVALID/);
      assert.equal(await journals(), before);
      assert.equal((await db.h.pool.query<{ status: string }>("SELECT status FROM abos.loan_repayments WHERE id = $1", [first.repaymentId])).rows[0]?.status, "PENDING_APPROVAL", "it waits, whole");
      await db.h.pool.query("UPDATE abos.ledger_accounts SET status = 'INACTIVE' WHERE id = $1", [rival]);
      // Approved out of order: the second is the first to post, so it is a part, and the first becomes the final one.
      const b = await decide(second.repaymentId);
      assert.deepEqual(await shape(b.journalId), [[LOAN, 50, 0], [safeCode, 0, 70], [LOSS, 20, 0]]);
      const a = await decide(first.repaymentId);
      assert.deepEqual(await shape(a.journalId), [[LOAN, 50, 0], [safeCode, 0, 43.75], [GAIN, 0, 6.25]]);
      assert.deepEqual(await position(r.loanId), [0, 0]);
      await policy(2, false);
    });

    test("17. a Safe that cannot cover the repayment is refused, FX or not, in its own currency", async () => {
      const r = await afnLoan();
      const empty = await db.treasury(f.world, "Synthetic empty AFN Safe", "SAFE", "AFN", await ledger("1190", "ASSET", "CASH", "AFN"));
      const before = await journals();
      await assert.rejects(() => repay(r.loanId, "3500.00", AT_80, { treasuryAccountId: empty }), /would fall below zero/);
      assert.equal(await journals(), before);
      assert.deepEqual(await position(r.loanId), [7000, 100]);
    });

    test("the Safe statement stays native first, with each movement's frozen base value", async () => {
      const opening = await safeNative(f.afnSafe);
      const r = await afnLoan();
      await repay(r.loanId, "7000.00", AT_50);
      assert.equal(await safeNative(f.afnSafe), opening, "the AFN that came in went out");
      const flows = await db.h.pool.query<{ native: string; base: string }>(`SELECT e.original_amount::text AS native, e.base_amount::text AS base FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
        WHERE e.subledger_type = 'OPERATIONAL_TREASURY' AND l.journal_id IN (SELECT journal_id FROM abos.loan_journals($1)) ORDER BY e.base_amount DESC`, [r.loanId]);
      assert.deepEqual(flows.rows.map((x) => [Number(x.native), Number(x.base)]), [[7000, 100], [-7000, -140]]);
    });

    test("20. capital and a shareholder's AFN loan stay separate, and FX never touches capital", async () => {
      const added = await db.call<{ shareholderProfileId: string }>("direct_shareholder_add", officer, { displayName: "Synthetic FX Holder", agreedTotal: "100000.00", currencyCode: "USD",
        externalReference: null, note: null, businessDate: AT_70, firstContribution: null, ...keys() });
      const profile = added.shareholderProfileId;
      const party = (await db.h.pool.query<{ id: string }>("SELECT business_party_id AS id FROM abos.shareholder_profiles WHERE id = $1", [profile])).rows[0]?.id ?? "";
      await db.call("direct_shareholder_receive", officer, { shareholderProfileId: profile, fundingMethod: "CASH", amount: "50000.00", currencyCode: "USD", receiptDate: AT_70,
        destinationAccountId: f.usdSafe, providerName: null, itemDescription: null, expenseLedgerAccountId: null, paymentReference: null, note: null, ...keys() });
      const lent = await record({ lenderType: "SHAREHOLDER", lenderName: null, shareholderProfileId: profile, amount: "7000.00" });
      const paid = await repay(lent.loanId, "7000.00", AT_50);
      assert.deepEqual(await shape(paid.journalId), [[SHAREHOLDER_LOAN, 100, 0], [safeCode, 0, 140], [LOSS, 40, 0]]);
      const view = await db.call<{ statement: { capital: { effective: string }[]; loans: { outstanding: string; baseOutstanding?: string }[] }; reconciliation: { capital: { matches: boolean }; loans: { matches: boolean } } }>(
        "finance_shareholder_statement", officer, { partyId: party, ...SEPT });
      assert.equal(Number(view.statement.capital[0]?.effective), 50000);
      assert.equal(Number(view.statement.loans[0]?.outstanding), 0);
      assert.deepEqual([view.reconciliation.capital.matches, view.reconciliation.loans.matches], [true, true]);
    });

    test("21. the Income Statement recognizes only the realized difference, never the principal", async () => {
      const before = await income();
      const r = await afnLoan();
      await repay(r.loanId, "3500.00", AT_80);
      await repay(r.loanId, "3500.00", AT_50);
      const usd = await usdLoan("900.00");
      await repay(usd.loanId, "900.00", AT_70, { treasuryAccountId: f.usdSafe });
      const after = await income();
      assert.deepEqual([after[0] - before[0], after[1] - before[1], after[2] - before[2]], [6.25, 20, -13.75], "7,000 AFN and 900 USD of principal moved; only 6.25 and 20 reached the result");
      const accounts = await db.h.pool.query<{ control: string; type: string }>(`SELECT DISTINCT a.control_account_type AS control, a.account_type AS type FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id
        JOIN abos.journals j ON j.id = l.journal_id JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE i.source_type = 'LOAN_REPAYMENT' AND a.account_type IN ('REVENUE', 'EXPENSE') AND j.legal_entity_id = $1 ORDER BY 1`, [f.e]);
      assert.deepEqual(accounts.rows, [{ control: "REALIZED_FX_GAIN", type: "REVENUE" }, { control: "REALIZED_FX_LOSS", type: "EXPENSE" }]);
    });

    test("every report agrees with the ledger after all of the above", async () => {
      const tb = await db.call<{ balanced: boolean }>("finance_trial_balance", officer, SEPT);
      const summary = await db.call<{ reconciliation: { matches: boolean } }>("finance_management_summary", officer, SEPT);
      const sheet = await db.call<{ validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.deepEqual([tb.balanced, summary.reconciliation.matches, sheet.validation.balanced, Number(sheet.validation.difference)], [true, true, true, 0]);
      const register = (await db.call<{ loans: Loan[] }>("finance_loan_workspace", officer)).loans.reduce((total, l) => total + Number(l.baseOutstanding), 0);
      const owed = await count(`SELECT COALESCE(sum(l.base_credit) - sum(l.base_debit), 0)::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id
        WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND a.control_account_type IN ('SHAREHOLDER_LOAN', 'LOAN_PAYABLE')`, f.e);
      assert.equal(Number(register.toFixed(2)), Number(owed.toFixed(2)), "the loan register equals the liability accounts");
      const orphans = (await db.call<{ loans: Loan[] }>("finance_loan_workspace", officer)).loans.filter((l) => Number(l.outstanding) === 0 && Number(l.baseOutstanding) !== 0);
      assert.deepEqual(orphans, [], "no loan has base value left with its native principal gone");
    });

    test("18. a report reader sees the difference and nothing about who it came from, in raw responses", async () => {
      const r = await afnLoan("7000.00", { lenderName: "Synthetic Hidden FX Lender", reference: "FX-PRIVATE-REF", note: "Private FX note" });
      const paid = await repay(r.loanId, "3500.00", AT_50, { reference: "FX-REPAY-REF", note: "Private repayment note" });
      const reader = f.reportReader;
      const forbidden = ["Synthetic Hidden FX Lender", "FX-PRIVATE-REF", "FX-REPAY-REF", "Private FX note", "Private repayment note", r.loanId, paid.repaymentId, "/finance/loans"];
      const views = [await db.call("finance_trial_balance", reader, SEPT), await db.call("finance_income_statement", reader, SEPT), await db.call("finance_balance_sheet", reader, { asOf: "2026-09-30" }),
        await db.call("finance_management_summary", reader, SEPT), await db.call("finance_account_statement", reader, { accountId: lossAccount, ...SEPT }),
        await db.call("finance_journal_detail", reader, paid.journalId)];
      for (const view of views) assertAbsent(view, forbidden, "a report reader");
      assert.equal(JSON.stringify(views[4]).includes("20"), true, "the loss itself is visible");
      const [masked, full] = [await db.call<Income>("finance_income_statement", reader, SEPT), await db.call<Income>("finance_income_statement", officer, SEPT)];
      assert.deepEqual([masked.totalIncome, masked.totalExpenses, masked.netResult], [full.totalIncome, full.totalExpenses, full.netResult], "confidentiality never changes a figure");
      await assert.rejects(() => db.call("finance_loan_statement", reader, { loanId: r.loanId, asOf: "2026-09-30" }), /missing finance\.loan\.read/);
      const line = (await lines(paid.journalId))[2];
      assert.equal(line?.party, null, "the FX line names no lender");
      await assert.rejects(() => readiness(reader), /missing finance\.loan\.read/);
      const accountant = await db.person(f.world, "Accounts Only", ["finance.ledger-account.manage"]);
      assertAbsent(await readiness(accountant), forbidden, "readiness");
    });

    test("19. another company reaches neither these loans nor these accounts", async () => {
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic FX Other Company','USD','APPROVED')`, [other, f.world.companyId, `FX-${other.slice(0, 6)}`]);
      const stranger = await db.person({ ...f.world, legalEntityId: other }, "Foreign FX Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve", "finance.reversal.direct"]);
      const r = await afnLoan();
      await assert.rejects(() => repay(r.loanId, "100.00", AT_80, { treasuryAccountId: f.afnSafe }, stranger), /not found in this legal entity/);
      await assert.rejects(() => db.call("finance_loan_statement", stranger, { loanId: r.loanId, asOf: "2026-09-30" }), /not found in this legal entity/);
      assert.deepEqual((await readiness(stranger)).accounts.map((a) => a.status), ["MISSING", "MISSING", "MISSING", "MISSING"], "this company's accounts are not theirs");
      assert.deepEqual((await readiness()).accounts.map((a) => a.status), ["READY", "READY", "READY", "READY"]);
    });

    test("readiness names what a person lacks and is closed to everyone else", async () => {
      const admin = await db.person(f.world, "Roles Admin", ["admin.roles.manage"]);
      const view = await readiness(admin);
      assert.deepEqual([view.permissions.canRecord, view.canManageRoles, view.canManageAccounts], [false, true, false]);
      const nobody = await db.person(f.world, "No Finance", ["company.dashboard.read"]);
      await assert.rejects(() => readiness(nobody), /missing finance\.loan\.read/);
    });

    test("the registry allows the third line for these two sources alone, and no account appeared on its own", async () => {
      const rows = await db.h.pool.query<{ source: string }>("SELECT source_type AS source FROM abos.posting_sources WHERE line_count_max IS NOT NULL ORDER BY 1");
      assert.deepEqual(rows.rows.map((x) => x.source), ["LOAN_REPAYMENT", "REVERSAL"]);
      const accounts = await count("SELECT count(*)::text AS n FROM abos.ledger_accounts WHERE control_account_type LIKE 'REALIZED_FX%' AND legal_entity_id <> $1", f.e);
      assert.equal(accounts, 0, "no migration created an account");
    });
  });
}
