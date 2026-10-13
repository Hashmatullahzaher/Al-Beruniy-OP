# V1 Shareholders → Finance migration-readiness manifest

Status: **coordination-ready design only**

Reviewed source: `ee198f94b0539fcb7bc5e63e069132c576dee7dc`

Repository baseline reviewed: migrations `0001` through `0035`

Prohibited by this checkpoint: SQL migration creation, migration-registry changes, database access, deployment, runtime changes, Temporary Funding implementation, and production financial activation.

This manifest supersedes the schema details in `V1_SHAREHOLDER_FINANCE_BRIDGE_SCHEMA_PROPOSAL.md` wherever they conflict. It is intentionally precise enough for schema coordination, but it is not authorization to create migration `0036` or any other migration.

## 1. Corrections from the migration re-review

| Earlier proposal | Repository fact through `0035` | Coordinated result |
|---|---|---|
| Add a capital-receipt policy table | `0025` already defines append-only `finance_workflow_policy_versions` and the `SHAREHOLDER_CAPITAL_RECEIPT` workflow type | Reuse the existing policy table. Do not add `shareholder_capital_receipt_policy_versions`. |
| Add a separate accounting-decision table | `0001` already defines immutable `posting_approvals` tied to an intent and evidence | Reuse `posting_approvals`, with a capital-receipt binding column and a capital-specific uniqueness/validation guard. Keep Treasury custody verification separate. |
| Add a new capital intent kind | `0001` already reserves `SHAREHOLDER_CAPITAL_RECEIPT` | Reuse the kind. Add the operational source discriminator `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT`; do not change the existing kind name. |
| Use the existing capital source constraint unchanged | `0002` requires every capital intent to reference legacy `capital_receipt_intents`; `0028` added `processing_model` but did not make that constraint model-aware | Replace only the affected source-shape constraints with explicit `LEGACY_E1` and `OPERATIONAL_V1` branches. Preserve the legacy branch byte-for-byte in meaning. |
| Treat receipt approval as one mutable receipt state | Existing GL design separates source, intent, approval, journal, and subledger facts | Keep actual receipt, custody verification, Finance approval, and posting as separate immutable facts. |
| Use the legacy Treasury receipt tables | `cash_receipts`, physical counts, handoffs, and their entry points remain the synthetic E1 custody lane | Do not reuse them for operational capital receipts. Reuse only the operational destination configuration in `operational_treasury_accounts`. |

The `0035` declaration remains non-financial. `shareholder_contributions.record_status`, `receipt_status`, and `valuation_status` are not advanced by this first slice. Receipt and posting summaries are derived from the new receipt facts and the existing GL lineage.

## 2. First activation boundary

Only this path is eligible for the first production activation:

```text
CASH declaration in DECLARED state
  → same-currency actual receipt into an ACTIVE operational Treasury account
  → independent Treasury/custody verification
  → independent Finance approval under the current capital workflow policy
  → explicit OPERATIONAL_V1 posting
```

The declaration step creates no receipt, posting intent, approval, journal, journal line, or subledger entry. The receipt and custody steps create no GL effect. The approval step creates no GL effect. Posting is the only step that creates a journal and subledger effects.

The first activation requires all of the following:

- `contribution_type = 'CASH'`, `record_status = 'DECLARED'`, and the declaration has a positive exact `numeric` amount and enabled currency;
- receipt currency equals the declaration currency, destination currency, and legal-entity base currency;
- the selected destination is an ACTIVE `operational_treasury_accounts` row in the same legal entity;
- cumulative non-rejected recorded receipts cannot exceed the declaration amount under a locked source/allocation check;
- one independent custody verification exists for the exact receipt and amount;
- the current `finance_workflow_policy_versions` row for `SHAREHOLDER_CAPITAL_RECEIPT` has `approval_required = true` and is bound to the posting intent;
- one independent APPROVED `posting_approvals` fact exists for that intent;
- the accounting period is OPEN and the paid-in-capital mapping is an approved, immutable version;
- all authority comes from an active `PASSWORD_OPERATIONAL` database session, live permission, and legal-entity scope.

Approval OFF for ordinary Al-Beruniy expenses does not waive capital approval. A future owner-approved capital policy may change that behavior, but this first activation remains approval-required.

## 3. A — Shareholder-specific schema

