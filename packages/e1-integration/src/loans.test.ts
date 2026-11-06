import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, keys, ReportDatabase, SEPT, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Migrations 0061 and 0062: capital, shareholder loans and other loans. Every figure comes through the entry points the application
 * calls, as the restricted runtime, and is proved against posted journal lines. Sept 2026 is the fixture's open month.
 */

type Line = { account: string; debit: string; credit: string; party: string | null };
type Recorded = { loanId: string; journalId: string | null; reference: string; status: string; replayed: boolean; lenderBusinessPartyId: string; baseAmount: string };
type Repaid = { repaymentId: string; journalId: string | null; status: string; replayed: boolean; baseAmount: string };
type Loan = { id: string; status: string; outstanding: string; baseOutstanding: string; repaid: string; pendingRepayments: string; reversed: boolean; lender: { id: string; name: string }; lenderType: string; note: string | null };
type Workspace = { loans: Loan[]; pendingRepayments: { id: string }[]; options: { liabilityAccounts: { id: string }[]; shareholders: { id: string; name: string }[] } | null };
type Statement = { opening: { native: string }; closing: { native: string; base: string }; lines: { kind: string; balance: string; amount: string; journalId: string; reference: string; source: { id: string | null; route: string | null; counterparty: string | null } }[];
  reconciliation: { loansBase: string; ledgerBase: string; matches: boolean } };

