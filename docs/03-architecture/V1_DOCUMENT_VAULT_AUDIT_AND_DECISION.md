# V1 Document Vault: audit and decision

Audited 2026-11-07 at trunk `176ae30`. The decision sets one document model for ABOS, built on the storage that already exists.

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
| Download | Through the app only. `no-store`, `nosniff` and a sandbox content policy |
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
| `EXPENSE` | `finance.expense.read` | `finance.expense.create` |
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

### Existing agreement documents

They stay where they are and keep working. Moving the one production row is not needed for this slice, and an agreement's versioning has rules of its own. Both sets of metadata point into the same vault, so the reconciliation must read both.

Temporary Funding stays compatibility only and is not extended.

### Evidence references

`evidence_references` stays the accounting evidence register. It answers "was this evidence provided", with a hash, for the capital workflow. A document is a stored file. A later slice can connect the two, but no accounting rule depends on a stored file today, and none is added here.

## Decision for the owner

**Retention.** How long documents must be kept, and whether any may ever be destroyed, is an open legal question (`OPEN_ITEMS.md`). The design does not need it answered: nothing is deleted, so every choice stays available. Destruction, when wanted, would be its own reviewed feature.

## Outside this slice

- Moving existing agreement files into the new tables.
- Connecting documents to `evidence_references`.
- Replacing the illustrative `/documents` page with a company-wide register. It needs a rule for what one person may list across subjects.
- Virus scanning. No scanner exists on this installation. The type check and sandboxed delivery remain the defence.
- File types beyond PDF, JPEG and PNG.
