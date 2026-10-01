# V1 optional shareholder agreement documents — isolated checkpoint

**Starting checkpoint:** `e940df515efdb49f10980fddbc82b1b155ac4f15` on `v1/integration`.
**Scope:** Owner-approved Al-Beruniy policy that a physical agreement document is optional for shareholder and draft-agreement setup. This is not approval for a capital receipt or posting.

## Implemented in the isolated branch

- Migration 0033 adds a legal-entity-scoped `capital_agreement_document_policies` table. A missing row remains `REQUIRED`; only the exact Al-Beruniy legal entity identified at checkpoint 0032 receives `OPTIONAL`. The row records this owner decision. No existing shareholder, agreement, installment, evidence, Treasury or financial row is changed by the migration.
- The three existing read/request functions consult the policy when deciding whether a missing `CAPITAL_AGREEMENT` reference is a blocker. Other entities remain subject to the prior document check. The synthetic-only capital request gate and all Treasury, Finance and General Ledger controls remain unchanged.
- The shareholder domain's in-memory and PostgreSQL adapters use the same per-entity decision. Draft shareholder, agreement and installment setup already works without a document.
- The English/Dari shareholder screen no longer asks for a manually typed SHA-256 or implies that a reference-only record is an uploaded or legally verified document. It displays `No document attached / سند ضمیمه نشده`; the upload control remains disabled and explains that private storage is unavailable.

## Architectural gap: file upload is not implemented

`apps/web` has no private file-storage adapter, protected download route, scanning/quarantine workflow or document-byte retention system. Migration 0031 stores only a reference, date and caller-supplied SHA-256; it never receives a file. Those legacy metadata rows must not be labelled `Document uploaded` or used as proof of signing, registration, identity or legal validity. No file bytes are uploaded in this checkpoint.

The smallest safe subsequent upload slice needs:

1. A private, backed-up, encrypted object store with environment-specific credentials and an agreed retention/deletion policy.
2. A server-controlled upload endpoint that verifies a current session and legal-entity/document permission, enforces an approved size limit, checks actual PDF/image signatures, quarantines/scans bytes, computes SHA-256 from the received bytes, and writes immutable object/version metadata transactionally against the exact agreement.
3. An authorized, audited download path that rechecks current entity and permission for each request, serves private bytes without public file URLs, and never logs file contents or sensitive metadata.
4. Disposable-object-store and PostgreSQL tests for version history, digest correctness, corrupted/oversized/disguised files, interrupted uploads, revoked sessions, cross-entity denial, and no financial side effect; plus English/Dari desktop/mobile browser checks.

Do not enable the upload control or mark a file `Document uploaded / سند بارگذاری شد` until that complete path passes. A matching SHA-256 means only that bytes match a recorded digest; it is not legal authentication. Formal registration and Finance policy remain separate unresolved controls for any future real capital receipt.

**Deployment boundary:** 0033 has not been applied to `abos_v1_local_review`. The real shareholder, draft agreement, installment, policies and permissions remain untouched. Test databases and files must be disposable; never run schema-reset tests against the preserved review database.

## Validation on disposable infrastructure

- Lint, strict typecheck, production web build, and the unit suite passed.
- PostgreSQL shareholder setup/security tests passed (14/14). The full PostgreSQL integration run passed 173/174; its sole failure was an older upgrade test assuming 0032 was the last migration. That test was corrected to select 0032 by ID and then passed independently (1/1).
- PostgreSQL catalog inspection confirmed that all three replaced functions retain their prior `SECURITY DEFINER` owners; only their two owner roles can read the policy columns, and restricted runtime roles have no direct policy-table read or write privilege.
- The shareholder setup browser flow passed (1/1), including English/Dari desktop and mobile checks. The serial browser smoke suite passed (7/7).
- Upload, retrieval, SHA-256-from-file, and document-version tests are blocked because no private file storage exists. No claim of secure upload completion is made.