if (databaseUrl() === undefined) {
  test("0061 loans", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0061 and 0062: one loan lane, separate from capital", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let officer: Session; let approver: Session; let loanReader: Session;
    let loanAccount: string; let profile: string; let party: string;
    const day = "2026-09-10";

    const ledger = async (code: string, type: string, control: string | null) => {
      const id = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,NULL,'ACTIVE')`, [id, f.e, code, `Synthetic ${code}`, type, control]);
      return id;
    };
    const lines = async (journal: string) => (await db.h.pool.query<Line>(`SELECT a.account_code AS account, l.base_debit::text AS debit, l.base_credit::text AS credit, l.business_party_id AS party
      FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const record = (s: Session, payload: object) => db.call<Recorded>("finance_loan_record", s, { treasuryAccountId: f.usdSafe, currencyCode: "USD", businessDate: day, reference: null, note: null, ...keys(), ...payload });
    const outside = (amount: string, extra: object = {}) => record(officer, { lenderType: "COMPANY", lenderName: "Synthetic Bank", amount, ...extra });
    const repay = (s: Session, loanId: string, amount: string, extra: object = {}) => db.call<Repaid>("finance_loan_repay", s, { loanId, treasuryAccountId: f.usdSafe, amount, businessDate: day, reference: null, note: null, ...keys(), ...extra });
    const reverse = (s: Session, journalId: string, reason: string) => db.call<{ reversalJournalId: string }>("finance_journal_reversal_direct", s, { journalId, reason, ...keys() });
    const workspace = (s: Session) => db.call<Workspace>("finance_loan_workspace", s);
    const statement = (s: Session, loanId: string) => db.call<Statement>("finance_loan_statement", s, { loanId, asOf: "2026-09-30" });
    const loan = async (id: string) => { const row = (await workspace(officer)).loans.find((l) => l.id === id); assert.ok(row); return row; };
    const safeBalance = async (account: string) => Number((await db.call<{ statement: { closing: { native: string } } }>("treasury_account_statement", officer, { accountId: account, asOf: "2026-09-30" })).statement.closing.native);
    const ledgerClass = async (type: string) => Number((await db.h.pool.query<{ n: string }>(`SELECT COALESCE(sum(l.base_debit) - sum(l.base_credit), 0)::text AS n FROM abos.journal_lines l
      JOIN abos.journals j ON j.id = l.journal_id JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND a.account_type = $2`, [f.e, type])).rows[0]?.n);

    before(async () => {
      await db.open();
      f = await db.company();
      await ledger("2510", "LIABILITY", "SHAREHOLDER_LOAN");
      loanAccount = await ledger("2520", "LIABILITY", "LOAN_PAYABLE");
      officer = await db.person(f.world, "Loan Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.report.operational.read", "finance.reversal.direct",
        "treasury.safe.read", "shareholder.read", "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "finance.capital-receipt.prepare",
        "finance.capital-receipt.post", "finance.fx-policy.manage", "treasury.opening-balance.record"]);
      approver = await db.person(f.world, "Loan Approver", ["finance.loan.approve", "finance.loan.read"]);
      loanReader = await db.person(f.world, "Lender Reader", ["finance.loan.read", "finance.report.operational.read"]);
      await db.call("finance_fx_policy_set", officer, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
        reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
    });
    after(async () => { await db.close(); });

    test("1. shareholder capital of 50,000 is equity, not a liability", async () => {
      const added = await db.call<{ shareholderProfileId: string; journalId?: string; firstReceipt?: { journalId: string } }>("direct_shareholder_add", officer, { displayName: "Synthetic Both Holder", agreedTotal: "100000.00", currencyCode: "USD",
        externalReference: null, note: null, businessDate: day, firstContribution: null, ...keys() });
      profile = added.shareholderProfileId;
      party = (await db.h.pool.query<{ id: string }>("SELECT business_party_id AS id FROM abos.shareholder_profiles WHERE id = $1", [profile])).rows[0]?.id ?? "";
      const receipt = await db.call<{ journalId: string }>("direct_shareholder_receive", officer, { shareholderProfileId: profile, fundingMethod: "CASH", amount: "50000.00", currencyCode: "USD", receiptDate: day,
        destinationAccountId: f.usdSafe, providerName: null, itemDescription: null, expenseLedgerAccountId: null, paymentReference: null, note: null, ...keys() });
      const [debit, credit] = await lines(receipt.journalId);
      assert.deepEqual([Number(debit?.debit), Number(credit?.credit)], [50000, 50000]);
      assert.equal((await db.h.pool.query<{ t: string }>("SELECT a.account_type AS t FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = $1 AND l.line_number = 2", [receipt.journalId])).rows[0]?.t, "EQUITY");
      assert.equal(await ledgerClass("LIABILITY"), 0, "capital creates no liability");
    });

    test("2. a shareholder loan of 20,000: Dr Treasury, Cr Shareholder Loan Payable, for that person", async () => {
      const r = await record(officer, { lenderType: "SHAREHOLDER", shareholderProfileId: profile, amount: "20000.00", reference: "LOAN-PRIVATE-REF", note: "Private loan note" });
      assert.equal(r.status, "POSTED");
      assert.match(r.reference, /^LN-20260910-/);
      assert.equal(r.lenderBusinessPartyId, party, "the same person, not a second identity");
      const [debit, credit] = await lines(r.journalId ?? "");
      assert.deepEqual([Number(debit?.debit), debit?.party], [20000, null]);
      assert.deepEqual([credit?.account, Number(credit?.credit), credit?.party], ["2510", 20000, party]);
      assert.equal(await safeBalance(f.usdSafe), 70000);
    });

    test("3. a loan from an outside lender of 30,000 goes to the other liability and creates its lender", async () => {
      const r = await outside("30000.00", { reference: "BANK-REF", note: "Bank note" });
      const [, credit] = await lines(r.journalId ?? "");
      assert.deepEqual([credit?.account, Number(credit?.credit)], ["2520", 30000]);
      const role = await db.h.pool.query<{ role_code: string }>("SELECT role_code FROM abos.business_party_roles WHERE business_party_id = $1", [r.lenderBusinessPartyId]);
      assert.deepEqual(role.rows.map((x) => x.role_code), ["LENDER"]);
      assert.equal(await safeBalance(f.usdSafe), 100000);
      assert.equal(await ledgerClass("LIABILITY"), -50000);
    });

    test("4 to 6. partial repayment, its reversal, and the loan's reversal, all through the standard mechanism", async () => {
      const r = await outside("3000.00");
      const before = await safeBalance(f.usdSafe);
      const paid = await repay(officer, r.loanId, "500.00", { reference: "REPAY-REF", note: "Repayment note" });
      const [debit, credit] = await lines(paid.journalId ?? "");
      assert.deepEqual([debit?.account, Number(debit?.debit), credit && Number(credit.credit)], ["2520", 500, 500]);
      assert.equal(await safeBalance(f.usdSafe), before - 500);
      assert.deepEqual([Number((await loan(r.loanId)).outstanding), Number((await loan(r.loanId)).repaid)], [2500, 500]);
      await assert.rejects(() => reverse(officer, r.journalId ?? "", "Loan entered in error"), /has repayments/, "a repaid loan is not reversed out from under its repayment");
      const undone = await reverse(officer, paid.journalId ?? "", "Repayment entered in error");
      const inverse = await lines(undone.reversalJournalId);
      assert.deepEqual([inverse[0]?.account, Number(inverse[0]?.credit), Number(inverse[1]?.debit)], ["2520", 500, 500], "the exact inverse");
      assert.equal(await safeBalance(f.usdSafe), before);
      assert.deepEqual([Number((await loan(r.loanId)).outstanding), Number((await loan(r.loanId)).repaid)], [3000, 0]);
      await reverse(officer, r.journalId ?? "", "Loan entered in error");
      assert.equal(await safeBalance(f.usdSafe), before - 3000);
      const gone = await loan(r.loanId);
      assert.deepEqual([Number(gone.outstanding), gone.reversed, gone.status], [0, true, "POSTED"], "the original stays posted and linked");
      await assert.rejects(() => repay(officer, r.loanId, "1.00"), /cannot exceed what is outstanding/);
      const kinds = (await statement(officer, r.loanId)).lines.map((l) => l.kind);
      assert.deepEqual(kinds.sort(), ["RECEIPT", "RECEIPT_REVERSAL", "REPAYMENT", "REPAYMENT_REVERSAL"]);
    });

    test("7. AFN keeps native, base, its own frozen rate and no revaluation; a repayment is in the loan's currency", async () => {
      const r = await record(officer, { lenderType: "INDIVIDUAL", lenderName: "Synthetic AFN Lender", treasuryAccountId: f.afnSafe, currencyCode: "AFN", amount: "7000.00", businessDate: "2026-09-14" });
      assert.equal(Number(r.baseAmount), 100);
      const [debit] = await lines(r.journalId ?? "");
      assert.equal(Number(debit?.debit), 100);
      const intent = await db.h.pool.query<{ snap: string | null; original: string }>("SELECT i.conversion_snapshot_reference AS snap, i.original_amount::text AS original FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE j.id = $1", [r.journalId]);
      assert.ok(intent.rows[0]?.snap, "an immutable snapshot");
      assert.equal(Number(intent.rows[0]?.original), 7000);
      await assert.rejects(() => repay(officer, r.loanId, "7000.00", { treasuryAccountId: f.usdSafe, businessDate: "2026-09-14" }), /holds USD, not AFN/, "no cross-currency repayment");
      const paid = await repay(officer, r.loanId, "7000.00", { treasuryAccountId: f.afnSafe, businessDate: "2026-09-14" });
      assert.equal(Number(paid.baseAmount), 100, "at the rate it came in at");
      const l = await loan(r.loanId);
      assert.deepEqual([Number(l.outstanding), Number(l.baseOutstanding)], [0, 0], "native and base clear together. A different rate is in loan-realized-fx.test.ts");
      const fx = await db.h.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM abos.journal_lines l WHERE l.ledger_account_id = $1", [f.fxAccount]);
      assert.equal(fx.rows[0]?.n, "0", "no settlement difference is invented, and a realized one never uses this account");
    });

    test("8. a repayment the Safe cannot cover is refused by the existing guard", async () => {
      const r = await record(officer, { lenderType: "OTHER", lenderName: "Synthetic Petty Lender", treasuryAccountId: f.secondSafe, amount: "100.00" });
      await db.call("finance_loan_repay", officer, { loanId: r.loanId, treasuryAccountId: f.secondSafe, amount: "60.00", businessDate: day, reference: null, note: null, ...keys() });
      const other = await outside("500.00");
      await assert.rejects(() => repay(officer, other.loanId, "100.00", { treasuryAccountId: f.secondSafe }), /would fall below zero/);
      assert.equal(Number((await loan(other.loanId)).outstanding), 500, "nothing changed");
    });

    test("9. replaying a request returns the first result; changing it under the same key is refused", async () => {
      const request = { ...keys(), lenderType: "COMPANY", lenderName: "Synthetic Replay Lender", amount: "700.00" };
      const first = await record(officer, request);
      const again = await record(officer, request);
      assert.equal(again.loanId, first.loanId);
      assert.equal((await db.h.pool.query("SELECT 1 FROM abos.loans WHERE id = $1", [first.loanId])).rowCount, 1);
      await assert.rejects(() => record(officer, { ...request, amount: "701.00" }), /idempotency|different/i);
      const payment = { ...keys() };
      const a = await repay(officer, first.loanId, "100.00", payment);
      const b = await repay(officer, first.loanId, "100.00", payment);
      assert.equal(a.repaymentId, b.repaymentId);
      assert.equal(Number((await loan(first.loanId)).outstanding), 600);
    });

    test("10. concurrent repayments cannot together exceed the loan", async () => {
      const r = await outside("1000.00");
      const results = await Promise.allSettled([repay(officer, r.loanId, "700.00"), repay(officer, r.loanId, "700.00"), repay(officer, r.loanId, "700.00")]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      for (const x of results) if (x.status === "rejected") assert.match(String(x.reason), /cannot exceed what is outstanding/);
      assert.equal(Number((await loan(r.loanId)).outstanding), 300);
    });

    test("a repayment cannot exceed what is owed, or be dated before the loan", async () => {
      const r = await outside("100.00");
      await assert.rejects(() => repay(officer, r.loanId, "100.01"), /cannot exceed what is outstanding/);
      await assert.rejects(() => repay(officer, r.loanId, "10.00", { businessDate: "2026-09-09" }), /before its loan/);
    });

    test("capital and loans stay apart for one person, and every report agrees with the ledger", async () => {
      const view = await db.call<{ statement: { capital: { effective: string }[]; loans: { outstanding: string; received: string }[] }; reconciliation: { capital: { matches: boolean }; loans: { matches: boolean } } }>(
        "finance_shareholder_statement", officer, { partyId: party, ...SEPT });
      assert.equal(Number(view.statement.capital[0]?.effective), 50000);
      assert.equal(Number(view.statement.loans[0]?.outstanding), 20000);
      assert.deepEqual([view.reconciliation.capital.matches, view.reconciliation.loans.matches], [true, true]);
      const income = await db.call<{ totalIncome: string; totalExpenses: string }>("finance_income_statement", officer, SEPT);
      assert.deepEqual([Number(income.totalIncome), Number(income.totalExpenses)], [0, 0], "no loan, repayment or capital receipt is income or expense");
      const sheet = await db.call<{ accounts: { code: string; group: string; amount: string }[]; totalLiabilities: string; validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.equal(sheet.validation.balanced, true);
      assert.equal(Number(sheet.totalLiabilities), -(await ledgerClass("LIABILITY")));
      assert.deepEqual(sheet.accounts.filter((a) => a.code === "2510" || a.code === "2520").map((a) => a.group), ["LOANS", "LOANS"]);
      const tb = await db.call<{ balanced: boolean }>("finance_trial_balance", officer, SEPT);
      assert.equal(tb.balanced, true);
      const summary = await db.call<{ base: { capitalReceived: string; loansReceived: string; loanRepayments: string; closing: string; otherReceipts: string }; reconciliation: { matches: boolean } }>("finance_management_summary", officer, SEPT);
      assert.equal(summary.reconciliation.matches, true);
      assert.equal(Number(summary.base.capitalReceived), 50000);
      assert.equal(Number(summary.base.otherReceipts), 0, "a loan is not other income");
      const owed = await db.h.pool.query<{ n: string }>(`SELECT COALESCE(sum(l.base_credit) - sum(l.base_debit), 0)::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
        JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE j.legal_entity_id = $1 AND j.status = 'POSTED' AND a.control_account_type IN ('SHAREHOLDER_LOAN', 'LOAN_PAYABLE')`, [f.e]);
      const sum = (await workspace(officer)).loans.reduce((total, l) => total + Number(l.baseOutstanding), 0);
      assert.equal(sum, Number(owed.rows[0]?.n), "the register equals the liability accounts, including any AFN base difference");
      const first = (await workspace(officer)).loans.find((l) => l.lenderType === "SHAREHOLDER");
      const s = await statement(officer, first?.id ?? "");
      assert.deepEqual([Number(s.closing.native), s.reconciliation.matches], [20000, true]);
    });

    test("11. a report reader gets the mathematics and nothing about the lender, in raw responses", async () => {
      const reader = f.reportReader;
      const forbidden = ["Synthetic Both Holder", "Synthetic Bank", "LOAN-PRIVATE-REF", "BANK-REF", "REPAY-REF", "Private loan note", "Bank note", "Repayment note", "Loan entered in error", "Repayment entered in error", "/finance/loans", "/finance/reversals", "LN-2026", "LR-2026", "RV-2026"];
      const loanJournals = (await db.h.pool.query<{ id: string; source: string }>(`SELECT j.id, i.source_id AS source FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id
        WHERE j.legal_entity_id = $1 AND (i.source_type LIKE 'LOAN%' OR i.source_type = 'REVERSAL')`, [f.e])).rows;
      const sourceIds = (await db.h.pool.query<{ id: string }>("SELECT id FROM abos.loans UNION ALL SELECT id FROM abos.loan_repayments")).rows.map((r) => r.id);
      const reads = [["trial balance", await db.call("finance_trial_balance", reader, SEPT)], ["income", await db.call("finance_income_statement", reader, SEPT)], ["balance sheet", await db.call("finance_balance_sheet", reader, { asOf: "2026-09-30" })],
        ["summary", await db.call("finance_management_summary", reader, SEPT)], ["shareholders", await db.call("finance_shareholder_statement", reader, SEPT)],
        ["account statement", await db.call("finance_account_statement", reader, { accountId: loanAccount, ...SEPT })], ["safe", await db.call("treasury_account_statement", reader, { accountId: f.usdSafe, ...SEPT })]] as const;
      for (const [name, view] of reads) assertAbsent(view, [...forbidden, ...sourceIds], `the ${name} of a report reader`);
      for (const j of loanJournals) assertAbsent(await db.call("finance_journal_detail", reader, j.id), [...forbidden, ...sourceIds], "journal detail of a report reader");
      const full = await db.call<{ totalLiabilities: string }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      const masked = await db.call<{ totalLiabilities: string }>("finance_balance_sheet", reader, { asOf: "2026-09-30" });
      assert.equal(masked.totalLiabilities, full.totalLiabilities);
      const totals = await db.call<{ totals: { loans: { outstanding: string }[] }; people: unknown[] }>("finance_shareholder_statement", reader, SEPT);
      assert.ok(totals.totals.loans.some((t) => Number(t.outstanding) > 0), "the liability total is there");
      assert.deepEqual(totals.people, []);
      await assert.rejects(() => workspace(reader), /missing finance\.loan\.read/);
      const lender = await db.call<{ totals: unknown; people: { name: string }[] }>("finance_shareholder_statement", loanReader, SEPT);
      assert.ok(lender.people.some((p) => p.name === "Synthetic Both Holder"), "a lender reader may see the lender");
    });

    test("approval ON holds a record for a second person, who cannot be the maker", async () => {
      await db.h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES ($1,$2,'LOAN',1,true,$3,'Synthetic approval setting')`, [randomUUID(), f.e, f.u]);
      const before = await safeBalance(f.usdSafe);
      const pending = await outside("400.00");
      assert.deepEqual([pending.status, pending.journalId], ["PENDING_APPROVAL", null]);
      assert.equal(await safeBalance(f.usdSafe), before, "nothing is posted yet");
      const decide = (s: Session, kind: string, id: string, decision: string, reason: string | null = null) => db.call<{ status: string; journalId: string | null }>("finance_loan_decide", s, { kind, id, decision, reason, ...keys() });
      await assert.rejects(() => decide(officer, "LOAN", pending.loanId, "APPROVED"), /missing finance\.loan\.approve/);
      const both = await db.person(f.world, "Maker Approver", ["finance.loan.record", "finance.loan.approve"]);
      const own = await record(both, { lenderType: "OTHER", lenderName: "Synthetic Own Lender", amount: "10.00" });
      await assert.rejects(() => decide(both, "LOAN", own.loanId, "APPROVED"), /whoever recorded it cannot decide it/);
      const approved = await decide(approver, "LOAN", pending.loanId, "APPROVED");
      assert.equal(approved.status, "POSTED");
      assert.equal(await safeBalance(f.usdSafe), before + 400);
      await assert.rejects(() => decide(approver, "LOAN", pending.loanId, "APPROVED"), /already been decided/);
      const payment = await repay(officer, pending.loanId, "150.00");
      assert.equal(payment.status, "PENDING_APPROVAL");
      await assert.rejects(() => repay(officer, pending.loanId, "300.00"), /cannot exceed what is outstanding/, "a pending repayment is counted");
      await assert.rejects(() => decide(approver, "REPAYMENT", payment.repaymentId, "REJECTED"), /to reject, a reason/);
      await decide(approver, "REPAYMENT", payment.repaymentId, "REJECTED", "Synthetic rejection reason");
      assert.equal(Number((await loan(pending.loanId)).outstanding), 400);
      await db.h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES ($1,$2,'LOAN',2,false,$3,'Synthetic approval setting off')`, [randomUUID(), f.e, f.u]);
    });

    test("12. another company cannot see, repay, reverse or decide this company's loans", async () => {
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `LN2-${other.slice(0, 8)}`]);
      const stranger = await db.person({ ...f.world, legalEntityId: other }, "Foreign Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve", "finance.reversal.direct", "finance.report.operational.read"]);
      const r = await outside("200.00");
      assert.deepEqual((await workspace(stranger)).loans, []);
      await assert.rejects(() => repay(stranger, r.loanId, "1.00", { treasuryAccountId: randomUUID() }), /not found in this legal entity/);
      await assert.rejects(() => statement(stranger, r.loanId), /not found in this legal entity/);
      await assert.rejects(() => reverse(stranger, r.journalId ?? "", "Foreign reversal attempt"), /not found/);
      await assert.rejects(() => db.call("finance_loan_decide", stranger, { kind: "LOAN", id: r.loanId, decision: "APPROVED", reason: null, ...keys() }), /not found in this legal entity/);
    });

    test("records are immutable, the lane is closed to the runtime, and the registry marks the legacy sources", async () => {
      const r = await outside("50.00");
      await assert.rejects(() => db.h.pool.query("UPDATE abos.loans SET note = 'changed' WHERE id = $1", [r.loanId]), /changes only once/);
      await assert.rejects(() => db.h.pool.query("DELETE FROM abos.loans WHERE id = $1", [r.loanId]), /never deleted/);
      const write = await db.h.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE table_schema = 'abos' AND table_name IN ('loans', 'loan_repayments')
        AND grantee IN ('abos_e1_runtime', 'abos_e1_treasury_runtime', 'abos_v1_identity_runtime')`);
      assert.equal(write.rows[0]?.n, "0", "the runtime holds no table access at all");
      const entry = await db.h.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'abos' AND p.proname LIKE 'finance_loan%' AND p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')`);
      assert.equal(entry.rows[0]?.n, "0");
      await assert.rejects(() => db.runtime.query("SELECT abos.loan_post($1, $2, false)", [r.loanId, f.u]), /permission denied/);
      const legacy = await db.h.pool.query<{ source_type: string }>("SELECT source_type FROM abos.posting_sources WHERE compatibility_only ORDER BY 1");
      assert.deepEqual(legacy.rows.map((x) => x.source_type), ["TEMPORARY_FUNDING", "TEMPORARY_FUNDING_SETTLEMENT"]);
    });
  });
}