### A1. `abos.shareholder_capital_receipts`

New immutable actual-receipt source table.

| Column | Type / constraint |
|---|---|
| `id` | `uuid PRIMARY KEY` |
| `legal_entity_id` | `uuid NOT NULL REFERENCES abos.legal_entities(id)` |
| `contribution_id` | `uuid NOT NULL` |
| `operational_treasury_account_id` | `uuid NOT NULL` |
| `original_amount` | `numeric NOT NULL CHECK (original_amount > 0)` |
| `original_currency_code` | `text NOT NULL REFERENCES abos.currencies(code)` |
| `receipt_date` | `date NOT NULL` |
| `payment_reference` | `text NULL CHECK (payment_reference IS NULL OR length(btrim(payment_reference)) BETWEEN 1 AND 120)` |
| `evidence_reference_id` | `uuid NULL`; optional receipt evidence is distinct from required approval evidence |
| `contribution_version` | `integer NOT NULL CHECK (contribution_version > 0)` |
| `source_fingerprint` | `text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$')`; server-computed from immutable declaration identity/version, party, amount, currency, and date |
| `record_state` | `text NOT NULL CHECK (record_state IN ('RECORDED','CANCELLED'))`; first activation writes only `RECORDED` |
| `version` | `integer NOT NULL DEFAULT 1 CHECK (version > 0)` |
| `correlation_id` | `uuid NOT NULL` |
| `idempotency_key` | `text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200)` |
| `request_fingerprint` | `text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')` |
| `recorded_by_user_account_id` | `uuid NOT NULL REFERENCES abos.user_accounts(id)` |
| `recorded_at` | `timestamptz NOT NULL DEFAULT clock_timestamp()` |
| `cancelled_by_user_account_id` | `uuid NULL REFERENCES abos.user_accounts(id)`; reserved for a later approved correction policy |
| `cancelled_at` | `timestamptz NULL`; reserved |
| `cancellation_reason` | `text NULL CHECK (cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500)`; reserved |

Required foreign keys and constraints:

- `UNIQUE (id, legal_entity_id)`;
- `FOREIGN KEY (contribution_id, legal_entity_id) REFERENCES abos.shareholder_contributions(id, legal_entity_id)`;
- `FOREIGN KEY (operational_treasury_account_id, legal_entity_id) REFERENCES abos.operational_treasury_accounts(id, legal_entity_id)`;
- `FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)` requires a matching entity-qualified currency uniqueness target on the operational account; if PostgreSQL cannot use the current key shape directly, add `UNIQUE (id, legal_entity_id, currency_code)` to `operational_treasury_accounts`, with no data rewrite;
- `FOREIGN KEY (evidence_reference_id, legal_entity_id) REFERENCES abos.evidence_references(id, legal_entity_id)` when evidence is present;
- `UNIQUE (legal_entity_id, idempotency_key)` for the record action;
- cancellation shape requires all three cancellation fields together and is not exposed in the first activation;
- a validation trigger/helper rejects non-CASH, non-DECLARED, cancelled, changed-version, different-currency, inactive-destination, cross-entity, cross-currency, and over-receipt attempts.

Required indexes:

- `(legal_entity_id, contribution_id, receipt_date, id)`;
- `(legal_entity_id, operational_treasury_account_id, receipt_date, id)`;
- `(legal_entity_id, record_state, receipt_date, id)`.

### A2. `abos.shareholder_capital_receipt_custody_verifications`

New append-only Treasury verification fact. This is not Finance approval and does not create a journal.

| Column | Type / constraint |
|---|---|
| `id` | `uuid PRIMARY KEY` |
| `legal_entity_id` | `uuid NOT NULL REFERENCES abos.legal_entities(id)` |
| `receipt_id` | `uuid NOT NULL` |
| `decision` | `text NOT NULL CHECK (decision IN ('VERIFIED','REJECTED'))` |
| `verification_kind` | `text NOT NULL CHECK (verification_kind IN ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE'))` |
| `verified_amount` | `numeric NOT NULL CHECK (verified_amount > 0)` |
| `currency_code` | `text NOT NULL REFERENCES abos.currencies(code)` |
| `evidence_reference_id` | `uuid NOT NULL` |
| `decision_reason` | `text NULL CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 500)`; mandatory when REJECTED |
| `verified_by_user_account_id` | `uuid NOT NULL REFERENCES abos.user_accounts(id)` |
| `verified_at` | `timestamptz NOT NULL DEFAULT clock_timestamp()` |
| `correlation_id` | `uuid NOT NULL` |
| `request_fingerprint` | `text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')` |

