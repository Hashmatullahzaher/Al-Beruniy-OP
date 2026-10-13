# V1 Shareholder → Finance bridge: schema proposal only

Potential follow-up migration: `0036` subject to coordination and approval. No number is reserved against Claude's Security Rotation S1. No SQL migration, registry entry, owner grant or schema change is created or applied by this task.

Source baseline: `8caeae419735f61d41afd9f307b8c9d9f95307b0`, latest committed shareholder declaration migration `0035`. This proposal accompanies `V1_SHAREHOLDER_FINANCE_BRIDGE_DESIGN.md`; unresolved accounting, custody and reversal decisions remain release blockers.

## 1. Smallest safe persistent extension

Keep `shareholder_contributions`, legacy `capital_agreements`/installments, operational Treasury configuration and the existing GL tables. Add an operational receipt source, immutable receipt decisions and capital-specific policy/mapping. Extend the existing posting-intent source discrimination and operational posting validator narrowly. Do not write the new receipt into `cash_receipts`, whose existing E1 lifecycle is synthetic-only. Do not fabricate a legacy `capital_receipt_intent` to satisfy E1 constraints.

Derived contribution summary is a view/function over immutable declarations and receipt/decision/posting facts. Keep the `0035` lifecycle guard unchanged: the bridge does not set contribution `APPROVED`/`POSTED` or `receipt_status` to later values. Once any receipt is linked, amount, currency, shareholder, type and business date must be frozen for that declaration even if it remains DECLARED. A new source-binding trigger must prevent contribution update/cancellation while active custody/allocation exists. Lock-only validation of source rows must not require unrestricted UPDATE.

The persistent lane is not implemented in the current app-only checkpoint. The in-memory service's types are review contracts, not a promise that this exact schema is already installed.

## 2. Proposed tables and columns

| Object | Required fields / relationships | Rationale |
|---|---|---|
| `shareholder_capital_receipts` | `id`, `legal_entity_id`, `contribution_id`, `shareholder_profile_id`, exact `original_amount numeric`, `original_currency_code`, `receipt_date`, `operational_treasury_account_id`, optional `payment_reference`, optional receipt evidence binding, immutable recorder/time, `receipt_state`, `approval_state`, `posting_state`, `version`, policy/source snapshot references, optional `journal_id`, optional `reversal_journal_id`, cancellation actor/time/reason | New actual receipt fact, tied to one exact 0035 declaration and its configured destination. No inferred receipt or duplicate declaration. |
| `shareholder_capital_receipt_decisions` | `id`, `legal_entity_id`, `receipt_id`, `decision` APPROVED/REJECTED, reason where required, decider/time, receipt version/fingerprint, immutable policy version, formal eligibility/custody decision references where required | Separate permanent accounting approval evidence. Approval does not by itself generate a journal. |
| `shareholder_capital_receipt_policy_versions` | `id`, `legal_entity_id`, decision reference/authority/time, policy version, funding/recognition state, approval-required and participant exclusions, evidence/custody requirements, supported destination rules, reversal availability; append-only immutable approved versions | Prevent caller-provided approval/recognition flags and policy edits from altering an existing receipt's route. Absence or provisional policy fails closed. |
| `shareholder_capital_receipt_account_mappings` | `id`, `legal_entity_id`, approved policy-version FK, active paid-in-capital ledger FK/currency/control class, decision evidence; immutable once referenced | Identify existing approved ledger IDs; no invented numeric CoA. Debit mapping comes from the existing operational Treasury account. No approval implies no posting. |
| Source eligibility/custody binding | Receipt/contribution + exact agreement-specific evidence or formal registration/eligibility decision + actual Treasury verification reference, entity, actor/time, immutable decision version | Required when the approved capital policy demands legal eligibility and verified actual custody. Exact shape depends on the owner's policy; a document/hash alone is never VERIFIED. |
| Receipt evidence binding | Receipt/entity/evidence/version FK, immutable binding time and actor; reuse `evidence_references` and existing private document version | Preserve exact immutable evidence source. Reuse agreement linkage where appropriate, do not rewrite document bytes, hash or version. |

Optional documents remain optional for Al-Beruniy master setup and draft agreement management. Receipt evidence, formal registration and funding recognition requirements are independent configurable rules. A migration must not default formal eligibility to TRUE for all declarations.

Use the entity's currency master and exact numeric validation. Reject unsupported/disabled currency, nonpositive amount, invalid date and excess decimal precision according to the existing approved conventions. Monetary values are never `real`/`double precision`.

