# V1 Document Vault: agreements, the legacy file and the scan lifecycle (0067)

Not deployed. 0065, 0066 and 0067 deploy together, from one package, only on separate owner authorization. Production stays at 0064.

## Owner decisions this implements (2026-11-07)

- One canonical Document Vault: `documents` and `document_links`, over the existing `PrivateDocumentStorage`. No module keeps its own file store.
- Retention is append-only and indefinite. A correction is a new document beside the old one. Nothing is deleted or replaced.
- A document is usable only after a malware scan returns CLEAN. Pending, failed and infected files are locked, and an error is never clean.
- Company documents stay behind `admin.company.manage`, granted only through the normal audited permission workflow.
- New agreement files use the vault. The older agreement lane is not a normal route any more. The existing agreement file is kept, never rewritten, and its history is preserved.
- The Defender exclusion gate passed: the owner confirmed in an elevated session that no exclusion covers the vault.

## What was there before 0067

| Item | State at trunk 4cf9d3e |
|---|---|
| Migrations | 0065 (vault), 0066 (scanning), none later. Neither deployed. |
| Subjects | COMPANY, SHAREHOLDER, LOAN, EXPENSE, RECEIPT, PAYMENT. No agreement. |
| Scan states | PENDING, CLEAN, INFECTED. A failed attempt stayed PENDING. |
| Agreement files | `capital_agreement_document_files`, written by `shareholder_agreement_document_finalize` (0034, restated 0042) from two screens: the setup screen (`/shareholders/legacy`) and the shareholder card, which first created an attachment-only "holder" agreement. Served by `/api/v1/shareholder/setup/documents/{id}` with no malware scan. |
| Production | One agreement file: a real capital agreement linked to a shareholder, version 1, a PDF, uploaded 2026-10-06. Policy OPTIONAL. No holder agreement exists. |
| Reconciliation | A private tool reading the agreement table, or the 0066 manifest. |

## Design

### Agreements are a vault subject

`AGREEMENT` names a capital agreement of the same company. Its rule is the older lane's rule: `shareholder.setup.manage` attaches, `shareholder.read` or `shareholder.setup.manage` reads. A document for an agreement needs its date, because the agreement's evidence record requires one.

The setup screen shows a vault documents panel on each agreement card. The card's version list stays, because it is the agreement's evidence.

A direct shareholder has no agreement record. Their agreed total is a non-financial declaration, and the old "holder" agreement was an attachment anchor that activated nothing. So a direct shareholder's agreement file is the shareholder's own vault document, and no holder agreement is created any more. A shareholder's documents list also shows the documents of that shareholder's capital agreements, each marked with its agreement. Opening one still follows the agreement's own rule.

### Evidence appears only when a file is cleared

The older lane created the agreement's evidence record (`capital_agreement_evidence` and an `evidence_references` row) at upload. Under a REQUIRED policy that record lets a capital request proceed. In the vault, the record is created when the scan returns CLEAN, numbered per agreement as before, with `evidence_references.document_id` naming the vault document. A locked, failed or blocked file never satisfies an agreement's document requirement. The helper that writes it is internal: only the scan recorder can call it.

### The older lane is retired

The runtime loses EXECUTE on the legacy upload (`prepare`, `finalize`), the legacy download (`read`) and the holder (`direct_shareholder_document_holder`). The metadata list stays readable. The three routes answer 410 and point to the vault. Their rows stay as history, and nothing is deleted. Because the refusal is in PostgreSQL, the screens are not the only thing in the way.

### Scan lifecycle

| State | Meaning | Opens | Can be scanned again |
|---|---|---|---|
| PENDING | No attempt has finished | No | Yes |
| SCAN_FAILED | Every attempt so far failed: scanner missing, timed out, crashed, unreadable answer, or bytes that do not match the record | No | Yes |
| CLEAN | The real scanner said so, for these bytes | Yes | No, final |
| INFECTED | The real scanner found a threat | No | No, final, and the file is kept |

