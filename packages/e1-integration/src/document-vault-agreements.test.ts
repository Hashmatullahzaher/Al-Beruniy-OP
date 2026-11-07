import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

import { importLegacyAgreementDocuments, PrivateDocumentStorage, readDocumentVaultState, type MalwareScanner, type MalwareScanOutcome } from "@abos/persistence";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { keys, ReportDatabase, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Migration 0067: agreements join the Document Vault, the older agreement lane is retired, and an existing agreement file enters the vault only
 * through an explicit operator import that scans its real bytes. Everything here is synthetic and runs on a disposable database.
 */

type Attached = { id: string; storageId: string; replayed: boolean };
type Listed = { canRead: boolean; canAttach: boolean; documents: { id: string; title: string; scanStatus: string; subjectType?: string; agreementReference?: string | null }[] };
type Opened = { id: string; storageId: string; sha256: string };

const DAY = "2026-09-15";
const NOT_FOUND = /document (subject )?not found/;
const NOT_CLEARED = /not cleared for opening/;
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A scanner whose answer the test chooses. It records what it was asked, so a test can prove a file was or was not scanned. */
function scannerSaying(outcome: MalwareScanOutcome): MalwareScanner & { asked: string[] } {
  const asked: string[] = [];
  return { engine: "windows-defender", asked, scan: async (filePath: string) => { asked.push(filePath); return { outcome, engine: "windows-defender", detail: outcome === "INFECTED" ? "Synthetic threat" : null }; } };
}

if (databaseUrl() === undefined) {
  test("0067 agreement documents", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0067: agreements in the Document Vault, and the legacy agreement file", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let root: string; let storage: PrivateDocumentStorage; let agreementId: string; let reader: Session;

    const attach = (s: Session, subjectType: string, subjectId: string | null, extra: object = {}) => db.call<Attached>("document_attach", s, {
      subjectType, subjectId, storageId: randomUUID(), originalFileName: "synthetic-agreement.pdf", mediaType: "application/pdf", byteSize: 1200, sha256: "b".repeat(64),
      title: "Synthetic agreement", documentDate: DAY, ...keys(), ...extra });
    const list = (s: Session, subjectType: string, subjectId: string | null) => db.call<Listed>("document_list", s, { subjectType, subjectId });
    const open = (s: Session, id: string) => db.call<Opened>("document_open", s, id, randomUUID());
    const scan = (s: Session, linkId: string, outcome: string) => db.call<{ scanStatus: string }>("document_scan_record", s,
      { linkId, outcome, engine: "windows-defender", detail: null, correlationId: randomUUID() });
    const count = async (sql: string, parameters: unknown[] = []) => Number((await db.h.pool.query<{ n: string }>(sql, parameters)).rows[0]?.n);
    const evidenceFor = (agreement: string) => count("SELECT count(*) AS n FROM abos.capital_agreement_evidence WHERE capital_agreement_id = $1", [agreement]);
    const newAgreement = async () => (await db.call<{ capitalAgreementId: string }>("shareholder_setup_create_agreement", f.creator, {
      shareholderProfileId: f.world.shareholderProfileId, agreementReference: `SYN-VAULT-${randomUUID().slice(0, 8)}`, committedAmount: "1000", currencyCode: "USD",
      effectiveOn: DAY, ...keys() })).capitalAgreementId;

    /** An agreement file as the older lane stored it before 0067: metadata rows, and the bytes in the vault unless told otherwise. */
    const legacyFile = async (options: { bytes?: Uint8Array; store?: Uint8Array | null; name?: string } = {}) => {
      const bytes = options.bytes ?? pdf(randomUUID());
      const evidenceReference = randomUUID(); const evidence = randomUUID(); const storageId = randomUUID();
      const version = 1 + await count("SELECT coalesce(max(version), 0) AS n FROM abos.capital_agreement_evidence WHERE capital_agreement_id = $1", [f.world.agreementId]);
      await db.h.pool.query(`INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
        VALUES ($1, $2, gen_random_uuid(), 'CAPITAL_AGREEMENT', 1, $3, clock_timestamp())`, [evidenceReference, f.e, sha(bytes)]);
      await db.h.pool.query(`INSERT INTO abos.capital_agreement_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date,
        recorded_by_user_account_id) VALUES ($1, $2, $3, $4, $5, 'Synthetic legacy agreement', '2026-09-01', $6)`, [evidence, f.e, f.world.agreementId, evidenceReference, version, f.world.bootstrapUserId]);
      await db.h.pool.query(`INSERT INTO abos.capital_agreement_document_files (agreement_evidence_id, legal_entity_id, capital_agreement_id, storage_id, original_file_name, media_type,
        byte_size, sha256, uploaded_by_user_account_id) VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8)`,
      [evidence, f.e, f.world.agreementId, storageId, options.name ?? "legacy-agreement.pdf", bytes.byteLength, sha(bytes), f.world.bootstrapUserId]);
      const stored = options.store === undefined ? bytes : options.store;
      if (stored !== null) await storage.write(storageId, "legacy-agreement.pdf", stored);
      return { evidence, storageId, sha256: sha(bytes) };
    };
    const runImport = async (scanner: MalwareScanner, evidence: string) => (await importLegacyAgreementDocuments(db.h.executor, storage, scanner)).find((r) => r.agreementEvidenceId === evidence);
    const legacyRow = async (evidence: string) => (await db.h.pool.query("SELECT to_jsonb(f) AS row FROM abos.capital_agreement_document_files f WHERE agreement_evidence_id = $1", [evidence])).rows[0];

    before(async () => {
      await db.open();
      f = await db.company();
      root = await mkdtemp(path.join(tmpdir(), "abos-vault-0067-"));
      storage = new PrivateDocumentStorage(root);
      agreementId = await newAgreement();
      reader = await db.person(f.world, "Agreement Reader", ["shareholder.read"]);
    });
    after(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });

    test("an agreement document follows the agreement's rule: a dated file from a setup manager, readable by shareholder readers once cleared", async () => {
      await assert.rejects(() => attach(f.creator, "AGREEMENT", agreementId, { documentDate: null }), /agreement document needs its date/);
      await assert.rejects(() => attach(reader, "AGREEMENT", agreementId), NOT_FOUND, "reading agreements does not allow attaching to them");
      const attached = await attach(f.creator, "AGREEMENT", agreementId, { title: "Signed capital agreement" });
      await assert.rejects(() => open(reader, attached.id), NOT_CLEARED);
      assert.equal((await scan(f.creator, attached.id, "CLEAN")).scanStatus, "CLEAN");
      assert.equal((await open(reader, attached.id)).id, attached.id);
      const loanReader = await db.person(f.world, "Loan Reader", ["finance.loan.read", "finance.report.operational.read"]);
      await assert.rejects(() => list(loanReader, "AGREEMENT", agreementId), NOT_FOUND);
      await assert.rejects(() => open(loanReader, attached.id), NOT_FOUND);
      await assert.rejects(() => attach(f.creator, "AGREEMENT", randomUUID()), NOT_FOUND, "an agreement that does not exist is not found");
      await assert.rejects(() => list(f.creator, "AGREEMENT", f.world.shareholderProfileId), NOT_FOUND, "a shareholder is not an agreement");
    });

    test("another company reaches no agreement document, whatever it knows", async () => {
      const attached = await attach(f.creator, "AGREEMENT", agreementId);
      await scan(f.creator, attached.id, "CLEAN");
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Agreement Other','USD','APPROVED')`,
        [other, f.world.companyId, `AGR-${other.slice(0, 8)}`]);
      const stranger = await db.person({ ...f.world, legalEntityId: other }, "Foreign Shareholder Manager", ["shareholder.setup.manage", "shareholder.read"]);
      await assert.rejects(() => list(stranger, "AGREEMENT", agreementId), NOT_FOUND);
      await assert.rejects(() => open(stranger, attached.id), NOT_FOUND);
      await assert.rejects(() => attach(stranger, "AGREEMENT", agreementId), NOT_FOUND);
      await assert.rejects(() => scan(stranger, attached.id, "CLEAN"), NOT_FOUND);
      const refused = await open(stranger, attached.id).catch((error: Error) => error.message);
      const unknown = await open(stranger, randomUUID()).catch((error: Error) => error.message);
      assert.equal(refused, unknown, "a refused document and an unknown one are the same answer");
    });

    test("only a cleared agreement document becomes evidence: locked, failed and blocked files never do", async () => {
      const agreement = await newAgreement();
      const pending = await attach(f.creator, "AGREEMENT", agreement);
      const failed = await attach(f.creator, "AGREEMENT", agreement);
      const blocked = await attach(f.creator, "AGREEMENT", agreement);
      assert.equal((await scan(f.creator, failed.id, "UNAVAILABLE")).scanStatus, "SCAN_FAILED");
      assert.equal((await scan(f.creator, blocked.id, "INFECTED")).scanStatus, "INFECTED");
      assert.equal(await evidenceFor(agreement), 0);
      const cleared = await attach(f.creator, "AGREEMENT", agreement, { title: "Version one" });
      await scan(f.creator, cleared.id, "CLEAN");
      assert.equal((await scan(f.creator, failed.id, "CLEAN")).scanStatus, "CLEAN", "a failed scan can be retried");
      const rows = (await db.h.pool.query<{ version: number; document_reference: string }>("SELECT version, document_reference FROM abos.capital_agreement_evidence WHERE capital_agreement_id = $1 ORDER BY version", [agreement])).rows;
      assert.deepEqual(rows.map((r) => [r.version, r.document_reference]), [[1, "Version one"], [2, "Synthetic agreement"]], "numbered in the order they cleared");
      assert.equal((await scan(f.creator, cleared.id, "CLEAN")).scanStatus, "CLEAN");
      assert.equal(await evidenceFor(agreement), 2, "a verdict already recorded adds no evidence");
      void pending;
    });

    test("a shareholder's list includes their agreements' documents, marked, and nobody gains access through it", async () => {
      const attached = await attach(f.creator, "AGREEMENT", agreementId, { title: "Agreement on the holder card" });
      await scan(f.creator, attached.id, "CLEAN");
      const view = await list(reader, "SHAREHOLDER", f.world.shareholderProfileId);
      const row = view.documents.find((d) => d.id === attached.id);
      assert.equal(row?.subjectType, "AGREEMENT");
      assert.match(row?.agreementReference ?? "", /^SYN-VAULT-/);
      const stranger = await db.person(f.world, "Expense Reader", ["finance.expense.read"]);
      await assert.rejects(() => list(stranger, "SHAREHOLDER", f.world.shareholderProfileId), NOT_FOUND);
    });

    test("starting a scan is audited, and only while the document is still undecided", async () => {
      const attached = await attach(f.creator, "AGREEMENT", agreementId);
      const started = () => count("SELECT count(*) AS n FROM abos.audit_records WHERE action = 'DOCUMENT_SCAN_STARTED' AND entity_id = $1", [attached.id]);
      await db.call("document_scan_target", f.creator, attached.id);
      assert.equal(await started(), 1);
      await scan(f.creator, attached.id, "CLEAN");
      await db.call("document_scan_target", f.creator, attached.id);
      assert.equal(await started(), 1, "a decided document starts no scan");
    });

    test("the older agreement lane is retired: the runtime cannot store, hold or serve a file through it", async () => {
      for (const signature of ["shareholder_agreement_document_prepare(text,text,text,uuid)", "shareholder_agreement_document_finalize(text,text,text,jsonb)",
        "shareholder_agreement_document_read(text,text,text,uuid)", "direct_shareholder_document_holder(text,text,text,jsonb)"]) {
        const row = (await db.h.pool.query<{ ok: boolean }>("SELECT has_function_privilege('abos_e1_runtime', $1, 'EXECUTE') AS ok", [`abos.${signature}`])).rows[0];
        assert.equal(row?.ok, false, signature);
      }
      await assert.rejects(() => db.call("shareholder_agreement_document_finalize", f.creator, { capitalAgreementId: agreementId }), /permission denied/);
      await assert.rejects(() => db.call("direct_shareholder_document_holder", f.creator, { shareholderProfileId: f.world.shareholderProfileId }), /permission denied/);
    });

    test("a clean legacy file is registered once, keeps its identity and history, and opens through the vault", async () => {
      const legacy = await legacyFile();
      const beforeRow = await legacyRow(legacy.evidence);
      const beforeEvidence = await evidenceFor(f.world.agreementId);
      const journals = await count("SELECT count(*) AS n FROM abos.journals");
      const scanner = scannerSaying("CLEAN");
      assert.deepEqual(await runImport(scanner, legacy.evidence), { agreementEvidenceId: legacy.evidence, status: "IMPORTED" });
      assert.equal(scanner.asked.length, 1, "the stored bytes were scanned");
      const imported = (await db.h.pool.query<{ document_id: string; link_id: string; performed_by: string }>(
        "SELECT document_id, link_id, performed_by FROM abos.document_legacy_imports WHERE agreement_evidence_id = $1 AND outcome = 'IMPORTED'", [legacy.evidence])).rows[0];
      assert.ok(imported);
      const document = (await db.h.pool.query<{ storage_id: string; sha256: string; uploaded_by_user_account_id: string }>("SELECT storage_id, sha256, uploaded_by_user_account_id FROM abos.documents WHERE id = $1",
        [imported.document_id])).rows[0];
      assert.deepEqual([document?.storage_id, document?.sha256, document?.uploaded_by_user_account_id], [legacy.storageId, legacy.sha256, f.world.bootstrapUserId], "same bytes, same uploader");
      const opened = await open(reader, imported.link_id);
      assert.deepEqual([opened.storageId, opened.sha256], [legacy.storageId, legacy.sha256]);
      assert.equal((await list(reader, "AGREEMENT", f.world.agreementId)).documents.find((d) => d.id === imported.link_id)?.scanStatus, "CLEAN");
      assert.deepEqual(await legacyRow(legacy.evidence), beforeRow, "the legacy record is untouched");
      assert.equal(await evidenceFor(f.world.agreementId), beforeEvidence, "no second evidence record: the agreement already has this one");
      assert.equal(await count("SELECT count(*) AS n FROM abos.journals"), journals);
      const audit = (await db.h.pool.query<{ actor: string | null; operator: string }>(
        "SELECT actor_user_account_id AS actor, metadata->>'operator' AS operator FROM abos.audit_records WHERE action = 'DOCUMENT_LEGACY_IMPORTED' AND entity_id = $1", [imported.link_id])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.actor, null, "no person performed the import");
      assert.equal(audit[0]?.operator, imported.performed_by);
      // Again: nothing new, and the scanner is not even asked.
      const again = scannerSaying("CLEAN");
      assert.equal(await runImport(again, legacy.evidence), undefined, "an imported file is no longer a candidate");
      assert.equal(await db.h.pool.query<{ value: { status: string } }>("SELECT abos.document_import_legacy_agreement($1, $2, $3, 'CLEAN', 'windows-defender', NULL) AS value",
        [legacy.evidence, 1, legacy.sha256]).then((r) => r.rows[0]?.value.status), "ALREADY_IMPORTED");
      assert.equal(await count("SELECT count(*) AS n FROM abos.documents WHERE storage_id = $1", [legacy.storageId]), 1);
      const state = await readDocumentVaultState(db.h.executor);
      assert.equal(state.objects.find((o) => o.storageId === legacy.storageId)?.source, "IMPORTED_AGREEMENT");
      assert.deepEqual(state.integrity, [], "the database finds nothing wrong");
    });

    test("bytes that do not match, or cannot be read, are not scanned and not registered", async () => {
      const changed = await legacyFile({ store: pdf("different bytes") });
      const missing = await legacyFile({ store: null });
      const scanner = scannerSaying("CLEAN");
      const results = await importLegacyAgreementDocuments(db.h.executor, storage, scanner);
      for (const legacy of [changed, missing]) {
        assert.deepEqual(results.find((r) => r.agreementEvidenceId === legacy.evidence), { agreementEvidenceId: legacy.evidence, status: "BLOCKED", scanOutcome: "FINGERPRINT_MISMATCH" });
        assert.equal(await count("SELECT count(*) AS n FROM abos.documents WHERE storage_id = $1", [legacy.storageId]), 0);
        assert.ok(!scanner.asked.includes(storage.scanPath(legacy.storageId)), "a file that does not match its record is never scanned");
      }
      const detail = (await db.h.pool.query<{ detail: string }>("SELECT detail FROM abos.document_legacy_imports WHERE agreement_evidence_id = $1", [missing.evidence])).rows[0]?.detail;
      assert.equal(detail, "The stored file could not be read.");
    });

    test("a threat is final for a legacy file too, while a scanner that is down can be retried", async () => {
      // The import takes every file not yet in the vault, so each fixture is created just before the run that is meant to see it.
      const infected = await legacyFile();
      assert.equal((await runImport(scannerSaying("INFECTED"), infected.evidence))?.scanOutcome, "INFECTED");
      const down = await legacyFile();
      assert.equal((await runImport(scannerSaying("UNAVAILABLE"), down.evidence))?.scanOutcome, "UNAVAILABLE");
      const later = await importLegacyAgreementDocuments(db.h.executor, storage, scannerSaying("CLEAN"));
      assert.deepEqual(later.find((r) => r.agreementEvidenceId === infected.evidence), { agreementEvidenceId: infected.evidence, status: "BLOCKED", scanOutcome: "INFECTED" });
      assert.equal(later.find((r) => r.agreementEvidenceId === down.evidence)?.status, "IMPORTED");
      assert.equal(await count("SELECT count(*) AS n FROM abos.documents WHERE storage_id = $1", [infected.storageId]), 0);
      assert.equal(await count("SELECT count(*) AS n FROM abos.document_legacy_imports WHERE agreement_evidence_id = $1", [infected.evidence]), 1, "a final answer adds no attempts");
      assert.ok(await storage.read(infected.storageId), "the blocked bytes stay where they were, untouched");
    });

    test("two imports of one file at the same moment register it once", async () => {
      const legacy = await legacyFile();
      const size = (await db.h.pool.query<{ byte_size: string }>("SELECT byte_size FROM abos.capital_agreement_document_files WHERE agreement_evidence_id = $1", [legacy.evidence])).rows[0]?.byte_size;
      const call = () => db.h.pool.query<{ value: { status: string } }>("SELECT abos.document_import_legacy_agreement($1, $2, $3, 'CLEAN', 'windows-defender', NULL) AS value",
        [legacy.evidence, size, legacy.sha256]).then((r) => r.rows[0]?.value.status);
      assert.deepEqual((await Promise.all([call(), call(), call()])).sort(), ["ALREADY_IMPORTED", "ALREADY_IMPORTED", "IMPORTED"]);
      assert.equal(await count("SELECT count(*) AS n FROM abos.documents WHERE storage_id = $1", [legacy.storageId]), 1);
    });

    test("the import and the reconciliation reads are the operator's alone", async () => {
      for (const signature of ["document_import_legacy_agreement(uuid,bigint,text,text,text,text)", "document_vault_integrity()", "document_vault_manifest()",
        "document_agreement_evidence(uuid,uuid,uuid,text,text,date,uuid)"]) {
        const row = (await db.h.pool.query<{ runtime: boolean; everyone: boolean }>(
          "SELECT has_function_privilege('abos_e1_runtime', $1, 'EXECUTE') AS runtime, has_function_privilege('public', $1, 'EXECUTE') AS everyone", [`abos.${signature}`])).rows[0];
        assert.deepEqual([row?.runtime, row?.everyone], [false, false], signature);
      }
      await assert.rejects(() => db.runtime.query("SELECT id FROM abos.document_legacy_imports"), /permission denied/);
      await assert.rejects(() => db.runtime.query("SELECT abos.document_import_legacy_agreement(gen_random_uuid(), 1, 'x', 'CLEAN', 'x', NULL)"), /permission denied/);
    });

    test("import history is append-only", async () => {
      const legacy = await legacyFile();
      await runImport(scannerSaying("UNAVAILABLE"), legacy.evidence);
      await assert.rejects(() => db.h.pool.query("UPDATE abos.document_legacy_imports SET outcome = 'IMPORTED' WHERE agreement_evidence_id = $1", [legacy.evidence]));
      await assert.rejects(() => db.h.pool.query("DELETE FROM abos.document_legacy_imports WHERE agreement_evidence_id = $1", [legacy.evidence]));
    });

    test("the integrity check names what is wrong, and says nothing when nothing is", async () => {
      assert.deepEqual((await readDocumentVaultState(db.h.executor)).integrity, []);
      const client = await db.h.pool.connect();
      try {
        await client.query("BEGIN");
        const lonely = randomUUID(); const shared = randomUUID(); const stray = randomUUID();
        const legacyStorage = (await client.query<{ storage_id: string }>("SELECT storage_id FROM abos.capital_agreement_document_files f WHERE NOT EXISTS (SELECT 1 FROM abos.documents d WHERE d.storage_id = f.storage_id) LIMIT 1")).rows[0]?.storage_id;
        assert.ok(legacyStorage);
        for (const [id, storageId] of [[lonely, randomUUID()], [shared, legacyStorage], [stray, randomUUID()]]) {
          await client.query(`INSERT INTO abos.documents (id, legal_entity_id, storage_id, original_file_name, media_type, byte_size, sha256, uploaded_by_user_account_id)
            VALUES ($1, $2, $3, 'synthetic.pdf', 'application/pdf', 10, $4, $5)`, [id, f.e, storageId, "c".repeat(64), f.world.bootstrapUserId]);
        }
        await client.query(`INSERT INTO abos.document_links (id, legal_entity_id, document_id, subject_type, subject_id, title, linked_by_user_account_id)
          VALUES (gen_random_uuid(), $1, $2, 'AGREEMENT', gen_random_uuid(), 'Points nowhere', $3), (gen_random_uuid(), $1, $4, 'AGREEMENT', $5, 'Shared bytes', $3)`,
        [f.e, stray, f.world.bootstrapUserId, shared, f.world.agreementId]);
        await client.query(`INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
          VALUES (gen_random_uuid(), $1, $2, 'CAPITAL_AGREEMENT', 1, $3, clock_timestamp())`, [f.e, stray, "c".repeat(64)]);
        const problems = (await client.query<{ problem: string }>("SELECT problem FROM abos.document_vault_integrity()")).rows.map((r) => r.problem);
        for (const expected of ["DOCUMENT_WITHOUT_LINK", "LINK_SUBJECT_MISSING", "SHARED_STORAGE_WITHOUT_IMPORT", "EVIDENCE_FOR_UNCLEARED_DOCUMENT"]) {
          assert.ok(problems.includes(expected), `${expected} in ${problems.join(", ")}`);
        }
      } finally { await client.query("ROLLBACK"); client.release(); }
      assert.deepEqual((await readDocumentVaultState(db.h.executor)).integrity, [], "nothing was left behind");
    });
  });
}
