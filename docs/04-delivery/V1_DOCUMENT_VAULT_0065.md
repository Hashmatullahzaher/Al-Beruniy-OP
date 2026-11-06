# V1 Document Vault: migration 0065

The audit and the decision are in `docs/03-architecture/V1_DOCUMENT_VAULT_AUDIT_AND_DECISION.md`.

Not deployed. It comes after 0061 to 0064, and it is not in their deployment package.

## What was built

- **Two append-only tables:** `documents` for a stored file, and `document_links` for attaching it to a record. A database trigger refuses any change or removal.
- **One access rule:** `document_subject_allowed` decides read and attach from the record's type, the person's permissions and their company. An expense also follows the person's scope.
- **Four entry points:** prepare, attach, list and open. They are the runtime's only way in, and the runtime has no table access.
- **The same vault:** files go through `PrivateDocumentStorage`, with the same type check, size limit and integrity check as agreements.
- **Audit:** attaching and opening each write a record. A refused read writes nothing.
- **Screens:** a documents panel on the Loan, the Expense register and the Company page.

No permission is created or granted, and no row is written by the migration. Definers go from 150 to 154.

## What the screens do not offer yet

The database and API accept `SHAREHOLDER`, `RECEIPT` and `PAYMENT` subjects, and the tests prove them. No screen attaches to them yet. A receipt and a payment have no detail screen to hold the panel. A shareholder has its own agreement documents, and the two should be brought together deliberately.

## Before deployment

- The vault reconciliation must read `documents` as well as `capital_agreement_document_files`, or it will report new files as unexpected.
- The vault must be included in the deployment backup, as it already is.

## Also corrected

- **A header that never applied.** The agreement download set a sandbox content policy, but site-wide headers override route headers, so no browser ever received it. It is removed. The effective headers are unchanged, and the browser test now asserts what is really delivered.
- **Not-found and error pages** now follow the person's language.

## Tests

`packages/e1-integration/src/document-vault.test.ts` covers each subject's permissions, report readers, expense scope, another company, identical refused and unknown answers, audit, replay, validation, immutability and privileges.

`apps/web/tests/v1-document-vault.spec.ts` runs through real storage on a production build and inspects raw responses: a fake PDF is refused, a path in a file name is reduced to a leaf, the same bytes come back, the headers are right, no storage ID reaches the browser, and another person gets the same answer as an unknown address.

`apps/web/tests/v1-documents.spec.ts` covers what each person is offered, in English and Dari.
