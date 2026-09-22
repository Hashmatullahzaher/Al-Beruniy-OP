# Stage 1 E0 — Shared Schema and API Contract Freeze

**Status:** E0 CONTRACT FREEZE — DEVELOPMENT ONLY
**Contract version:** `stage1-e0-v1`
**Coordination baseline:** `999a5335521fac5a9ac9b01b9e5d8261c47424d5`
**Stage 0 reference:** `a4ff484d357d22ba60ab1efd1650022bde9ab43c`
**Canonical typed contract SHA:** `8fb471475a76587b36414dfa3ab3f8dfc0cb0124`

This document freezes the shared names, ownership boundaries and wire-level invariants required for E0. It is not accounting-policy approval, a production API specification or authorization to post. The canonical TypeScript representation is the reviewed `packages/contracts` commit cited in the final handoff. Domain teams must not create competing ID, money, evidence, event, API-error or General Ledger contracts.

## 1. Scope and policy state

- The legal entity and policy version are explicit inputs; no global accounting-currency default applies.
- Supported transaction-currency values for this slice are `USD` and `AFN`.
- The first workflow target is a USD capital installment into a physical office-safe USD account. Posting, AFN conversion, Saraf transactions, cross-currency settlement and FX accounting remain operationally blocked under E0.
- There are no bank accounts in this slice. `CashLocationCurrencyAccount` is not a bank account; a Saraf party is not a bank or cash location.
- Policy configuration state is explicit: `SYNTHETIC_TEST_ONLY`, `OWNER_PROVISIONAL`, or `CLIENT_FINANCE_APPROVED`. Only the final state may be considered for future operational activation, and E0 cannot enable real posting.

## 2. Shared primitive freeze

### Identity and dimensions

Primary identifiers are opaque. The contract distinguishes company, legal entity, project, department, cost center, user account, business party, ledger account, document/evidence, domain source, posting/journal, correlation and idempotency identifiers.

`UserAccount` (actor), `BusinessParty` (shareholder/Saraf) and `LedgerAccount` are separate types and are never interchangeable.

Every transaction carries an explicit `legalEntityId` and one of:

- `COMPANY_LEVEL`, with a controlled reason such as `CORPORATE_CAPITAL`; or
- `PROJECT_LEVEL`, with project, department and cost-center identifiers.

Corporate capital must not receive an invented project merely to satisfy a field.

### Money

Money is `{ amount, currency }`, where `amount` is a canonical non-negative decimal string and `currency` is `USD | AFN`. JavaScript `number`, binary floating point, currency-less amounts and mixed-currency arithmetic are forbidden.

Accounting direction is represented by debit/credit fields or a typed operation, not by accepting an arbitrary negative source amount. Storage uses PostgreSQL `NUMERIC`; scale and rounding remain policy-gated.

### Dates and evidence

Keep `businessEventAt`, `evidenceCompletedAt`, `accountingEffectiveDate`, `approvedAt` and `postedAt` distinct. Evidence includes an opaque evidence ID, document ID, controlled kind, version, SHA-256 digest and completion time. A receipt/document number is not a database ID.

### Request and event metadata

Every retry-prone command carries an idempotency key and correlation ID. A domain-event envelope carries event ID, event type, schema version, occurrence time, legal entity, actor and correlation ID. Transactional-outbox persistence is a later prerequisite; the E0 type does not claim delivery is implemented.

## 3. Domain ownership freeze

| Domain | Owns | May produce | Must not do |
|---|---|---|---|
| Shareholder | shareholder party role, capital agreement, registration evidence, installment eligibility, shareholder-loan agreement | `CapitalReceiptIntent` after validation | represent shareholder as user/GL account; mutate Treasury balances; write journals |
| Treasury | cash location, per-location/currency account, physical count, cash receipt, opening/activation evidence; later Saraf contracts | `VerifiedTreasuryReceipt` referencing the same intent, destination and count | treat Saraf as bank/safe; approve own Finance posting; write journals |
| Finance | policy gate, ledger-account reference, periods, posting intent, Finance approval, journal, reversal, reconciliation | immutable posted journal and posted projection only after all gates | invent accounts/policies/openings; accept direct GL writes; edit posted journals |

One source business event produces at most one effective journal. Retries return the same result or a typed idempotency conflict; they never duplicate source, Treasury or ledger effects.