Required foreign keys and constraints:

- `UNIQUE (id, legal_entity_id)`;
- `UNIQUE (legal_entity_id, receipt_id)`; first activation permits one terminal custody decision per receipt;
- `FOREIGN KEY (receipt_id, legal_entity_id) REFERENCES abos.shareholder_capital_receipts(id, legal_entity_id)`;
- `FOREIGN KEY (evidence_reference_id, legal_entity_id) REFERENCES abos.evidence_references(id, legal_entity_id)`;
- trigger/helper requires exact receipt amount/currency, same entity, RECORDED receipt, and `verified_by_user_account_id <> recorded_by_user_account_id`;
- VERIFIED requires evidence of the actual destination/custody event. A file hash, agreement document, or declaration alone is insufficient;
- rows are INSERT-only. Rejection does not prove a refund and does not automatically release allocation.

Required indexes:

- `(legal_entity_id, decision, verified_at, id)`;
- `(legal_entity_id, verified_by_user_account_id, verified_at, id)`.

### A3. `abos.shareholder_capital_account_mapping_versions`

New append-only paid-in-capital credit mapping. The Treasury debit mapping remains the selected operational Treasury account's ledger account.

| Column | Type / constraint |
|---|---|
| `id` | `uuid PRIMARY KEY` |
| `legal_entity_id` | `uuid NOT NULL REFERENCES abos.legal_entities(id)` |
| `version` | `integer NOT NULL CHECK (version > 0)` |
| `paid_in_capital_ledger_account_id` | `uuid NOT NULL` |
| `evidence_reference_id` | `uuid NOT NULL` |
| `configured_by_user_account_id` | `uuid NOT NULL REFERENCES abos.user_accounts(id)` |
| `configured_at` | `timestamptz NOT NULL DEFAULT clock_timestamp()` |
| `change_reason` | `text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 5 AND 500)` |

Required foreign keys and constraints:

- `UNIQUE (id, legal_entity_id)`;
- `UNIQUE (legal_entity_id, version)`;
- `FOREIGN KEY (paid_in_capital_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id)`;
- `FOREIGN KEY (evidence_reference_id, legal_entity_id) REFERENCES abos.evidence_references(id, legal_entity_id)`;
- configuration guard requires an active EQUITY ledger with the approved SHAREHOLDER_CAPITAL control classification; no account number or policy is invented;
- rows are INSERT-only. The latest approved version is selected and copied to the intent; older postings keep their exact version.

Required index:

- `(legal_entity_id, version DESC)`.

### A4. Shareholder-specific extensions to existing tables

| Existing object | Exact proposed extension |
|---|---|
| `posting_intents` | Add nullable `shareholder_capital_receipt_id uuid`, `finance_workflow_policy_version_id uuid`, and `shareholder_capital_account_mapping_version_id uuid`; add entity-qualified FKs; add partial unique `(legal_entity_id, shareholder_capital_receipt_id) WHERE shareholder_capital_receipt_id IS NOT NULL`; require `source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'`, `source_id = shareholder_capital_receipt_id`, `intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT'`, and `processing_model = 'OPERATIONAL_V1'` together. |
| `posting_approvals` | Add nullable `shareholder_capital_receipt_id uuid`; add entity-qualified FK and partial unique `(legal_entity_id, shareholder_capital_receipt_id) WHERE shareholder_capital_receipt_id IS NOT NULL`; guard requires its receipt to equal the parent intent receipt. Legacy approvals remain unchanged. |
| `subledger_entries` | Add nullable `shareholder_capital_receipt_id uuid` with entity-qualified FK and index `(legal_entity_id, shareholder_capital_receipt_id, subledger_type)`; operational capital posting requires it on exactly the OPERATIONAL_TREASURY and SHAREHOLDER_CAPITAL entries created for the receipt. Legacy rows remain null. |
| `shareholder_contributions` | Add no column. Add a binding guard that prevents update/cancellation of accounting identity fields after any receipt exists: shareholder, type, business date, amount, currency, declaration status, and source version cannot drift. Keep the `0035` lifecycle state restrictions until separately reviewed. |
| `operational_treasury_accounts` | Add only `UNIQUE (id, legal_entity_id, currency_code)` if required as the exact FK target. No row updates or backfill. |