- The state is computed from append-only scan rows. One unique index allows at most one verdict per document, so two scans finishing together leave one.
- No request from a browser carries an outcome. The scan route takes only the document's address, and the server runs the scanner on the stored file at the storage path for that record. A client never supplies a path.
- Before scanning, the server checks the stored bytes against the record's size and hash. A mismatch is recorded as a failed attempt and never scanned.
- Opening re-checks the bytes on every request. A cleared file that later changes or disappears is refused (503) and reported by reconciliation.
- Authorization comes before state, so someone without access gets the plain not-found answer and cannot tell that a file is locked.
- Starting a scan is audited (`DOCUMENT_SCAN_STARTED`) as well as every result (`DOCUMENT_SCANNED`, including failures).

### Scanner

Windows Defender through `MpCmdRun.exe`, run with `execFile` (no shell), `-DisableRemediation`, and a 60-second timeout. Exit code 2 means both "threat" and "could not scan", so a verdict needs the exact sentence naming the file. Anything else is a failed attempt. There is no setting that turns scanning off. A missing or unknown setting locks every new document.

For automated tests, `ABOS_MALWARE_SCANNER_TEST_DOWNGRADES=1` wraps the configured scanner. The real scanner always runs first and its INFECTED always stands. Then a file whose name carries `test-infected`, `test-scan-fails` or `test-scan-fails-once` is answered more strictly. A CLEAN can only come from the real scanner, so the wrapper can lock documents but never clear one. The engine name records that it was on. Production must not set it, and the deployment verification refuses if it is present.

### The existing agreement file

An explicit operator import, never part of a migration, and never run on production without owner authorization. `importLegacyAgreementDocuments` reads each agreement file not yet in the vault, checks its bytes against the record, scans the stored bytes with the real scanner, and calls `abos.document_import_legacy_agreement` as the operator.

- **CLEAN, matching bytes:** a vault document with the same storage identity, file name, hash, original uploader and upload time, linked to the same agreement with the agreement's own reference and date, a CLEAN scan row attributed to `LEGACY_IMPORT` rather than a person, and an `IMPORTED` provenance row. No second evidence record is created, because the agreement already has this one.
- **Threat, failed scan, unreadable or mismatched bytes:** a `BLOCKED` attempt is recorded with the reason and nothing else changes. A threat is final for that file. A failed scan can be retried.
- **Repeat:** an imported file is no longer a candidate, and the function answers `ALREADY_IMPORTED`. A unique index and an advisory lock make concurrent runs register it once.
- The legacy row and the bytes are never touched. The import is audited with no actor and the operator's name.

### Reconciliation

`reconcileDocumentVault` in `@abos/persistence` is the one authoritative check. It is read-only and fixes nothing.

- Database side, `abos.document_vault_integrity()`: a document with no link, a link to a document of another company, a link whose subject does not exist in its company, a scan row of another company, a failed attempt recorded after a verdict, a vault document sharing a legacy file's storage without an import record, broken import provenance, a cleared agreement document with no evidence, and evidence pointing at a document that is not cleared.
- File side, from `abos.document_vault_manifest()` (one row per stored object): missing, changed and unrecorded files, a duplicated storage identity, and an impossible scan state. A cleared file that is missing or changed is reported separately as the most serious finding. A blocked file that antivirus removed is reported apart, and it never hides a file that is truly missing.

### Deletion and replacement

Not built, by decision. Every table here refuses UPDATE and DELETE by trigger. There is no unlink, no delete and no replace in the API or the screens. A correction is a new document. Any future detach or destruction needs a retention policy first.

## Privileges

- Definers go from 156 (0066) to 157: the internal evidence helper, owned by the shareholder setup owner and executable only by the operational finance owner.
- The import, the manifest and the integrity check are operator-only. Neither the runtime nor PUBLIC can execute them.
- No permission is created or granted. No role is changed. The migration writes no row.

## Limits

- The full lifecycle is proved through the browser on a production build with the real scanner and the downgrade-only wrapper. A real threat is not uploaded through the browser, because the standard test file is not a valid PDF and the type check correctly refuses it first. Real Defender threat output is proved at adapter level.
- Another company in the browser is not covered, because the first-run preview has one company. It is covered in the database tests, including identical refused and unknown answers.