## 4. Source-to-posting contract

The reference chain is:

`CapitalAgreement` → `CapitalInstallmentEligibility` → `CapitalReceiptIntent` → `VerifiedTreasuryReceipt` → `CapitalPostingIntent` → `FinanceApproval` → `PostedJournal` → `ReconciliationResult`.

Required invariants:

1. Agreement is approved, partial-installment policy permits the amount, registration evidence exists and the installment does not exceed eligibility.
2. Records use the same legal entity, original currency, amount, agreement/installment/source identity and intended physical-safe destination.
3. Treasury receipt references a physical count, authorized cashier and evidence; destination account is separately reconciled, approved and active for USD.
4. Finance approver differs from the cashier, has server-side permission and scope, and supplies approval evidence.
5. Approved ledger-account references and an open period exist. E0 must not fabricate either.
6. Any base valuation requires an approved accounting-currency policy. AFN requires an approved immutable FX-rate snapshot; no implicit 1:1 conversion is allowed.
7. Journal debit and credit totals balance exactly in the approved accounting currency. The illustrative office-cash/capital pattern stays blocked until the actual CoA is approved.
8. Posted records are immutable. Corrections create a linked reversal or approved adjustment.
9. Reconciliation reports are scoped to `FIRST_CAPITAL_RECEIPT_OPERATIONAL_SLICE`, group by currency and are not company-wide statements.

## 5. API boundary freeze

The endpoint names below are reserved. E0 may expose validation or draft handlers only where authentication/persistence prerequisites exist; unavailable dependencies return a typed fail-closed result.

| Method and path | Owner | E0 meaning |
|---|---|---|
| `POST /api/v1/shareholder-capital/receipts` | Shareholder | Create draft capital-receipt intent; no cash or ledger effect |
| `POST /api/v1/treasury/cash-receipts` | Treasury | Record/verify physical count and receipt against an eligible intent; no ledger effect |
| `POST /api/v1/finance/posting-intents/{id}/approve` | Finance | Validate independent Finance approval; refuse while any dependency is missing |
| `POST /api/v1/finance/posting-intents/{id}/post` | Finance | Reserved Finance-only dispatch; operational posting disabled under E0 |
| `POST /api/v1/finance/journals/{id}/reverse` | Finance | Reserved controlled-reversal boundary requiring authority, reason and evidence |
| `GET /api/v1/finance/reconciliation/capital-receipts` | Finance | Scoped posted-projection reconciliation only; never an official statement |

Every write accepts correlation and idempotency identifiers. Results use the shared success/error envelope, do not expose stack traces and do not return successful financial outcomes for rejected commands. HTTP status mapping will be frozen with the implemented adapter; domain error codes are shared now.

## 6. Fail-closed error contract

The shared vocabulary includes authentication/permission denial, scope mismatch, segregation-of-duties violation, pending policy configuration, closed period, missing agreement/registration/evidence, excess installment, unverified Treasury receipt, inactive cash account, unapproved opening position, currency mismatch, unbalanced journal, idempotency conflict, immutable posted record and not found.

Unknown or unconfigured policy is an error, never a permissive default. Authorization is server-side; hiding a UI action is not authorization.

## 7. Freeze and change control

- Additive implementation details may proceed behind these contracts.
- A rename, removal, type broadening, currency addition, ID substitution, endpoint-ownership change or posting-invariant change is breaking and requires a new contract version plus joint review.
- Database migrations, OpenAPI output and events derive from or are checked against the reviewed shared contract. Other domains must not create separate migrations for shared tables before the common-schema owner publishes the contract SHA.
- The E0 handoff records `8fb471475a76587b36414dfa3ab3f8dfc0cb0124` as the commit containing the canonical typed contracts, migration correction and local test evidence. This development freeze is not a production-stable API claim.
- Finance Manager decisions enter through versioned policy/configuration and a documented contract revision when necessary. Historical events or posted records are never silently reinterpreted.

## 8. Outside this freeze

Production identity-provider configuration, final permission matrix, actual legal-entity/safe/shareholder records, base accounting currency, account codes, balances, fiscal periods, opening imports, FX rates, reporting currency, Saraf execution, bank support, official receipts/statements, tax, gain/loss and revaluation are not frozen or approved here.
