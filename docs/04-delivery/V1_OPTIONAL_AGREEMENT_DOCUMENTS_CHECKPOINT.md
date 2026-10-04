# V1 optional shareholder agreement documents — isolated checkpoint

**Starting implementation checkpoint:** `28377dd458f618ddfa23f76adf5cba3aba2db331` on `codex/v1-optional-shareholder-documents` (based on the accepted `e940df515efdb49f10980fddbc82b1b155ac4f15` integration checkpoint).
**Scope:** Owner-approved Al-Beruniy policy that a physical agreement document is optional for shareholder and draft-agreement setup. This is not approval for a capital receipt or posting.

## Implemented in the isolated branch

- Migration 0033 adds a legal-entity-scoped `capital_agreement_document_policies` table. A missing row remains `REQUIRED`; only the exact Al-Beruniy legal entity identified at checkpoint 0032 receives `OPTIONAL`. The row records this owner decision. No existing shareholder, agreement, installment, evidence, Treasury or financial row is changed by the migration.
- The three existing read/request functions consult the policy when deciding whether a missing `CAPITAL_AGREEMENT` reference is a blocker. Other entities remain subject to the prior document check. The synthetic-only capital request gate and all Treasury, Finance and General Ledger controls remain unchanged.
- The shareholder domain's in-memory and PostgreSQL adapters use the same per-entity decision. Draft shareholder, agreement and installment setup already works without a document.
- The English/Dari shareholder screen never asks for a manually typed SHA-256. It identifies the agreement document as optional for Al-Beruniy, supports upload/view/download/version history, and keeps legacy reference-only records visibly distinct from retained files.

## Private file retention implemented in migration 0034

The existing Documents page is a Stage 0 fixture browser and has no storage adapter. Reusing it would have falsely implied that its preview records were operational. This checkpoint therefore adds one narrow private vault for capital-agreement attachments without turning the general Documents preview into an operational module.

- `ABOS_DOCUMENT_STORAGE_ROOT` must name an absolute private directory outside `public` and `.next`. File bytes are stored there under server-generated UUID identifiers; original names never become paths and there are no public URLs.
- Upload and download are authenticated server routes. Every request derives the user and legal entity from the live database session, then calls agreement-scoped `SECURITY DEFINER` functions requiring `shareholder.setup.manage` or `shareholder.read`. Runtime credentials receive no document-table write privilege.
- The server permits only PDF, JPEG and PNG, validates byte signatures rather than the browser MIME declaration, caps files at 10 MiB, normalizes the retained display name, and computes SHA-256 from the received bytes. It never accepts a caller-entered digest. A bounded stream reader enforces the multipart envelope limit even when a chunked request has no `Content-Length` header.
- File creation is staged, flushed and atomically linked into the vault with create-only semantics. Existing object identifiers cannot be replaced. A failed database finalize removes only a candidate this request successfully created; a storage-ID collision cannot delete an existing immutable object. Finalized versions cannot be updated or deleted and uploading again creates the next immutable version.
- Migration 0034 links each metadata row to exactly one legal entity and capital agreement. Download reauthorizes the current session and rechecks the stored byte length and SHA-256 before returning `private, no-store`, `nosniff` content.
- Audit rows contain the agreement/evidence IDs, version, MIME type, length and digest; file contents and original names are excluded. A matching digest proves byte integrity only. It does not prove signatures, registration, legal validity or shareholder identity and cannot activate an agreement or authorize a receipt.

Legacy 0031 reference/digest rows remain visible as `Earlier reference only; no stored file`. They are never presented as uploaded files.

## Backup and restore pairing

A PostgreSQL backup does not contain vault bytes. An operator must quiesce uploads, take the PostgreSQL backup, export the corresponding immutable file metadata, and create a vault backup with `createDocumentVaultBackup`. The backup contains a versioned manifest plus every referenced object, and creation fails on any missing or mismatched byte length/digest. Restore the matching PostgreSQL backup and vault together; `restoreDocumentVaultBackup` requires its manifest to exactly equal the database metadata supplied by the operator, verifies every object, and refuses to replace an existing object. Disk encryption, offline-media encryption, retention and disaster-recovery custody remain deployment responsibilities; this local V1 slice does not invent those company policies.

Normal failed uploads remove their unlinked candidate. A process or power loss at the narrow boundary between object creation and metadata finalization can leave an unreferenced object. It has no database ID exposed through the application and is therefore inaccessible to users. `auditDocumentVault` compares the vault with an exact PostgreSQL metadata export and reports missing, corrupted and unexpected objects for operator review; it never silently deletes anything. Stale `.part` files and reported unexpected objects must be investigated before an explicit cleanup decision. Finalized objects are never silently deleted or replaced.

**Deployment boundary:** migrations 0033 and 0034 have not been applied to `abos_v1_local_review`. The real shareholder, draft agreement, installment, policies and permissions remain untouched. Test databases and vaults must be disposable; never run schema-reset tests against the preserved review database.

## Validation on disposable infrastructure

- Private-vault unit tests pass 9/9, covering signature validation, server digesting, size limits, path rejection, create-only immutability, exact-manifest backup and restore, and version preservation.
- PostgreSQL shareholder setup/security tests pass 12/12, including optional setup, agreement-specific linkage, live permission checks, cross-entity denial, version history, runtime table denial and no Treasury/GL side effect.
- The operational browser flow passes 1/1 with a disposable database and vault: optional setup without a file, two uploads, authorized view/download, automatic SHA-256, invalid and oversized rejection, signed-out and unauthorized download denial, English/Dari, RTL and phone layout.
- Migration 0034 SHA-256 is `2b9e9dd2823d5270dc4a73bc4d372cb16ed790588cb9c77a14b0111af5df7ead`, exactly matching the committed migration registry.
- Lint passes with zero warnings; strict typecheck passes all 12 workspace packages.
- Unit tests pass 136/136, including 9/9 private-vault tests.
- The complete serial PostgreSQL suite passes 174/174 with zero failures or skips.
- The Next.js production build passes and includes both authenticated document routes.
- Smoke tests pass 7/7.
- The complete serial browser suite passes 52/52 with every guarded database journey enabled and no skipped tests. This includes optional setup without a document, two immutable upload versions, authorized view/download, server-computed SHA-256, invalid and oversized rejection, signed-out and unauthorized denial, cross-entity enforcement, Dari/RTL, phone layout, and zero Treasury/General Ledger side effects.
- Two legacy disposable fixture scripts now use their fixed September 2026 source date instead of the wall clock. This keeps their source inside their fixed synthetic open period and removes a calendar-dependent test failure; production transaction dating is unchanged.
