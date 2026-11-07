# V1 Document Vault: audit and decision

Audited 2026-11-07 at trunk `176ae30`. The decision sets one document model for ABOS, built on the storage that already exists. The core is built in migration 0065: see `docs/04-delivery/V1_DOCUMENT_VAULT_0065.md`.

## Finding

ABOS has one good storage layer and one narrow use of it. Everything else records a fingerprint and keeps no file.

| Where | What exists | A file is kept? |
|---|---|---|
| Shareholder agreements | `capital_agreement_document_files`, upload and download routes | Yes, in the private vault |
| Direct shareholder capital | Reuses the agreement path through a holder row | Yes, same vault |
| `evidence_references` | Hash, kind and version, immutable | No |
| `registration_evidence` | Links a capital agreement to an evidence reference | No |
| `treasury_evidence_bindings` | Links cash counts and receipts to evidence references | No |
| `finance_approval_evidence_bindings` | Links approvals to evidence references | No |
| `shareholder_capital_evidence_registrations` | Reference text and hash | No |
| Temporary Funding | Hashes a file in the browser and says it is not uploaded | No |
| Expenses, receipts, payments, loans | Nothing | No, deferred to this slice by owner decision 3 |
| Company and legal documents | Nothing. The company profile holds a registration number only | No |
| `/documents` | `DocumentsWorkspace`, illustrative fixtures from Stage 0 | No |

Production holds one stored document.

## The storage layer

`PrivateDocumentStorage` in `packages/persistence` is sound, so it stays the only place file bytes go.

| Concern | What it does today |
|---|---|
| Location | `ABOS_DOCUMENT_STORAGE_ROOT`, absolute, refused inside `public` or `.next` |
| Object name | A random UUID, so a file name never reaches the disk path |
| Path traversal | The storage ID is matched against a UUID pattern, and the resolved path is checked against the root |
| Replacement | Written by hard link, which refuses an existing target, so a stored object cannot be overwritten |
| File type | Checked from the bytes, not the name or browser type. PDF, JPEG and PNG only |
| File size | 10 MB, enforced on the stream as well as the header |
| File name | Stripped to a safe leaf, with the extension taken from the detected type |
| Integrity | SHA-256 stored, and rechecked on every download |
| Download | Through the app only. `no-store`, `nosniff`, `X-Frame-Options: DENY` and the site content policy |
| Backup | Manifest, restore and read-only reconciliation against PostgreSQL |

There are no public object URLs and no signed URLs. A file is only reachable through an authorized route, so knowing an ID, a path or a URL gives nothing.

## Gaps

| Gap | Effect |
|---|---|
| One subject only | A document can belong only to a capital agreement |
| Bespoke metadata | Each new subject would need its own table, which is the pattern to stop |
| Downloads are not audited | An upload leaves an audit record and a read leaves none |
| The storage ID leaves the server | Agreement responses include it. It grants nothing, but it has no reason to be there |
| Error wording names agreements | The limits are generic and the messages are not |
| No document list per subject | Nothing can show a loan's or an expense's files |
| A header that never applied | The agreement route set a sandbox content policy, but the site-wide headers in `next.config.ts` override route headers, so it never reached a browser |

The sandbox header is removed rather than enforced. A sandbox policy can stop a browser showing a PDF inline, and that could not be tested here. A stored file is PDF, JPEG or PNG by its bytes, sent with that type and `nosniff`, so a browser will not treat it as a page. Adding a stricter policy is a change to make with a real browser to check it.

Deletion: nothing can delete a linked document. Metadata rows are immutable by trigger. `removeUnlinked` only cleans up after a failed upload. That is the right behaviour and it stays.

## Decision

**One document, many links.** Two tables, both append-only.

| Table | Holds |
|---|---|
| `documents` | One row per stored file: storage ID, safe name, type, size, hash, who and when |
| `document_links` | One row per attachment of a document to a subject, with a title and an optional date |

Subject types start as `COMPANY`, `SHAREHOLDER`, `LOAN`, `EXPENSE`, `RECEIPT` and `PAYMENT`. A future Purchase or Supplier adds a value and a permission pair, not a table.

### Access

A document has no permission of its own. Access comes from what it is attached to, checked at the moment of the request, inside the database.

