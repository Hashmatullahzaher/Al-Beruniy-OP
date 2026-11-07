import { createHash } from "node:crypto";

import type { SqlExecutor } from "@abos/database";

import type { MalwareScanner, MalwareScanOutcome } from "./malware-scanner.ts";
import { auditDocumentVault, type PrivateDocumentStorage } from "./private-document-storage.ts";

/**
 * Operator work on the Document Vault (migration 0067). Both run as the operator who owns the schema, never as the application runtime.
 *
 * - Reconciliation is read-only. It compares what the database says the vault holds with the files, and reports; it never fixes anything.
 * - The legacy import brings an existing agreement file into the vault only after a real scan of the stored bytes passes. It is explicit,
 *   idempotent and recorded attempt by attempt, and it never changes the legacy row or the file.
 */

export type VaultObjectSource = "AGREEMENT" | "DOCUMENT" | "IMPORTED_AGREEMENT";

export interface VaultObject {
  readonly storageId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly source: VaultObjectSource;
  /** Null for an agreement file that was never brought into the vault. */
  readonly scanStatus: string | null;
}

export interface VaultIntegrityProblem {
  readonly problem: string;
  readonly reference: string;
  readonly detail: string | null;
}

export interface VaultReconciliation {
  readonly clean: boolean;
  readonly objects: number;
  readonly storedObjects: number;
  readonly bySource: Readonly<Record<VaultObjectSource, number>>;
  readonly byScan: Readonly<Record<string, number>>;
  readonly missing: readonly string[];
  readonly corrupted: readonly string[];
  readonly unexpected: readonly string[];
  /** CLEAN documents whose file is gone or changed. They are also in missing or corrupted, and they are the most serious finding. */
  readonly trustedMissing: readonly string[];
  readonly trustedChanged: readonly string[];
  /** Blocked files that antivirus removed itself. Expected, reported apart, and never hiding a file that is truly missing. */
  readonly removedAfterBlock: readonly string[];
  readonly duplicateStorage: readonly string[];
  readonly unexpectedScanState: readonly string[];
  readonly integrity: readonly VaultIntegrityProblem[];
}

const DOCUMENT_STATES = new Set(["PENDING", "SCAN_FAILED", "CLEAN", "INFECTED"]);

export async function reconcileDocumentVault(storage: PrivateDocumentStorage, objects: readonly VaultObject[],
  integrity: readonly VaultIntegrityProblem[]): Promise<VaultReconciliation> {
  const seen = new Set<string>();
  const duplicateStorage = objects.filter((object) => seen.has(object.storageId) || !seen.add(object.storageId)).map((object) => object.storageId);
  const unexpectedScanState = objects.filter((object) => object.source === "AGREEMENT"
    ? object.scanStatus !== null
    : object.scanStatus === null || !DOCUMENT_STATES.has(object.scanStatus)
      || (object.source === "IMPORTED_AGREEMENT" && object.scanStatus !== "CLEAN")).map((object) => object.storageId);
  const audit = await auditDocumentVault(storage, objects);
  const status = new Map(objects.map((object) => [object.storageId, object.scanStatus]));
  const removedAfterBlock = audit.missing.filter((id) => status.get(id) === "INFECTED");
  const missing = audit.missing.filter((id) => status.get(id) !== "INFECTED");
  const trustedMissing = missing.filter((id) => status.get(id) === "CLEAN");
  const trustedChanged = audit.corrupted.filter((id) => status.get(id) === "CLEAN");
  const bySource = { AGREEMENT: 0, DOCUMENT: 0, IMPORTED_AGREEMENT: 0 } as Record<VaultObjectSource, number>;
  const byScan: Record<string, number> = {};
  for (const object of objects) {
    bySource[object.source] = (bySource[object.source] ?? 0) + 1;
    const key = object.scanStatus ?? "NOT_IN_VAULT";
    byScan[key] = (byScan[key] ?? 0) + 1;
  }
  const storedObjects = (await storage.listStorageIds()).length;
  const clean = missing.length === 0 && audit.corrupted.length === 0 && audit.unexpected.length === 0 && duplicateStorage.length === 0
    && unexpectedScanState.length === 0 && integrity.length === 0;
  return { clean, objects: objects.length, storedObjects, bySource, byScan, missing, corrupted: audit.corrupted, unexpected: audit.unexpected,
    trustedMissing, trustedChanged, removedAfterBlock, duplicateStorage, unexpectedScanState, integrity };
}

