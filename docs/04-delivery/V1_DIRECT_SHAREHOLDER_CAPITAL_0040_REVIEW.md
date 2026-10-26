# Direct Shareholder Capital — 0040 implementation review

> **Superseded.** This describes the earlier two-step shape of migration 0040 (add shareholder,
> then receive capital), which was never applied to any database. The owner asked for one save,
> four ways of contributing, an optional agreed total and no ownership percentages, so 0040 was
> reshaped in place and its checksum changed. For what 0040 now contains, read
> `V1_SIMPLE_SHAREHOLDER_CAPITAL_0040.md`. Kept for the record of what was reviewed and why.

Review date: 2026-10-25 (Asia/Kabul). Status: IMPLEMENTED AND VALIDATED; OWNER REVIEW REQUIRED BEFORE PUSH OR DEPLOYMENT.

Repository: `Hashmatullahzaher/Al-Beruniy-OP`. Branch: `codex/v1-direct-shareholder-capital`.
Base: `817974a9947bdab967f0f1a0f7a1fc4d25bb777b` (0039). This report accompanies the local implementation commit; the delivery response records its exact SHA. No merge, push, preserved-database migration, startup change or real financial transaction is authorized by this checkpoint.

## 1. What changed

The ordinary `/shareholders` route is now a bilingual direct-capital workspace. It records one business event once and shows server-derived capital figures, posted receipt history, the General Ledger and optional private document versions. The existing component remains at `/shareholders/legacy`; ordinary navigation goes to the new workspace. The approved shared visual system, architectural image and holographic application are unchanged.

Additive migration `0040_v1_direct_shareholder_capital.sql` has canonical LF SHA-256:

`6ca98480bc7b499841ecaf68dc5b7a61658c2a61be82f5fcfd351880a187077f`

It is registered after 0039, with no edits to migrations 0001–0039 and no business-data backfill. It adds:

| Object | Purpose and constraints |
|---|---|
| `direct_capital_receipts` | Immutable completed receipts, exact numeric amount/currency, company/profile/Safe/equity/policy/journal/actor linkage. Company + idempotency key unique; company + reference unique; journal + company unique. Composite foreign keys prevent cross-company links. Journal FK is deferred until commit. |
| `direct_capital_receipt_allocations` | Immutable receipt allocations to existing CASH declarations. PK receipt + contribution; company-qualified FKs. Receipt totals must equal allocations. |
| `shareholder_profiles` nullable fields | `ownership_percentage`, `capital_note`, `capital_document_agreement_id`. Ownership constrained 0–100; attachment link company-qualified. |
| `posting_intents.direct_capital_receipt_id` | New disjoint `DIRECT_SHAREHOLDER_CAPITAL` kind/source, unique intent per receipt. Rejects legacy, expense, funding, FX and dimensional lineage mixed into this source. |
| `subledger_entries.direct_capital_receipt_id` | Exact receipt lineage for the Treasury and shareholder sides. Other sources cannot use this linkage. |

Indexes support company/profile/date receipt lookup and company/contribution allocation lookup. Append-only triggers prohibit receipt/allocation update/delete. Exact journal validation, deferred completeness checks and an explicit reversal refusal protect committed accounting truth.

Four new SECURITY DEFINER entry points use only existing restricted NOLOGIN owners:

| Entry point | Owner | Authority |
|---|---|---|
| `direct_shareholder_create` | `abos_v1_shareholder_setup_owner` | Current `shareholder.setup.manage`; operational password provenance. |
| `direct_shareholder_receive` | `abos_v1_operational_finance_owner` | Current receipt-record + Finance-prepare + Finance-post permissions, all required. |
| `direct_shareholder_capital_workspace` | `abos_v1_operational_finance_owner` | Current setup-manage or capital-receipt-read permission. |
| `direct_shareholder_document_holder` | `abos_v1_shareholder_setup_owner` | Current setup-manage; optional attachment holder only. |

EXECUTE is granted only to existing Finance runtime `abos_e1_runtime`; PUBLIC execution is revoked. Neither Treasury nor identity runtime gains access. Helpers remain non-runtime entry points. The deferred read-only completeness trigger uses the existing operational owner because it executes at outer transaction commit.

The operational owner receives SELECT and named-column INSERT on the two new tables, named-column INSERT for their new intent/subledger links, and the existing controlled declaration-lock function. The setup owner receives only receipt profile/company SELECT and profile presentation/attachment column privileges. The capital owner receives only allocation company/contribution/amount SELECT. Narrow existing-account governance/currency and document-metadata reads support validation/projection. No runtime receives protected-table INSERT, UPDATE, DELETE, TRUNCATE, owner membership or privileged helper EXECUTE.

