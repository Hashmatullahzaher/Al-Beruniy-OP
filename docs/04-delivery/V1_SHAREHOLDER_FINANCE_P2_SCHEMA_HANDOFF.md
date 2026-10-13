# Shareholders → Finance: handoff to P2 schema coordinator

Source checkpoint: `ee198f94b0539fcb7bc5e63e069132c576dee7dc`

Detailed authority: `V1_SHAREHOLDER_FINANCE_MIGRATION_READINESS_MANIFEST.md`

Status: coordination only; no migration number, SQL, registry change, deployment, or Temporary Funding implementation.

## 1. Shareholder-owned objects

Proposed new tables:

- `shareholder_capital_receipts`: one immutable actual same-currency receipt tied to one `0035` CASH declaration and one operational Treasury destination;
- `shareholder_capital_receipt_custody_verifications`: one append-only terminal Treasury verification per receipt;
- `shareholder_capital_account_mapping_versions`: append-only paid-in-capital credit mapping.

Proposed typed extensions:

- `posting_intents.shareholder_capital_receipt_id`;
- `posting_intents.finance_workflow_policy_version_id`;
- `posting_intents.shareholder_capital_account_mapping_version_id`;
- `posting_approvals.shareholder_capital_receipt_id`;
- `subledger_entries.shareholder_capital_receipt_id`.

Do not add a duplicate capital policy table or a new intent kind. Reuse existing workflow type and intent kind `SHAREHOLDER_CAPITAL_RECEIPT`. Use source discriminator `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` for the operational source.

## 2. Existing shared primitives reused

- `shareholder_contributions`, profiles, and business parties;
- `finance_workflow_policy_versions` from `0025`;
- `operational_treasury_accounts` from `0027`;
- `posting_intents`, `posting_approvals`, journals, lines, and subledgers;
- `evidence_references`, `idempotency_records`, `audit_records`, and `outbox_events`;
- accounting periods and the restricted Operational V1 GL owner/validator pattern;
- database session provenance, live RBAC, and entity scope.

The legacy E1 `cash_receipts`, `capital_receipt_intents`, handoffs, and synthetic posting functions are not reused for operational receipt mutation.

## 3. Shared coordination candidates

- operational inbound-custody verification semantics;
- generic `posting_intents.finance_workflow_policy_version_id`;
- model-aware typed operational source dispatch;
- restricted source-lock helper pattern;
- immutable mapping-version pattern;
- read-only source → custody → approval → journal trace composition.

P2 may use its own typed funding source FK. It must extend the same source-shape constraint and validator dispatch without weakening legacy capital, operational expense, or shareholder-capital branches.

## 4. Exact uniqueness and idempotency

- receipt: `UNIQUE (id, legal_entity_id)` and `UNIQUE (legal_entity_id, idempotency_key)`;
- custody: `UNIQUE (legal_entity_id, receipt_id)`;
- mapping: `UNIQUE (legal_entity_id, version)`;
- capital intent: partial `UNIQUE (legal_entity_id, shareholder_capital_receipt_id)`;
- capital approval: partial `UNIQUE (legal_entity_id, shareholder_capital_receipt_id)`;
- existing intent `UNIQUE (legal_entity_id, source_type, source_id)` and `(legal_entity_id, idempotency_key)` remain;
- existing one journal per posting intent and one subledger type per line remain;
- all command retries use canonical fingerprints; same key/different payload rejects; different keys cannot bypass source uniqueness.

## 5. Posting integration

First production path is CASH and same currency only. Declaration is non-financial. Receipt, custody verification, and approval produce no GL effect. Posting creates one OPERATIONAL_V1 intent, one balanced journal, two lines, and two subledgers:

- debit destination ledger + OPERATIONAL_TREASURY subledger;
- credit approved paid-in-capital equity ledger + SHAREHOLDER_CAPITAL subledger for the shareholder business party.

The intent binds the exact receipt, current capital workflow-policy version, and capital mapping version. Existing `SHAREHOLDER_CAPITAL_RECEIPT` intent kind is reused. The `0002` legacy source constraint must become model-aware: LEGACY_E1 continues to require `capital_receipt_intent_id`; OPERATIONAL_V1 capital requires the new receipt FK and forbids the legacy FK.

## 6. Names P2 must not independently reuse

- `shareholder_capital_receipts`;
- `shareholder_capital_receipt_custody_verifications`;
- `shareholder_capital_account_mapping_versions`;
- `shareholder_capital_receipt_id` on shared financial tables;
- `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` source discriminator;
- shareholder capital permission codes listed in the detailed manifest.

The generic column name `posting_intents.finance_workflow_policy_version_id` is intentionally a coordination candidate: P2 should reuse it, not create a second equivalent column. No migration number or permission-catalogue version is reserved here.

## 7. Likely Temporary Funding collision

The main collision is the inbound-custody fact: both domains may need an actual receipt, configured destination, independent verifier, evidence, amount/currency identity, and one-source/one-intent posting boundary. Do not solve this with an unvalidated polymorphic UUID. Either keep typed domain custody tables or agree on a generic table with a database-enforced trusted source registry and same-entity FKs.

Secondary collisions are workflow-policy binding on `posting_intents`, Operational V1 validator dispatch, and mapping-version conventions. Coordinate these once, while keeping domain source locks and permissions separate.

Deferred for shareholder capital: cross-currency/FX, complex refunds, automatic reversal, in-kind posting, and credit posting. P2 must not rely on those paths being active.
