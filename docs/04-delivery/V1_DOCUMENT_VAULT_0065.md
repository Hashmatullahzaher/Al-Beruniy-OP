# V1 Document Vault: migrations 0065, 0066 and 0067

The audit and the decision are in `docs/03-architecture/V1_DOCUMENT_VAULT_AUDIT_AND_DECISION.md`. Agreements, the legacy file and the scan lifecycle are in `docs/03-architecture/V1_DOCUMENT_VAULT_AGREEMENTS_0067.md`.

Not deployed. 0061 to 0064 are in production without it. 0065, 0066 and 0067 deploy together, from their own package, only on separate owner authorization.

## What was built

- **Two append-only tables:** `documents` for a stored file, and `document_links` for attaching it to a record. A database trigger refuses any change or removal.
- **One access rule:** `document_subject_allowed` decides read and attach from the record's type, the person's permissions and their company. An expense also follows the person's scope.
- **Four entry points:** prepare, attach, list and open. They are the runtime's only way in, and the runtime has no table access.
- **The same vault:** files go through `PrivateDocumentStorage`, with the same type check, size limit and integrity check as agreements.
- **Audit:** attaching and opening each write a record. A refused read writes nothing.
- **Screens:** a documents panel on the Loan, the Expense register, the Company page, the shareholder's card, and the journal of a receipt or a payment.
- **Malware scanning (0066):** a new document is locked until a scan passes. See the design record.
- **Agreements (0067):** capital agreements are a vault subject, the older agreement lane is retired, a failed scan shows as SCAN_FAILED, and the existing agreement file can be brought in by a guarded operator import.

No permission is created or granted, and no row is written by any of the three migrations. Definers go from 150 to 157.

## Where receipts and payments keep their documents

A receipt and a payment have no screen of their own. Their documents sit on the journal drill-down, which every Safe statement and report links to. The panel shows nothing to someone without access to that record, and nothing when the reader's view withholds the source.

## Before deployment

- Set `ABOS_MALWARE_SCANNER=windows-defender` in the production web environment. Without it every new document stays locked, which is safe but unusable.
- Reconciliation reads `abos.document_vault_manifest()` and `abos.document_vault_integrity()` once 0067 is applied, and the agreement table before that.
- After the migrations, the existing agreement file enters the vault only through the package's separate import step, which needs its own owner authorization.
- `ABOS_MALWARE_SCANNER_TEST_DOWNGRADES` must not be set in production.
- The vault must be included in the deployment backup, as it already is.
- No permission or role change is part of this deployment.

## Also corrected

- **A header that never applied.** The agreement download set a sandbox content policy, but site-wide headers override route headers, so no browser ever received it. It is removed. The effective headers are unchanged, and the browser test now asserts what is really delivered.
- **Not-found and error pages** now follow the person's language.

## Tests

`packages/e1-integration/src/document-vault.test.ts` covers each subject's permissions, report readers, expense scope, another company, identical refused and unknown answers, audit, replay, validation, immutability and privileges.

`apps/web/tests/v1-document-vault.spec.ts` runs through real storage on a production build and inspects raw responses: a fake PDF is refused, a path in a file name is reduced to a leaf, the same bytes come back, the headers are right, no storage ID reaches the browser, and another person gets the same answer as an unknown address.

`apps/web/tests/v1-documents.spec.ts` covers what each person is offered, in English and Dari.