/** Reads what reconciliation needs, as the operator. Both functions are operator-only in the database. */
export async function readDocumentVaultState(executor: SqlExecutor): Promise<{ objects: VaultObject[]; integrity: VaultIntegrityProblem[] }> {
  const objects = await executor.query<{ storage_id: string; byte_size: string | number; sha256: string; source: VaultObjectSource; scan_status: string | null }>(
    "SELECT storage_id, byte_size, sha256, source, scan_status FROM abos.document_vault_manifest()");
  const integrity = await executor.query<{ problem: string; reference: string; detail: string | null }>(
    "SELECT problem, reference, detail FROM abos.document_vault_integrity()");
  return {
    objects: objects.rows.map((row) => ({ storageId: row.storage_id, byteSize: Number(row.byte_size), sha256: row.sha256, source: row.source, scanStatus: row.scan_status })),
    integrity: integrity.rows.map((row) => ({ problem: row.problem, reference: row.reference, detail: row.detail }))
  };
}

export interface LegacyImportResult {
  readonly agreementEvidenceId: string;
  readonly status: "IMPORTED" | "ALREADY_IMPORTED" | "BLOCKED";
  readonly scanOutcome?: string;
}

/**
 * Brings each agreement file not yet in the vault through a real scan of its stored bytes. The bytes are checked against the record first;
 * a file that cannot be read, or does not match, is not scanned and is recorded as blocked. Running it again imports nothing twice.
 */
export async function importLegacyAgreementDocuments(executor: SqlExecutor, storage: PrivateDocumentStorage, scanner: MalwareScanner): Promise<LegacyImportResult[]> {
  const candidates = await executor.query<{ agreement_evidence_id: string; storage_id: string; original_file_name: string; byte_size: string | number; sha256: string }>(
    `SELECT f.agreement_evidence_id, f.storage_id, f.original_file_name, f.byte_size, f.sha256 FROM abos.capital_agreement_document_files f
      WHERE NOT EXISTS (SELECT 1 FROM abos.document_legacy_imports i WHERE i.agreement_evidence_id = f.agreement_evidence_id AND i.outcome = 'IMPORTED')
      ORDER BY f.uploaded_at, f.agreement_evidence_id`);
  const results: LegacyImportResult[] = [];
  for (const row of candidates.rows) {
    let observedSize: number | null = null;
    let observedSha: string | null = null;
    let outcome: MalwareScanOutcome = "UNAVAILABLE";
    let detail: string | null = null;
    let engine = scanner.engine;
    try {
      const bytes = await storage.read(row.storage_id);
      observedSize = bytes.byteLength;
      observedSha = createHash("sha256").update(bytes).digest("hex");
    } catch {
      detail = "The stored file could not be read.";
    }
    if (observedSha !== null && observedSha === row.sha256 && observedSize === Number(row.byte_size)) {
      const verdict = await scanner.scan(storage.scanPath(row.storage_id), { fileName: row.original_file_name });
      outcome = verdict.outcome; detail = verdict.detail; engine = verdict.engine;
    } else if (detail === null) {
      detail = "The stored file does not match its record.";
    }
    const answer = await executor.query<{ value: { status: LegacyImportResult["status"]; scanOutcome?: string } }>(
      "SELECT abos.document_import_legacy_agreement($1, $2, $3, $4, $5, $6) AS value", [row.agreement_evidence_id, observedSize, observedSha, outcome, engine, detail]);
    const value = answer.rows[0]?.value;
    if (!value) throw new Error("the import returned nothing");
    results.push({ agreementEvidenceId: row.agreement_evidence_id, status: value.status, ...(value.scanOutcome ? { scanOutcome: value.scanOutcome } : {}) });
  }
  return results;
}