The `0002` constraints `posting_intents_capital_source_required` and `posting_intents_capital_source_matches_source_id` must be replaced, not bypassed, with model-aware constraints:

- LEGACY_E1 capital: `capital_receipt_intent_id IS NOT NULL`, new operational receipt FK is null, and legacy source ID still equals `capital_receipt_intent_id`;
- OPERATIONAL_V1 capital: `shareholder_capital_receipt_id IS NOT NULL`, `capital_receipt_intent_id IS NULL`, source type/ID match the new receipt, and policy/mapping versions are present;
- OPERATIONAL_V1 expense: existing `operational_expense_id` rules remain unchanged;
- every unrelated kind/model: all capital-specific source columns are null.

No new `intent_kind` value is needed. Existing global unique constraints on `(legal_entity_id, idempotency_key)`, `(legal_entity_id, source_type, source_id)`, one journal per intent, and one subledger type per journal line remain in force.

## 4. B — Existing shared primitives reused unchanged

| Existing primitive | Use in this lane | Change |
|---|---|---|
| `shareholder_contributions` declaration and profile/party linkage | Authoritative non-financial source and shareholder business party | No column/state backfill; only source-binding guard described above |
| `finance_workflow_types` + `finance_workflow_policy_versions` | Capital approval-required policy and immutable version | No duplicate policy table; intent stores the chosen version FK |
| `operational_treasury_accounts` | Actual destination, currency, and Treasury debit ledger | Only optional composite uniqueness needed for an exact FK target |
| `evidence_references` | Receipt, custody, mapping, and approval evidence identity/hash | No content storage or evidence mutation |
| `posting_intents` | One operational source → one intent | Narrow nullable source/policy/mapping columns and model-aware constraints only |
| `posting_approvals` | Independent Finance approval/rejection | Narrow nullable receipt binding and capital-specific guard only |
| `journals` / `journal_lines` | One balanced journal per intent and exactly two capital lines | No columns; extend operational validator only |
| `subledger_entries` | OPERATIONAL_TREASURY and SHAREHOLDER_CAPITAL effects | Narrow receipt lineage column only |
| `accounting_periods` | OPEN period validation for receipt accounting date | No change |
| `idempotency_records` | Durable action scope/key/fingerprint/result arbitration | No change |
| `audit_records` / `outbox_events` | Same-transaction state/audit events | No schema change |
| `identity_actor_context` / operational bearer context | Active password session, current permissions, and entity grant | No change and no developer-token admission |
| `abos_v1_operational_finance_owner` | Private GL assembly/commit after capital-specific validation | Extend only exact column grants and private-helper EXECUTE; no broad table privilege |
| `abos_v1_shareholder_setup_owner` | Controlled lock/read of the declaration and contribution binding guard | No broad UPDATE or runtime membership |

## 5. C — Potential shared primitives requiring P2 coordination

These concepts may also be needed by Temporary Funding. Their schema names and semantics must be coordinated before any SQL is written.

| Candidate shared primitive | This lane needs | Coordination rule |
|---|---|---|
| Operational inbound-custody verification | Immutable destination/amount/currency/evidence/verifier fact, independent of recorder | This manifest reserves `shareholder_capital_receipt_custody_verifications` for shareholder capital. P2 must not reuse that name. A generic replacement is acceptable only if it retains typed source validation instead of an unvalidated polymorphic UUID. |
| `posting_intents.finance_workflow_policy_version_id` | Exact approval-policy version used for the intent | Candidate generic column. P2 must coordinate and reuse the same column/constraint semantics rather than introduce another policy-version column. |
| Operational posting source discrimination | Model-aware source FK, source type, source ID, and one-source/one-intent rule | P2 may add its own typed source FK, but must extend the same model-aware constraint set and validator dispatch without weakening capital, expense, or legacy E1 branches. |
| Restricted operational source-lock helper pattern | Lock protected source rows without broad UPDATE | Each domain should own its source lock. Shared helper code may be patterned, but P2 must not gain direct shareholder-table access. |
| Immutable destination/ledger mapping version | Bind exact approved debit/credit accounts to an intent | Shareholder capital mapping name and equity semantics are reserved. P2 needs a funding-specific mapping or a reviewed generic mapping with typed purpose. |
| Receipt/approval read model | Trace source → custody → approval → intent → journal | API composition may be shared, but data access remains domain- and permission-scoped. |

