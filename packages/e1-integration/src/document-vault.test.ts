import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, keys, ReportDatabase, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Migration 0065: a document has no permission of its own. Access comes from the record it is attached to, decided in PostgreSQL on every
 * request. These tests call the entry points as the restricted runtime does, and read every response whole.
 */

type Attached = { id: string; title: string; storageId: string; replayed: boolean };
type Listed = { canRead: boolean; canAttach: boolean; documents: { id: string; title: string; fileName: string }[] };
type Opened = { id: string; storageId: string; fileName: string; mediaType: string; byteSize: number; sha256: string };

const DAY = "2026-09-15";
const HASH = "a".repeat(64);
const NOT_FOUND = /document (subject )?not found/;

if (databaseUrl() === undefined) {
  test("0065 Document Vault", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0065: Document Vault", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let officer: Session; let loanId: string;

    const file = (subjectType: string, subjectId: string | null, extra: object = {}) => ({ subjectType, subjectId, storageId: randomUUID(), originalFileName: "synthetic.pdf",
      mediaType: "application/pdf", byteSize: 1200, sha256: HASH, title: "Synthetic document", documentDate: DAY, ...keys(), ...extra });
    const attach = (s: Session, subjectType: string, subjectId: string | null, extra: object = {}) => db.call<Attached>("document_attach", s, file(subjectType, subjectId, extra));
    const list = (s: Session, subjectType: string, subjectId: string | null) => db.call<Listed>("document_list", s, { subjectType, subjectId });
    const open = (s: Session, id: string) => db.call<Opened>("document_open", s, id, randomUUID());
    const audits = async (action: string, id: string) => Number((await db.h.pool.query<{ n: string }>("SELECT count(*) AS n FROM abos.audit_records WHERE action = $1 AND entity_id = $2", [action, id])).rows[0]?.n);
    const journals = async () => Number((await db.h.pool.query<{ n: string }>("SELECT count(*) AS n FROM abos.journals")).rows[0]?.n);
    const spend = async (extra: object = {}) => (await db.call<{ expense: { id: string } }>("operational_expense_create", f.creator, { treasuryAccountId: f.usdSafe, expenseCategoryId: f.category,
      payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "DOC-EXP", description: "Synthetic expense", note: null, businessDate: DAY,
      originalAmount: "10.00", currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra })).expense.id;

    before(async () => {
      await db.open();
      f = await db.company();
      officer = await db.person(f.world, "Loan Document Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "treasury.safe.read"]);
      await db.ledger(f.e, "2520", "LIABILITY", "LOAN_PAYABLE");
      await db.call("treasury_receipt_record", f.creator, { treasuryAccountId: f.usdSafe, amount: "1000.00", currencyCode: "USD", businessDate: DAY, payerBusinessPartyId: null,
        payerName: "Synthetic payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
      loanId = (await db.call<{ loanId: string }>("finance_loan_record", officer, { lenderType: "COMPANY", lenderName: "Synthetic Private Lender", treasuryAccountId: f.usdSafe, currencyCode: "USD",
        amount: "500.00", businessDate: DAY, reference: null, note: null, ...keys() })).loanId;
    });
    after(async () => { await db.close(); });

    test("a document attaches to a record, and the list carries no storage ID", async () => {
      const before = await journals();
      const attached = await attach(officer, "LOAN", loanId, { title: "Signed loan note" });
      assert.equal(attached.title, "Signed loan note");
      const view = await list(officer, "LOAN", loanId);
      assert.deepEqual([view.canRead, view.canAttach, view.documents.map((d) => [d.id, d.title, d.fileName])], [true, true, [[attached.id, "Signed loan note", "synthetic.pdf"]]]);
      assertAbsent(view, [attached.storageId, "storageId"], "the document list");
      const opened = await open(officer, attached.id);
      assert.deepEqual([opened.storageId, opened.mediaType, opened.sha256], [attached.storageId, "application/pdf", HASH]);
      assert.equal(await journals(), before, "attaching and opening a document changes no accounting");
    });

    test("each subject has its own permission, and report readers gain nothing", async () => {
      const loan = await attach(officer, "LOAN", loanId);
      const reportReader = await db.person(f.world, "Report Reader", ["finance.report.operational.read"]);
      const expenseReader = await db.person(f.world, "Expense Reader", ["finance.expense.read"]);
      const loanReader = await db.person(f.world, "Loan Reader", ["finance.loan.read"]);
      for (const stranger of [reportReader, expenseReader]) {
        await assert.rejects(() => list(stranger, "LOAN", loanId), NOT_FOUND);
        await assert.rejects(() => open(stranger, loan.id), NOT_FOUND);
        await assert.rejects(() => attach(stranger, "LOAN", loanId), NOT_FOUND);
        await assert.rejects(() => db.call("document_prepare", stranger, { subjectType: "LOAN", subjectId: loanId }), NOT_FOUND);
      }
      assert.ok((await list(loanReader, "LOAN", loanId)).documents.length > 0);
      assert.equal((await open(loanReader, loan.id)).id, loan.id);
      await assert.rejects(() => attach(loanReader, "LOAN", loanId), NOT_FOUND, "reading a loan does not allow attaching to it");
      const recorder = await db.person(f.world, "Loan Recorder", ["finance.loan.record"]);
      assert.deepEqual(await list(recorder, "LOAN", loanId), { canRead: false, canAttach: true, documents: [] }, "attaching does not open what is already there");
      await assert.rejects(() => open(recorder, loan.id), NOT_FOUND);
    });

    test("knowing an ID gives nothing: a refused read and an unknown one are the same answer, and neither is audited", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      const stranger = await db.person(f.world, "Stranger", ["company.dashboard.read"]);
      const refused = await open(stranger, attached.id).catch((error: Error) => error.message);
      const unknown = await open(stranger, randomUUID()).catch((error: Error) => error.message);
      assert.equal(refused, unknown);
      assert.equal(await audits("DOCUMENT_OPENED", attached.id), 0);
      await assert.rejects(() => list(officer, "LOAN", "not-a-uuid"), NOT_FOUND);
      await assert.rejects(() => list(officer, "NOT_A_TYPE", loanId), NOT_FOUND);
    });

    test("attaching and opening are audited, with the file's details and no storage ID", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      await open(officer, attached.id); await open(officer, attached.id);
      assert.equal(await audits("DOCUMENT_ATTACHED", attached.id), 1);
      assert.equal(await audits("DOCUMENT_OPENED", attached.id), 2);
      const row = (await db.h.pool.query<{ after_state: Record<string, unknown> }>("SELECT after_state FROM abos.audit_records WHERE action = 'DOCUMENT_OPENED' AND entity_id = $1 LIMIT 1", [attached.id])).rows[0];
      assert.deepEqual([row?.after_state.subjectType, row?.after_state.subjectId, row?.after_state.sha256], ["LOAN", loanId, HASH]);
      assertAbsent(row, [attached.storageId], "the audit record");
    });

    test("an expense's document follows the expense's scope, not only the permission", async () => {
      const scoped = await spend({ projectId: f.project });
      const open_ = await spend();
      const attached = await attach(f.creator, "EXPENSE", scoped);
      const outside = await db.person(f.world, "Expense Reader Outside Project", ["finance.expense.read", "finance.expense.create"]);
      await assert.rejects(() => list(outside, "EXPENSE", scoped), NOT_FOUND);
      await assert.rejects(() => open(outside, attached.id), NOT_FOUND);
      await assert.rejects(() => attach(outside, "EXPENSE", scoped), NOT_FOUND);
      assert.equal((await list(outside, "EXPENSE", open_)).canRead, true);
      assert.equal((await open(f.creator, attached.id)).id, attached.id);
    });

    test("every subject type resolves, and a record of another type is not found", async () => {
      const admin = await db.person(f.world, "Company Admin", ["admin.company.manage"]);
      const company = await attach(admin, "COMPANY", null);
      assert.equal((await list(admin, "COMPANY", null)).documents.at(-1)?.id, company.id);
      await assert.rejects(() => list(officer, "COMPANY", null), NOT_FOUND);
      const holder = await db.call<{ shareholderProfileId: string }>("direct_shareholder_add", f.creator, { displayName: "Synthetic Document Holder", agreedTotal: null, currencyCode: "USD",
        externalReference: null, note: null, businessDate: DAY, firstContribution: null, ...keys() });
      const reader = await db.person(f.world, "Shareholder Reader", ["shareholder.read"]);
      const attachedToHolder = await attach(f.creator, "SHAREHOLDER", holder.shareholderProfileId);
      assert.equal((await open(reader, attachedToHolder.id)).id, attachedToHolder.id);
      const receipt = await db.call<{ movementId: string }>("treasury_receipt_record", f.creator, { treasuryAccountId: f.usdSafe, amount: "20.00", currencyCode: "USD", businessDate: DAY, payerBusinessPartyId: null,
        payerName: "Synthetic payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
      const payment = await db.call<{ movementId: string }>("treasury_payment_record", f.creator, { treasuryAccountId: f.usdSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null,
        payableLedgerAccountId: f.payable, amount: "5.00", currencyCode: "USD", businessDate: DAY, reference: null, note: null, ...keys() });
      assert.equal((await list(f.safeReader, "RECEIPT", (await attach(f.creator, "RECEIPT", receipt.movementId)) && receipt.movementId)).documents.length, 1);
      assert.equal((await list(f.safeReader, "PAYMENT", (await attach(f.creator, "PAYMENT", payment.movementId)) && payment.movementId)).documents.length, 1);
      await assert.rejects(() => list(f.safeReader, "PAYMENT", receipt.movementId), NOT_FOUND, "a receipt is not a payment");
      await assert.rejects(() => attach(f.creator, "LOAN", randomUUID()), NOT_FOUND);
    });

    test("another company reaches nothing, and a company document is always the session's own", async () => {
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Document Other','USD','APPROVED')`, [other, f.world.companyId, `DOC-${other.slice(0, 8)}`]);
      const stranger = await db.person({ ...f.world, legalEntityId: other }, "Foreign Document Officer", ["finance.loan.read", "finance.loan.record", "admin.company.manage"]);
      const attached = await attach(officer, "LOAN", loanId);
      await assert.rejects(() => list(stranger, "LOAN", loanId), NOT_FOUND);
      await assert.rejects(() => open(stranger, attached.id), NOT_FOUND);
      await assert.rejects(() => attach(stranger, "LOAN", loanId), NOT_FOUND);
      const admin = await db.person(f.world, "Home Admin", ["admin.company.manage"]);
      const home = await attach(admin, "COMPANY", null);
      assert.equal((await list(stranger, "COMPANY", f.e)).documents.length, 0, "naming another company's id changes nothing");
      await assert.rejects(() => open(stranger, home.id), NOT_FOUND);
    });

    test("a retry replays, with the first storage ID, and the same key cannot carry another file", async () => {
      const request = file("LOAN", loanId);
      const first = await db.call<Attached>("document_attach", officer, request);
      const retry = await db.call<Attached>("document_attach", officer, { ...request, storageId: randomUUID(), correlationId: randomUUID() });
      assert.deepEqual([retry.id, retry.storageId, retry.replayed], [first.id, first.storageId, true]);
      assert.equal(await audits("DOCUMENT_ATTACHED", first.id), 1);
      await assert.rejects(() => db.call("document_attach", officer, { ...request, storageId: randomUUID(), sha256: "b".repeat(64) }), /idempotency key/);
    });

    test("details are checked in the database too", async () => {
      await assert.rejects(() => attach(officer, "LOAN", loanId, { mediaType: "text/html" }), /valid document details/);
      await assert.rejects(() => attach(officer, "LOAN", loanId, { byteSize: 10485761 }), /valid document details/);
      await assert.rejects(() => attach(officer, "LOAN", loanId, { sha256: "not-a-hash" }), /valid document details/);
      await assert.rejects(() => attach(officer, "LOAN", loanId, { title: "   " }), /valid document details/);
      await assert.rejects(() => attach(officer, "LOAN", loanId, { documentDate: "2999-01-01" }), /future/);
      await assert.rejects(() => attach(officer, "LOAN", loanId, { path: "../other" }), /unknown document fields/);
    });

    test("nothing is replaced or removed, and the runtime has no way around the entry points", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      await assert.rejects(() => db.h.pool.query("UPDATE abos.document_links SET title = 'Changed' WHERE id = $1", [attached.id]));
      await assert.rejects(() => db.h.pool.query("DELETE FROM abos.document_links WHERE id = $1", [attached.id]));
      await assert.rejects(() => db.h.pool.query("DELETE FROM abos.documents WHERE storage_id = $1", [attached.storageId]));
      await assert.rejects(() => db.runtime.query("SELECT storage_id FROM abos.documents"), /permission denied/);
      await assert.rejects(() => db.runtime.query("SELECT id FROM abos.document_links"), /permission denied/);
      await assert.rejects(() => db.runtime.query("SELECT abos.document_subject_allowed(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 'LOAN', gen_random_uuid(), false)"), /permission denied/);
      const open_ = await db.h.pool.query<{ name: string }>(`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'abos' AND p.proname LIKE 'document%' AND has_function_privilege('public', p.oid, 'EXECUTE')`);
      assert.deepEqual(open_.rows, []);
    });
  });
}