Narrow replacement function bodies are included only in 0040: operational-journal dispatch, legacy receipt reservation accounting, posted-capital profile protection, declaration immutability and Daily Report Treasury movement projection. Historical behavior stays covered by the complete regression suite. No Temporary Funding workflow implementation is changed; its existing amount, Safe validation, period, idempotency and audit primitives are reused unchanged.

## 2. Exact new Shareholder workflow

1. Add shareholder: name, total capital and currency; optional ownership, reference, note and agreement document. Saving creates a shareholder and a non-financial CASH declaration atomically. It creates no journal, receipt, installment or mandatory agreement.
2. Select that shareholder and choose **Receive Capital**.
3. Enter amount, date and destination Safe; currency, reference and note are explicit.
4. Choose **Save / Receive** once. The controlled function either commits the receipt, allocations, intent, journal, signed subledgers, audit and completed idempotency record together, or rolls them all back.
5. The returned server workspace immediately shows total, received, outstanding, reference, destination, history and ledger navigation. Repeated partial receipts use the same flow.

Documents may be attached later. File selection never asks a user to type a hash. Existing bounded PDF/JPG/PNG validation, server SHA-256, random private storage IDs, company/agreement authorization, immutable versions and authenticated download are reused. An optional internal DRAFT holder is created only for attachment; upload does not verify signatures, registration, identity or legal validity and does not activate an agreement. Failed uploads preserve the shareholder and allow retry with the same upload key.

## 3. What user-facing steps were removed

The ordinary capital page does not require a Capital Request, eligibility review, capital agreement, installment, manual custody/count/verification, Treasury handoff, separate preparation/approval/post buttons or posting-intent management. Optional files are presented in simple English/Dari language. Legacy machinery remains protected behind its existing commands and is not silently marked completed.

Company capital-approval policy must explicitly be OFF for this direct lane. ON or unconfigured policy fails closed; the feature never changes the company's policy. The platform's existing separate-approval capability remains intact.

## 4. How Safe, Shareholder and GL are linked

Each immutable receipt binds an exact company, shareholder profile, operational Safe, existing equity ledger, policy snapshot and journal. Allocations reserve and consume the underlying declarations using the same stable row locks as the old receipt lane. Allocation uses only the frozen set of locked declaration IDs; concurrent or legacy receipts cannot over-receive the shared capital.

For a USD 20,000 receipt, the single journal is **Dr selected Safe asset USD 20,000 / Cr shareholder-capital equity USD 20,000**, with the shareholder party on the credit line. Treasury subledger is +20,000; shareholder-capital subledger is -20,000. Journal/source/date/actor/company/currency/amount and both subledger sides are checked before posting. No direct Safe balance column is mutated.

Received/outstanding amounts are derived from committed receipt allocations and actually posted historical receipts; declarations stay non-financial. Outstanding availability also reserves pending legacy receipts. Safe display is authorized recorded activity, not a physical cash count or verified opening balance. Reporting permission and live project/department/cost-center scope restrict that projection; absent permission yields unavailable, never a fabricated zero.

The direct source also appears in the existing GL and Daily Report Treasury movement projection. A PostgreSQL regression demonstrates that direct receipts fund the ordinary operational expense lane without altering shareholder received capital.

## 5. Which legacy components still remain internally

Agreements, installments, evidence registration, legacy receipt/custody/approval/mapping tables and commands, synthetic E1 guards and historical reporting remain intact. The old UI is retained at `/shareholders/legacy` for explicit historical administration; it is not part of the new ordinary workflow. Existing agreement document storage remains the one vault.

No fake verification, custody event, approval, mapping or synthetic authorization is created to satisfy an obsolete prerequisite. No posted historical record is relabeled. Direct-capital reversal is explicitly unavailable pending a separately reviewed workflow.

## 6. Exact test results

All database execution used disposable PostgreSQL 17 on localhost:15440, never `abos_v1_local_review` or port 55432. Browser financial fixtures used only `abos_direct_capital_browser_0040` and localhost:3191 with separate restricted identity/Finance/Treasury logins. That company has zero sandbox authorizations/scopes, developer sign-in disabled and actual PASSWORD_OPERATIONAL sessions.