No generic `operational_receipts` table is approved by this document. Generic source tables would require a trusted typed source registry and database-enforced same-entity FKs; a bare `(source_type, source_id)` is insufficient.

## 6. Object governance matrix

| Object | Owning domain | Database write role | Read roles / entry points | Lifecycle owner | Idempotency boundary | Delete/update policy |
|---|---|---|---|---|---|---|
| `shareholder_capital_receipts` | Shareholders → Treasury bridge | proposed `abos_v1_shareholder_capital_owner` via authenticated wrappers | capital read wrapper for authorized Treasury/Finance/Shareholder readers | Treasury records; Finance cannot rewrite | entity + `receipt.record` + key/fingerprint; contribution allocation locked | INSERT-only in first activation; no DELETE; cancellation columns dormant |
| custody verifications | Treasury custody | proposed capital owner or narrower Treasury custody owner | Treasury/Finance trace wrappers | independent Treasury verifier | entity + `receipt.verify` + receipt; unique terminal row | append-only; no UPDATE/DELETE |
| account mapping versions | Finance configuration | `abos_v1_operational_finance_owner` via configuration wrapper | Finance setup/read wrappers | Finance configuration authority | entity + mapping version; entity/version unique | append-only; no UPDATE/DELETE |
| `posting_intents` capital extension | Finance | `abos_v1_operational_finance_owner` through capital prepare wrapper | scoped Finance/Treasury trace wrappers | Finance preparer | existing entity/key plus entity/source type/source ID and unique receipt | status changes only through guarded workflow; financial identity immutable; no DELETE |
| `posting_approvals` capital extension | Finance approval | `abos_v1_operational_finance_owner` through approval wrapper | scoped Finance trace | independent Finance approver | one terminal capital approval per receipt | append-only; no UPDATE/DELETE |
| journal/lines | General Ledger | `abos_v1_operational_finance_owner` private commit helper | GL/report wrappers | authorized Finance poster | one journal per intent | posted rows immutable; no DELETE |
| capital/Treasury subledgers | General Ledger/subledger | same private commit helper | GL/Treasury/shareholder reporting wrappers | authorized Finance poster | one type per line plus exact receipt lineage | immutable; no UPDATE/DELETE |
| contribution binding guard | Shareholder setup | existing setup owner trigger/private helper | no direct runtime access | shareholder source domain | exact entity/contribution/version lock | blocks identity/amount/currency/date/cancel changes after binding |
| audit/outbox | Audit/integration | relevant owner in same transaction | scoped audit/outbox consumers | originating command | same correlation and source event; retry emits no duplicate business event | append-only; no UPDATE/DELETE |

`abos_v1_shareholder_capital_owner` is a proposed NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS role. It receives only explicit column grants on the new receipt/custody tables, minimal SELECT on referenced source/configuration rows, audit/outbox INSERT columns, and reviewed helper EXECUTE. Runtimes receive wrapper EXECUTE only and cannot SET ROLE into any owner.

## 7. RBAC and grants manifest

Proposed active permission codes, subject to assignment review:

| Permission | Category / flags | Purpose | Runtime wrapper |
|---|---|---|---|
| `shareholder.capital-receipt.read` | SHAREHOLDER; ACTIVE; independence false; administrative false | Scoped bridge/trace read | general application runtime read wrapper |
| `shareholder.capital-receipt.record` | TREASURY; ACTIVE; independence false; administrative false | Record same-currency actual receipt | restricted Treasury runtime only |
| `treasury.capital-receipt.verify` | TREASURY; ACTIVE; independence true; administrative false | Verify/reject actual custody | restricted Treasury runtime only; verifier cannot be recorder |
| `finance.capital-receipt.configure` | FINANCE; ACTIVE; independence false; administrative false | Append paid-in-capital mapping versions | Finance runtime wrapper; role assignment reviewed separately |
| `finance.capital-receipt.approve` | FINANCE; ACTIVE; independence true; administrative false | Append Finance decision | Finance runtime only; approver cannot be receipt recorder or custody verifier |
| `finance.capital-receipt.post` | FINANCE; ACTIVE; independence true; administrative false | Explicit GL posting | Finance runtime only; current policy and participant rules revalidated |