Separate `receipt_state` RECORDED/CANCELLED; `approval_state` PENDING/APPROVED/REJECTED; `posting_state` NOT_POSTED/POSTED/REVERSED. Shape checks require actor/time/journal links for their corresponding states. Never overwrite an immutable receipt amount, source, destination or policy snapshot after recording. Decisions are append-only; no mutable row can silently erase approval. Correct physical-custody consequences for rejected/cancelled receipts require policy approval before operational mutation is available.

## 3. Existing financial table extensions

| Existing table / object | Proposed narrow change |
|---|---|
| `posting_intents` | Add nullable `shareholder_capital_receipt_id` with entity-qualified FK. Add a distinct capital-contribution receipt kind or explicit source discriminator. Require `processing_model = OPERATIONAL_V1`, exact receipt source ID and this FK for that kind. Keep all legacy E1 source requirements intact. Keep original/base amounts, accounting date, mapping/policy/FX references immutable. |
| `journals` | Reuse same table and existing one-journal-per-intent constraint. OPERATIONAL_V1 capital branch validates the new receipt/decision/policy/source; does not satisfy or replace EXPENSE validation. Assemble DRAFT, validate complete lines and subledger, then atomically transition POSTED. |
| `journal_lines` | Reuse two balanced exact lines, same entity/source and immutable currency/dimensions. No schema relaxation allowing posted updates/deletes. |
| `subledger_entries` | Reuse OPERATIONAL_TREASURY and SHAREHOLDER_CAPITAL. Add nullable `shareholder_contribution_id` or exact entity-qualified receipt/contribution linkage if current source ID cannot express declaration lineage safely. Capital credit row must have the shareholder's business party; Treasury debit row has exact operational destination. |
| `exchange_rate_snapshots` | Future foreign-currency slice only: allow exact new receipt source type with entity-qualified binding and immutable approved historical rate. Same-currency isolated slice uses no FX snapshot and original = base amount. |
| `journal_reversal_requests` / `journal_reversal_links` | Reuse immutable requests/decisions and one-original/one-reversal linkage. Add only entity-qualified receipt lineage where needed. Do not enable actual reversal posting until approved policy and independent decision exist. |
| `idempotency_records` | Reuse durable scoped key, canonical fingerprint and authorized response/resource reference. Avoid response snapshots containing secrets or file content. |
| `audit_records` / `outbox_events` | Reuse same transaction for state events, source lineage and permission-tagged metadata. No external delivery is required in this slice. |

There are source-shape constraints beyond the initial `posting_intents` kind list: migration `0002` associates legacy SHAREHOLDER_CAPITAL_RECEIPT with a legacy capital receipt intent, and later guards/validation depend on that shape. A future implementation must inventory and change only the new OPERATIONAL_V1 kind's constraints/branches. Simply assigning the old kind or bypassing a trigger is unacceptable.

## 4. Foreign keys, uniqueness and indexes

All business relationships must be entity-qualified wherever the existing tables expose `(id, legal_entity_id)` uniqueness. Required relationships include receipt → declaration, profile → party, receipt → operational destination, receipt decision → receipt/policy/decider, receipt evidence → same-entity immutable evidence/version, intent → receipt, journal → intent/period, line → journal/ledger/party/dimensions, subledger → exact line/destination/party/contribution. `ON DELETE CASCADE` must not erase financial lineage.

Proposed uniqueness requirements (names below are design labels, not created indexes):

| Constraint/index | Required guarantee |
|---|---|
| Receipt `(id, legal_entity_id)` | Entity-qualified FK target. |
| Intent `(legal_entity_id, shareholder_capital_receipt_id)` unique where receipt FK is present | At most one normal posting intent per actual receipt, even with different API idempotency keys. |
| Existing intent `(legal_entity_id, source_type, source_id)` | New source ID is receipt ID, not contribution/shareholder. Partial receipts can each post once. |
| Existing journal `posting_intent_id` unique | At most one journal per intent. |
| Receipt decision `(legal_entity_id, receipt_id)` unique for the final accounting decision | No conflicting terminal approval/rejection. Any review history is append-only and separate. |
| Receipt `(legal_entity_id, operation, idempotency_key)` via existing scoped idempotency records | Safe retried record/action requests with exact fingerprint conflict rejection. |
| Existing reversal original-journal PK + reversal-journal unique | At most one compensating reversal for a normal original posting; no double reversal. |
| Existing subledger `(journal_line_id, subledger_type)` plus source validation | Exactly one matching Treasury and one matching shareholder effect for the expected lines, no duplicates or unrelated movements. |