| Validation | Final result | Evidence under ignored `test-results/direct-capital/` |
|---|---|---|
| Entire PostgreSQL security/integration suite | 250 passed, 0 failed, 0 skipped/cancelled; 30 suites | `pg-full-green.log` |
| Direct capital PostgreSQL cases (included above) | 22 passed; 0 failed/skipped | Same full log; creation, retries, partial receipts, signed balanced subledgers, oversubscription/races, late-failure rollback, permissions/provenance/entity/scope, exact decimals, immutability, NULL-party attack and runtime privilege checks |
| Unit suite | 168 passed, 0 failed/skipped | `unit-final.log` |
| Strict typecheck | 12/12 tasks successful | `typecheck-final.log` |
| Lint | Passed, zero lint warnings/errors | `lint-final.log` |
| Production build | 11/11 tasks successful | `build-final.log` |
| Smoke | 10 passed, 0 failed/skipped | `smoke-final.log` |
| Full serial general browser suite | 53 passed, 0 failed, 22 expected fixture/environment-gated skips | `browser-general-final.log` |
| Actual password/PostgreSQL browser financial + document flow | 1 passed, 0 failed/skipped | `browser-operational-final.log` |
| Actual password browser desktop/tablet/Dari/RTL/keyboard | 1 passed, 0 failed/skipped | `browser-operational-responsive.log` |

The two dedicated browser tests ran separately against the same disposable preview. The first proves creation at USD 100,000, receipts 20,000 + 10,000, received 30,000/outstanding 70,000, Safe activity 30,000 and four real GL lines. It then uploads two PNG versions, checks server hash and byte size, downloads exact bytes, proves anonymous download returns 401, rejects false PDF bytes with 422 and confirms attachments leave GL lines unchanged. The second verifies 1440px desktop and 820px Dari tablet, no document-wide overflow, keyboard activation and automatic focus. Saved screenshots are in `apps/web/test-results/direct-capital-operational/`.

The existing unit vault backup/restore test passed with exact metadata/version consistency; the full PostgreSQL suite passed historical agreement linkage, company isolation and optional-policy regressions. No live backup or restore was attempted.

Initial failed runs are retained: a broader-than-needed new owner SELECT was narrowed, exact privilege/upgrade snapshots were updated only for approved new columns, and an aged historical fixture role date was anchored to its accounting date. A real browser assertion was corrected to the existing heading “General Ledger activity”; one startup timing attempt preceded server readiness. These are resolved; final results above are the completed runs. Turbo emitted non-fatal cache IO warnings and Node emitted NO_COLOR/FORCE_COLOR warnings; command validation still passed.

Independent read-only security review: PASS after correcting shareholder subledger sign, frozen declaration locks, permission/scope-filtered Safe activity and NULL-safe party comparison. Reviewer rechecked ownership, grants, authentication, API dispatch and exact checksum; parent executed the tests. This is implementation review, not owner deployment approval.

## 7. Exact demo steps for the client

Use **http://127.0.0.1:3191/shareholders**, not the preserved app on 3200. The isolated page is opened for review. Demo-only sign-in details are in ignored `test-results/direct-capital/demo-credentials.txt`; no real credentials are in source or this report.

The prepared **Demo Shareholder** already shows 100,000 total / 30,000 received / 70,000 outstanding USD and two posted receipt rows. Select it, view both document versions and choose General Ledger to see equal USD 30,000 debit/credit totals. Switch English/Dari to review labels and direction.

To demonstrate the complete creation flow afresh in this disposable environment: Add shareholder → enter a distinct demo name, 100000 and USD → Save shareholder → Receive Capital → 20000, today's date, Demo USD Safe → Save / Receive → repeat with 10000. The new shareholder then shows 100000/30000/70000; the shared Safe activity increases by the new receipts, so it will exceed the already-prepared 30000. Attachment is optional throughout. These instructions do not authorize a real-company demonstration transaction.

The committed bootstrap script is explicitly guarded to the named disposable database on localhost:15440 and requires an additional reset acknowledgement. It does not read live configuration or install startup automation.

## 8. Exact commit SHA / branch

Branch: `codex/v1-direct-shareholder-capital`. Base: `817974a9947bdab967f0f1a0f7a1fc4d25bb777b`.

The delivery response records the full local implementation SHA. No push, PR, merge or preserved-runtime deployment has been performed; the owner explicitly reserved those until this report is reviewed.

## 9. Any remaining blocker

No unresolved blocker for the isolated demonstrated scope. Push and deployment require the owner's review/authorization. Migration 0040 remains unapplied to the preserved database; localhost:3200 remains on the accepted 0039 runtime.

First activation is CASH in the approved company base currency only. Cross-currency/FX posting, bank/non-cash receipt activation, refunds and direct reversal remain deferred. Receiving requires an existing active valid Safe, an OPEN period, exactly one eligible existing typed equity account, explicit OFF capital policy and current permissions. Missing configuration fails closed; no real period, account, policy or mapping was changed for testing.

Safe values remain recorded activity rather than certified opening/physical balances. Journal links open the authorized GL activity view and display the exact journal identifier; the existing GL does not yet filter its list by the supplied journalId query. No broader V1 completion or production-readiness claim is made.