The next permission catalogue version number must be allocated by the schema coordinator after merge order is known; this document does not reserve or bump a version.

Required privilege posture:

- PUBLIC: no EXECUTE on new functions; no table privileges.
- `abos_e1_treasury_runtime`: EXECUTE only on record, verify, and permitted read wrappers.
- `abos_e1_runtime`: EXECUTE only on Finance configure/approve/post/read wrappers that match current live permissions.
- operational owner: no unrestricted table grants; only existing grants plus exact new columns/functions.
- capital owner: no GL DML, no session/permission mutations, no document bytes, no shareholder-master mutation, no role membership.
- setup owner: minimal SELECT on receipt identity/existence for the source-binding guard; no receipt mutation.

Every SECURITY DEFINER function uses `SET search_path = pg_catalog, pg_temp`, fully qualified application objects, database-resolved actor/entity/permissions, and explicit function-signature REVOKE/GRANT statements. No function accepts actor identity, permission sets, policy flags, account mappings, or arbitrary source types as trusted caller input.

## 8. Required triggers and functions

Exact function bodies are deferred; these are the required boundaries and responsibilities:

| Function / trigger | Owner / callable by | Required behavior |
|---|---|---|
| `shareholder_capital_actor(...)` | capital owner; private | Resolve active password session, current user, legal entity, and exact required permission; reject synthetic provenance |
| `shareholder_contribution_finance_lock(entity, contribution, expected_version)` | setup owner; capital owner EXECUTE only | Lock and return minimal immutable CASH/DECLARED source facts; reject scope/version/state mismatch; no mutation |
| `record_shareholder_capital_receipt(...)` | capital owner; Treasury runtime EXECUTE | Acquire idempotency and source locks, validate remaining allocation and destination, insert receipt + audit/outbox atomically |
| `verify_shareholder_capital_receipt_custody(...)` | capital owner; Treasury runtime EXECUTE | Enforce independent verifier, exact amount/currency/evidence/destination, append terminal verification + audit |
| `configure_shareholder_capital_mapping(...)` | operational Finance owner; Finance runtime EXECUTE | Validate active approved equity account and append mapping version + audit |
| `prepare_shareholder_capital_posting(...)` | operational Finance owner; Finance runtime EXECUTE | Require VERIFIED custody and current approval-required policy; bind policy/mapping versions; create one intent in PENDING_APPROVAL |
| `decide_shareholder_capital_posting(...)` | operational Finance owner; Finance runtime EXECUTE | Enforce Finance approver independence and append one posting approval/rejection |
| `post_shareholder_capital_receipt(...)` | operational Finance owner; Finance runtime EXECUTE | Revalidate all facts, period, permissions, mappings, and approval; create/post exact journal and subledgers atomically |
| receipt/custody/mapping immutability triggers | table owner | Reject unauthorized UPDATE/DELETE |
| contribution source-binding guard | setup owner trigger | Freeze bound declaration identity, amount, currency, date, and cancellation |
| extended processing-model/source guard | operational Finance owner | Preserve LEGACY_E1 and expense branches; validate typed capital source branch |
| extended operational journal validator | operational Finance owner | Dispatch by operational source; enforce exact two-line capital journal and matching subledgers |

Private source-lock and GL commit helpers are not executable by runtime roles. Workspace/read functions expose only scoped metadata and do not reveal evidence beyond the caller's role.

## 9. Accounting and posting contract

For the first same-currency receipt, `original_currency_code = base_currency_code`; `original_amount = base_amount`; `conversion_snapshot_reference IS NULL`. No exchange-rate snapshot is created.

Posting creates exactly two journal lines:

1. Debit the active ledger mapped by the exact destination `operational_treasury_account_id`.
2. Credit the active paid-in-capital equity ledger from the bound `shareholder_capital_account_mapping_versions` row.

Both lines use the receipt as `source_id`, the new source discriminator, the same entity/accounting date/base currency, and the exact amount. The credit line carries the shareholder business party resolved from `contribution → shareholder_profile → business_party`. The journal balances exactly and has one intent.