Read indexes: receipts `(legal_entity_id, contribution_id, receipt_date, id)`; pending decisions `(legal_entity_id, approval_state, receipt_date, id)`; posting status `(legal_entity_id, posting_state, receipt_date, id)`; audit `(legal_entity_id, entity_type, entity_id, occurred_at)` if equivalent index does not already exist. Reuse existing indexes before creating redundant ones.

There must be no uniqueness on shareholder plus currency or declaration date that merges Zemar's two distinct declarations. Multiple receipts per declaration are valid when approved partial receipt policy permits them. Payment reference is not inherently unique; duplicate-warning or uniqueness policy needs explicit approval rather than an invented universal rule.

## 5. Function ownership and permissions proposal

No new protected-table privileges are granted in this task. Future roles use NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE; no runtime membership/SET ROLE into owners, schema CREATE or PUBLIC EXECUTE. Restricted Treasury and Finance credentials stay separate.

The narrowest proposed arrangement reuses `abos_v1_operational_finance_owner` for the private GL capital commit helper because `0028`'s processing-model guard already permits only that owner to create OPERATIONAL_V1 financial rows. Add only the new source/decision column SELECT and exact receipt/posting mutation columns needed by the helper, retaining the owner's existing financial column grants and immutable triggers. Do not add unrestricted SELECT/INSERT/UPDATE/DELETE on all protected tables. A new owner with broad GL grants is not an acceptable shortcut.

A proposed NOLOGIN capital-receipt owner can own public authenticated receipt/query/decision wrappers with SELECT on the new receipt/decision/policy columns and exact INSERT/UPDATE columns on those new tables, plus EXECUTE on reviewed identity/source-lock/private posting helpers. It has no direct writes to journals/lines/subledgers, shareholder masters, documents, sessions or permissions. If existing actors/owner helpers suffice without a new role, prefer that after independent review. Locking protected declaration rows should reuse or introduce a strictly controlled source-lock helper owned by the existing shareholder setup owner, not grant blanket contribution UPDATE. That helper validates the exact entity, current source version/type/status and existence of prior bound receipts.

Private capital commit/reversal/locking helpers must not be granted to PUBLIC or runtime credentials. Wrappers are SECURITY DEFINER with fixed `search_path = pg_catalog, pg_temp` and fully qualified application objects. Reject arbitrary SQL, caller-selected function/operation names, polymorphic source type, caller actor IDs and caller policy mappings. Every wrapper resolves authoritative session and current grants inside the database. A private helper callable by an owner must still validate the immutable source and participant facts; ownership is not a bypass token.

Proposed capital-specific catalogue entries, requiring owner/security approval before installation:

| Proposed permission | Proposed restricted runtime EXECUTE |
|---|---|
| `shareholder.capital-receipt.read` | Source-scoped read wrapper only for approved Finance/Treasury roles. |
| `shareholder.capital-receipt.record` | Treasury receipt record/cancel wrapper only; no GL helper execution. |
| `finance.capital-receipt.approve` | Finance review/decision wrapper only; no bypass of custody/formal eligibility. |
| `finance.capital-receipt.post` | Finance explicit posting wrapper only; authoritative approved receipt and policy required. |
| Existing `finance.reversal.request` / `finance.reversal.approve` | Proposed capital-specific operational wrappers with existing conservative independence; existing E1 wrappers remain unchanged and synthetic-only. |

Capital permission codes are a proposal, not grants. Read-only setup may reuse an existing approved read permission if its semantic scope truly includes receipt metadata; do not expose sensitive evidence by role name alone. Current legacy `finance.journal.post`, `finance.posting-intent.approve` and Treasury custody operations stay outside the `0032` operational configuration/read allowlist.

## 6. Persistent commit and reconciliation invariants