| Subject | To read | To attach |
|---|---|---|
| `COMPANY` | `admin.company.manage` | `admin.company.manage` |
| `SHAREHOLDER` | `shareholder.read` or `shareholder.setup.manage` | `shareholder.setup.manage` |
| `LOAN` | `finance.loan.read` | `finance.loan.record` or `finance.loan.repay` |
| `EXPENSE` | `finance.expense.read`, within the person's scope | `finance.expense.create`, within the person's scope |
| `RECEIPT` | `treasury.safe.read` | `treasury.receipt.record` |
| `PAYMENT` | `treasury.safe.read` | `treasury.payment.record` |

These are permissions people already hold for those records, so the slice creates no permission and grants nothing.

- **Report readers gain nothing.** `finance.report.operational.read` appears nowhere above. A person who can see a total cannot open the document behind it.
- **Legal-entity isolation.** The entity comes from the session, never the request. A subject or document in another entity reads as not found.
- **A document reached through a subject.** The request names the link, not the document, so being able to read one subject never opens a document through another.
- **No storage ID leaves the server.** Responses carry the link ID, name, type, size and date.

### Immutability

Nothing is replaced or deleted. A corrected document is a new document, attached alongside the old one. Both stay visible and auditable. This holds whether or not the subject is posted, and attaching a file changes no journal, source row or report.

### Audit

Upload, link and download each write an audit record with the link, the type, the size and the hash. A refused read writes nothing, as with other refused reads.

**Scope.** An expense can belong to a project, department or cost center. A person outside that scope cannot see the expense, so they cannot reach its documents either, whatever permission they hold.

### Existing agreement documents

They stay where they are and keep working. Moving the one production row is not needed for this slice, and an agreement's versioning has rules of its own. Both sets of metadata point into the same vault, so the reconciliation must read both.

Temporary Funding stays compatibility only and is not extended.

### Evidence references

`evidence_references` stays the accounting evidence register. It answers "was this evidence provided", with a hash, for the capital workflow. A document is a stored file. A later slice can connect the two, but no accounting rule depends on a stored file today, and none is added here.

### Malware scanning (0066)

A new document is locked until it passes a scan. The safe state is the default: a document with no verdict is `PENDING`, and nothing has to be set for that to apply.

| State | Meaning | Can be opened |
|---|---|---|
| `PENDING` | No verdict yet, or every attempt so far failed | No |
| `CLEAN` | The scanner said so, for this file | Yes |
| `INFECTED` | The scanner found a threat. Final | No, and the file is kept |

- **A verdict is final.** `document_scan_results` is append-only, and a unique index allows one `CLEAN` or `INFECTED` per document. Two scans finishing together leave one verdict. A later scan cannot clear a blocked file or block a cleared one.
- **A failed scan decides nothing.** `UNAVAILABLE` records the attempt and leaves the document locked. Someone who may attach can press Check again.
- **The browser never states an outcome.** The scan route takes only the document's address. The server runs the scanner and records its answer.
- **Authorization comes first.** `document_open` checks access before scan state, so a stranger gets the plain not-found answer and cannot tell that a scan is pending.
- **The bytes are checked first.** The stored file must match its size and hash, so a verdict always belongs to the file on record.

The scanner is Windows Defender through `MpCmdRun.exe`, already on the production machine, so nothing is installed or downloaded. It is chosen by the server setting `ABOS_MALWARE_SCANNER=windows-defender`.

- There is no setting that turns scanning off, and no scanner that passes everything. A missing or unknown setting locks every new document.
- `MpCmdRun` exits with 2 both for a threat and for a file it could not scan, so the exit code alone is never trusted. `CLEAN` needs exit 0 and the sentence naming this file. `INFECTED` needs exit 2 and a threat count. Anything else is `UNAVAILABLE`.
- `-DisableRemediation` means the scan itself removes nothing. Real-time protection may still remove an infected object. Reconciliation reports that separately, so it cannot hide a genuinely missing file.

## Decision for the owner

**Decided 2026-11-07.**

- **Retention:** append-only and indefinite for V1. There is no automatic expiry and no destructive deletion. A document attached to a posted financial source is never silently replaced.
- **Malware scanning:** required before the vault enters production. See below.
- **Public links:** none, ever. A file is reached only through an authorized route.
- **Company documents:** stay restricted. `admin.company.manage` is not granted automatically. Super Administrator or another configured role may receive it through the normal audited permission workflow.

## Outside this slice

- Moving existing agreement files into the new tables.
- Connecting documents to `evidence_references`.
- Replacing the illustrative `/documents` page with a company-wide register. It needs a rule for what one person may list across subjects.
- Scanning agreement documents. That older upload lane is live and is not scanned. See `OPEN_ITEMS.md`.
- File types beyond PDF, JPEG and PNG.