Posting creates exactly two subledger entries:

- `OPERATIONAL_TREASURY` on the debit line with the exact destination and positive receipt amount;
- `SHAREHOLDER_CAPITAL` on the credit line with the exact shareholder business party and capital amount under the existing capital sign convention.

The operational validator must reject extra lines/entries, wrong-side amounts, wrong account classes, wrong parties/destinations, mismatched source IDs, inactive mappings, closed periods, missing approval/custody, and mixed processing models. A successful post transitions the intent and journal to POSTED in the same transaction. The declaration remains DECLARED and its displayed received/posted state is derived.

## 10. Audit and outbox implications

Successful state changes append bounded audit actions such as:

- `SHAREHOLDER_CAPITAL_RECEIPT_RECORDED`;
- `SHAREHOLDER_CAPITAL_CUSTODY_VERIFIED` / `..._REJECTED`;
- `SHAREHOLDER_CAPITAL_MAPPING_CONFIGURED`;
- `SHAREHOLDER_CAPITAL_POSTING_PREPARED`;
- `SHAREHOLDER_CAPITAL_POSTING_APPROVED` / `..._REJECTED`;
- `SHAREHOLDER_CAPITAL_RECEIPT_POSTED`.

Audit metadata includes entity, source IDs, actor, correlation ID, policy/mapping/evidence references, and state transition. It excludes bearer/session tokens, passwords, file bytes, unrestricted evidence metadata, and mutable client authority claims.

Outbox events are inserted in the same transaction for committed business transitions. No external delivery is activated in this slice. Idempotent retries return the existing authorized resource and emit no duplicate receipt, approval, journal, audit transition, or outbox event.

## 11. Zero-backfill and upgrade assumptions

- New receipt, custody, and mapping tables deploy empty.
- Existing `shareholder_contributions` rows are not updated, inferred, approved, received, posted, cancelled, or linked automatically.
- Existing legacy capital agreements, installments, capital requests, Treasury receipts/handoffs, operational expenses, posting intents, approvals, journals, lines, subledgers, audit records, and documents are unchanged.
- New columns on shared tables are nullable and existing rows remain null.
- Model-aware replacement constraints must validate all existing LEGACY_E1 and OPERATIONAL_V1 expense rows before commit.
- No default mapping, workflow-policy version, custody evidence, receipt, journal, or opening balance is inserted.
- Missing capital policy/mapping/custody fails closed. A migration may install schema and permissions without activating the lane.
- Upgrade and fresh-install tests must compare business-data fingerprints and prove zero business-row drift.

## 12. Explicitly deferred activation

The schema must remain extensible, but these operations remain unavailable:

- cross-currency capital receipt;
- automatic FX rate selection, conversion, gain/loss, or revaluation;
- complex refund or custody-return handling;
- automatic reversal activation or capital-reversal posting;
- in-kind contribution posting or valuation;
- credit contribution classification or posting.

No permission, wrapper, route, UI action, function EXECUTE, or policy default may activate them. Existing reversal requests and links remain available only under their current fail-closed behavior; no capital posting wrapper may call a reversal commit.

## 13. Disposable-database proof required after coordination

Before any later migration can be accepted, disposable PostgreSQL tests must prove:

- exact upgrade from `0035` and fresh install, with zero backfill and preserved checksums/fingerprints;
- legacy E1 capital source constraints, synthetic gate, Treasury handoff, and synthetic posting remain intact;
- Operational V1 expense behavior remains intact;
- restricted Treasury and Finance runtimes have no direct protected-table DML or owner-role assumption;
- synthetic provenance cannot use operational capital functions; operational provenance cannot use synthetic custody/posting functions;
- cross-entity, forged source, forged evidence, wrong account/currency, stale version, inactive destination, over-receipt, duplicate approval, and direct function attacks fail with no writes;
- simultaneous receipt and posting requests preserve allocation and one-source/one-intent/one-journal invariants;
- record, custody verification, and approval produce no journal; posting produces exactly one balanced two-line journal and two exact subledger entries;
- posted financial rows and all source/decision facts are immutable;
- deferred cross-currency, refund, reversal, in-kind, and credit paths fail closed.

No test was run for this documentation-only checkpoint because no application code, SQL, migration registry, database, or runtime configuration changed.