1. Resolve bearer session to ACTIVE user, unexpired/unrevoked immutable PASSWORD_OPERATIONAL provenance, current entity grant and live permission. Reject SYNTHETIC_DEVELOPER and all client authority/policy claims. Lock security rows consistently with the established identity architecture.
2. Lock the exact contribution/allocation before recording a partial receipt. Recheck type CASH, DECLARED status, source version, currency, destination and current remaining allocation. The cancelled installment/legacy agreement is never a candidate.
3. Acquire idempotency and source locks in a stable order; unique constraints arbitrate different keys as well as same-key retries. All result reads recheck scope/current authority.
4. For approval/posting, lock the exact receipt, source binding, approved policy/version, custody/formal decision, period and referenced account mappings. Reject changed source/version, forged evidence, inactive account or unavailable policy.
5. In one transaction create/resolve the one intent, assemble the draft journal and two lines, create matching subledger entries, append audit/outbox, validate full source/policy/period/currency/line/subledger equality, and mark intent/receipt/journal posted. Complete idempotency only with that commit.
6. Treasury subledger effect is `+original_amount`/`+base_amount` to the exact operational destination. Paid-in-capital effect records the receipt's shareholder/business-party and contribution lineage; sign convention follows existing capital subledger conventions and is validated against the journal credit. No unrelated Treasury account/legacy custody movement is touched.
7. Reconcile by entity/destination/shareholder and original currency; reconcile base GL separately in its approved base currency. Do not sum USD and AFN, and do not count declarations as received/posted capital.
8. Reversal is a separately authorized compensated commit with exact original dimensions/accounts/currencies, swapped debit/credit, opposite original/base subledger signs and immutable reversal link. Actual cash refund is a different business event; do not silently perform one. Policy absence blocks all reversal posting.

## 7. Backfill and operational preservation

Backfill: NONE. Existing declarations receive zero inferred receipts and no journals or allocations. No synthetic test fixtures are inserted into the operational environment. Existing owner-created records remain byte-for-byte unchanged apart from future explicitly approved security/schema metadata changes.

Preserve Zemar's two USD 50,000 contribution IDs/dates, Hashmatullah's legacy USD 20,000 agreement/commitment and separate new USD 20,000 declaration, the cancelled USD 5,000 installment, private agreement document/version and Treasury business records. No registration, formal eligibility, approval policy or opening balance is inferred.

No transition of existing data to POSTED/RECEIVED and no forced agreement activation is required. An empty new receipt table is the safe deployment default. Until policies, functions, privilege review and tests are complete, operational actions remain unavailable.

## 8. Future disposable PostgreSQL proof required

No database test harness is run in the current assignment because SQL generation/application and database setup/seed/reset are prohibited. After a separately approved migration is generated, test only against explicitly identified disposable databases, without reading operational credentials/data or touching runtimes.

Required executable proof:

- Fresh install and upgrade from exact 0035 with zero backfill; migration registry/checksum and preserved business fingerprints.
- Real restricted Treasury/Finance logins: no direct protected-table SELECT/INSERT/UPDATE/DELETE, no owner role assumption, no PUBLIC/private-helper EXECUTE and no direct function bypass.
- Operational provenance permits the approved capital wrappers; synthetic provenance fails; existing synthetic-only E1 command paths retain their sandbox requirement; expired/revoked/forced-password-change sessions fail.
- Live permission/entity revocation, cross-entity object/receipt/evidence/destination/account attacks, spoofed actor/policy/source/approval IDs, missing formal/custody policy and inactive mappings fail with no writes.
- Declaration creates zero intent/journal/subledger; actual receipt and approval each create zero journal; ordinary expense approval OFF does not self-approve capital.
- Partial/multiple receipts, exact over-receipt prevention under concurrency, immutable source/date/currency binding and no release of physical custody by unauthorized cancel/reject.
- Same and different idempotency keys, conflicting fingerprints, double simultaneous posting, crash/rollback/retry and at most one committed intent/journal per receipt.
- Closed period, bad accounting effective date, wrong account control/class/currency, unbalanced/extra lines, forged subledger/evidence/policy, tampered status and posted edits/deletes denied by the database.
- Exact two-line journal/subledger reconciliation, zero unrelated Treasury/document drift, two Zemar declarations and legacy Hashmatullah source kept separate, cancelled installment unchanged.
- Reversal remains fail-closed absent policy; approved fixture reversal preserves original and creates exactly one compensated result with independent decision, period/evidence validation and no physical-custody/refund assumption.
- Existing full Treasury/Finance/identity/GL/capital/loan/reversal suites stay green, with no weakening of earlier security/upgrade protections.

A passing in-memory test is not a PostgreSQL pass. Future SQL is not release-ready until independent security review, all executable database proof, operational policy decisions and explicit deployment approval are recorded. This checkpoint ends with proposal and isolated application results only.
