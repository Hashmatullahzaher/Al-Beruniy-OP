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
type Listed = { canRead: boolean; canAttach: boolean; documents: { id: string; title: string; fileName: string; scanStatus: string }[] };
type Target = { id: string; storageId: string; byteSize: number; sha256: string; scanStatus: string };
type Scanned = { id: string; scanStatus: string };
type Opened = { id: string; storageId: string; fileName: string; mediaType: string; byteSize: number; sha256: string };

const DAY = "2026-09-15";
const HASH = "a".repeat(64);
const NOT_FOUND = /document (subject )?not found/;
const NOT_CLEARED = /not cleared for opening/;

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
    const target = (s: Session, id: string) => db.call<Target>("document_scan_target", s, id);
    const scan = (s: Session, linkId: string, outcome: string, extra: object = {}) => db.call<Scanned>("document_scan_record", s, { linkId, outcome, engine: "windows-defender", detail: null, correlationId: randomUUID(), ...extra });
    const cleared = async (s: Session, subjectType: string, subjectId: string | null, extra: object = {}) => { const a = await attach(s, subjectType, subjectId, extra); await scan(s, a.id, "CLEAN"); return a; };
    const status = async (s: Session, subjectType: string, subjectId: string | null, id: string) => (await list(s, subjectType, subjectId)).documents.find((d) => d.id === id)?.scanStatus;
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
      const attached = await cleared(officer, "LOAN", loanId, { title: "Signed loan note" });
      assert.equal(attached.title, "Signed loan note");
      const view = await list(officer, "LOAN", loanId);
      assert.deepEqual([view.canRead, view.canAttach, view.documents.map((d) => [d.id, d.title, d.fileName])], [true, true, [[attached.id, "Signed loan note", "synthetic.pdf"]]]);
      assertAbsent(view, [attached.storageId, "storageId"], "the document list");
      const opened = await open(officer, attached.id);
      assert.deepEqual([opened.storageId, opened.mediaType, opened.sha256], [attached.storageId, "application/pdf", HASH]);
      assert.equal(await journals(), before, "attaching and opening a document changes no accounting");
    });

    test("each subject has its own permission, and report readers gain nothing", async () => {
      const loan = await cleared(officer, "LOAN", loanId);
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
      const attached = await cleared(officer, "LOAN", loanId);
      const stranger = await db.person(f.world, "Stranger", ["company.dashboard.read"]);
      const refused = await open(stranger, attached.id).catch((error: Error) => error.message);
      const unknown = await open(stranger, randomUUID()).catch((error: Error) => error.message);
      assert.equal(refused, unknown);
      assert.equal(await audits("DOCUMENT_OPENED", attached.id), 0);
      await assert.rejects(() => list(officer, "LOAN", "not-a-uuid"), NOT_FOUND);
      await assert.rejects(() => list(officer, "NOT_A_TYPE", loanId), NOT_FOUND);
    });

    test("attaching and opening are audited, with the file's details and no storage ID", async () => {
      const attached = await cleared(officer, "LOAN", loanId);
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
      const attached = await cleared(f.creator, "EXPENSE", scoped);
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
      const attachedToHolder = await cleared(f.creator, "SHAREHOLDER", holder.shareholderProfileId);
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

    test("a new document is locked: it lists as pending, and cannot be opened by anyone", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "PENDING");
      await assert.rejects(() => open(officer, attached.id), NOT_CLEARED);
      assert.equal(await audits("DOCUMENT_OPENED", attached.id), 0, "a refused opening is not an opening");
    });

    test("only a scan that passed unlocks a document", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      assert.equal((await scan(officer, attached.id, "CLEAN")).scanStatus, "CLEAN");
      assert.equal((await open(officer, attached.id)).storageId, attached.storageId);
      assert.equal(await audits("DOCUMENT_SCANNED", attached.id), 1);
    });

    test("a scanner that is down decides nothing: the document stays locked as SCAN_FAILED, and can be scanned again", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      // 0067: a failed attempt is visible as SCAN_FAILED instead of PENDING. It is still locked and still scannable.
      for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await scan(officer, attached.id, "UNAVAILABLE", { detail: "The scanner timed out." })).scanStatus, "SCAN_FAILED");
      await assert.rejects(() => open(officer, attached.id), NOT_CLEARED);
      assert.equal((await target(officer, attached.id)).scanStatus, "SCAN_FAILED");
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "SCAN_FAILED");
      assert.equal((await scan(officer, attached.id, "CLEAN")).scanStatus, "CLEAN");
      assert.equal(await audits("DOCUMENT_SCANNED", attached.id), 4, "every attempt is on record");
    });

    test("an infected document is blocked for good: it cannot be opened, cleared or replaced", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      assert.equal((await scan(officer, attached.id, "INFECTED", { detail: "Virus:DOS/EICAR_Test_File" })).scanStatus, "INFECTED");
      await assert.rejects(() => open(officer, attached.id), NOT_CLEARED);
      assert.equal((await scan(officer, attached.id, "CLEAN")).scanStatus, "INFECTED", "a later clean scan changes nothing");
      assert.equal((await scan(officer, attached.id, "UNAVAILABLE")).scanStatus, "INFECTED");
      await assert.rejects(() => open(officer, attached.id), NOT_CLEARED);
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "INFECTED");
      assert.equal(await audits("DOCUMENT_SCANNED", attached.id), 1, "only the verdict is recorded");
      const row = (await db.h.pool.query<{ after_state: Record<string, unknown> }>("SELECT after_state FROM abos.audit_records WHERE action = 'DOCUMENT_SCANNED' AND entity_id = $1", [attached.id])).rows[0];
      assert.deepEqual([row?.after_state.outcome, row?.after_state.detail], ["INFECTED", "Virus:DOS/EICAR_Test_File"]);
    });

    test("a clean verdict is final too: a later scan cannot lock or block it", async () => {
      const attached = await cleared(officer, "LOAN", loanId);
      assert.equal((await scan(officer, attached.id, "INFECTED")).scanStatus, "CLEAN");
      assert.equal((await scan(officer, attached.id, "UNAVAILABLE")).scanStatus, "CLEAN");
      assert.equal(await audits("DOCUMENT_SCANNED", attached.id), 1);
    });

    test("two scans finishing together leave one verdict", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      const results = await Promise.all([scan(officer, attached.id, "CLEAN"), scan(officer, attached.id, "INFECTED"), scan(officer, attached.id, "CLEAN"), scan(officer, attached.id, "INFECTED")]);
      assert.equal(new Set(results.map((r) => r.scanStatus)).size, 1, `every caller sees one answer: ${JSON.stringify(results)}`);
      const rows = await db.h.pool.query<{ n: string }>("SELECT count(*) AS n FROM abos.document_scan_results r JOIN abos.document_links l ON l.document_id = r.document_id WHERE l.id = $1", [attached.id]);
      assert.equal(rows.rows[0]?.n, "1");
    });

    test("a stranger learns nothing, not even that a scan is pending", async () => {
      const pending = await attach(officer, "LOAN", loanId);
      const infected = await attach(officer, "LOAN", loanId);
      await scan(officer, infected.id, "INFECTED");
      const stranger = await db.person(f.world, "Scan Stranger", ["company.dashboard.read"]);
      const answers = await Promise.all([pending.id, infected.id, randomUUID()].map((id) => open(stranger, id).catch((error: Error) => error.message)));
      assert.equal(new Set(answers).size, 1, JSON.stringify(answers));
      assert.match(String(answers[0]), NOT_FOUND);
    });

    test("only someone who may attach can scan: a reader cannot, and a request naming the wrong record gets nothing", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      const reader = await db.person(f.world, "Loan Reader", ["finance.loan.read"]);
      await assert.rejects(() => target(reader, attached.id), NOT_FOUND);
      await assert.rejects(() => scan(reader, attached.id, "CLEAN"), NOT_FOUND);
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "PENDING");
      await assert.rejects(() => target(officer, randomUUID()), NOT_FOUND);
      await assert.rejects(() => scan(officer, randomUUID(), "CLEAN"), NOT_FOUND);
    });

    test("another company reaches no document and no scan, whatever it knows", async () => {
      const attached = await cleared(officer, "LOAN", loanId);
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Document Other','USD','APPROVED')`, [other, f.world.companyId, `DOC-${other.slice(0, 8)}`]);
      const outsider = await db.person({ ...f.world, legalEntityId: other }, "Outside Officer", ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "admin.company.manage"]);
      await assert.rejects(() => open(outsider, attached.id), NOT_FOUND);
      await assert.rejects(() => target(outsider, attached.id), NOT_FOUND);
      await assert.rejects(() => scan(outsider, attached.id, "INFECTED"), NOT_FOUND);
      await assert.rejects(() => list(outsider, "LOAN", loanId), NOT_FOUND);
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "CLEAN");
    });

    test("scan details are checked in the database, and a request cannot add its own fields", async () => {
      const attached = await attach(officer, "LOAN", loanId);
      await assert.rejects(() => scan(officer, attached.id, "SAFE"), /valid scan details/);
      await assert.rejects(() => scan(officer, attached.id, "CLEAN", { engine: " " }), /valid scan details/);
      await assert.rejects(() => scan(officer, attached.id, "CLEAN", { detail: "x".repeat(201) }), /valid scan details/);
      await assert.rejects(() => scan(officer, attached.id, "CLEAN", { scannedAt: "2020-01-01" }), /unknown document fields/);
      assert.equal(await status(officer, "LOAN", loanId, attached.id), "PENDING");
    });

    test("scan results are append-only, and the runtime has no way around the entry points", async () => {
      const attached = await cleared(officer, "LOAN", loanId);
      const id = (await db.h.pool.query<{ id: string }>("SELECT r.id FROM abos.document_scan_results r JOIN abos.document_links l ON l.document_id = r.document_id WHERE l.id = $1", [attached.id])).rows[0]?.id;
      await assert.rejects(() => db.h.pool.query("UPDATE abos.document_scan_results SET outcome = 'INFECTED' WHERE id = $1", [id]));
      await assert.rejects(() => db.h.pool.query("DELETE FROM abos.document_scan_results WHERE id = $1", [id]));
      await assert.rejects(() => db.runtime.query("SELECT id FROM abos.document_scan_results"), /permission denied/);
      await assert.rejects(() => db.runtime.query("SELECT abos.document_scan_status(gen_random_uuid())"), /permission denied/);
      await assert.rejects(() => db.runtime.query("SELECT * FROM abos.document_vault_manifest()"), /permission denied/);
    });

    test("the vault manifest names every stored object, with its scan state", async () => {
      const pending = await attach(officer, "LOAN", loanId);
      const clean = await cleared(officer, "LOAN", loanId);
      const rows = (await db.h.pool.query<{ storage_id: string; byte_size: string; sha256: string; source: string; scan_status: string | null }>("SELECT * FROM abos.document_vault_manifest()")).rows;
      assert.deepEqual(rows.find((r) => r.storage_id === pending.storageId)?.scan_status, "PENDING");
      const row = rows.find((r) => r.storage_id === clean.storageId);
      assert.deepEqual([row?.source, row?.scan_status, row?.sha256, Number(row?.byte_size)], ["DOCUMENT", "CLEAN", HASH, 1200]);
      // 0067: one row per stored object. An imported agreement file is one object with two records.
      const stored = await db.h.pool.query<{ n: string }>("SELECT count(DISTINCT s) AS n FROM (SELECT storage_id AS s FROM abos.documents UNION ALL SELECT storage_id FROM abos.capital_agreement_document_files) x");
      assert.equal(rows.length, Number(stored.rows[0]?.n));
    });
  });
}
