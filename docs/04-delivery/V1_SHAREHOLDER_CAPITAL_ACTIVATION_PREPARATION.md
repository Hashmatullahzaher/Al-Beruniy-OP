# Shareholder Capital production activation preparation

Date: 2026-10-18. Status: **NOT READY FOR PRODUCTION ACTIVATION**.

Preparation branch: `codex/shareholder-capital-production-activation`.
Reviewed application/migration base: `8f388f91d5d80de3a1647790038cd61fe7b1acd1` (0036).
No production configuration or business writes were performed by this workstream.
No production migration, receipt, custody decision, preparation, approval or posting was executed.

## 1. Read-only observation of the preserved environment

All database inspection used explicit `BEGIN READ ONLY` transactions against
`abos_v1_local_review`. No credentials or session tokens were printed.
The environment advanced independently while this preparation was underway:

- Live health endpoint: healthy; application SHA `a3fa673b08ea8c2a81f992cc6e0c08269969bd90`, environment `development`.
- Latest migration: `0037_v1_temporary_funding`; 36 migration records.
- Recorded 0036 checksum remains `669c8afb6938d135800d6c96c74110038c21dded2312f2055517f2a736493a3d`.
- This branch has not modified, integrated or deployed Claude's 0037.
- 0036 checksum comparison uses the repository's canonical LF normalization; raw Windows CRLF file hashes differ.

The observation is a snapshot, not authorization to adopt or alter the independently deployed 0037.
Before integrating a future candidate, obtain the exact accepted 0037 source SHA/checksum and rebase/review dependencies.

| Configuration | Observed state | Required activation action after authorization |
| --- | --- | --- |
| Legal entity | Al-Beruniy, code `002`; USD base currency; currency policy APPROVED | Preserve approved USD policy |
| Existing physical safe | `کسه`, OFFICE_SAFE, ACTIVE; USD currency account DRAFT | Do not confuse this legacy safe record with an Operational V1 Treasury account |
| Operational Treasury accounts | **0** | Owner selects the real safe/custodian; configure an ACTIVE USD CASH account through the controlled operational setup entry point |
| Available cash ledger | `C-01`, Cash; ACTIVE, postable, ASSET/CASH, USD; no mandatory dimensions | Accounting owner confirms this exact existing ledger for the chosen operational safe; no invented replacement code |
| Paid-in-capital ledger | **No EQUITY account exists** | Accounting owner chooses/creates an ACTIVE postable EQUITY/SHAREHOLDER_CAPITAL ledger with no mandatory project/department/cost-center dimensions; owner selects code/name |
| Capital receipt policy | Version 1 true; current version **2 false** | Append a new SHAREHOLDER_CAPITAL_RECEIPT policy version with approval_required=true; preserve other workflow policies |
| Capital mappings | **0** | Register authentic mapping evidence, then append the mapping version through the restricted function |
| Accounting periods | **0** | Authorized Finance owner defines the correct fiscal calendar and opens the appropriate accounting period; do not invent dates |
| Operational capital permissions | No active user/role has any of the seven new capital-receipt permissions | Owner assigns named independent operators as below |
| Synthetic authorizations | **0** | Preserve the absence; do not reactivate E1 sandbox paths |

The active users observed were Local V1 Bootstrap, Hashmatullah Zaher (Super Administrator role),
and Zemar Neroo (CEO role). None currently has the new capital-receipt action permissions.
Zemar's existing configuration permissions include shareholder setup/read, workflow administration,
operational Treasury-account management and period management. Existing administration status does
not constitute capital recorder, verifier or Finance approval authority.

Business counts observed: 2 shareholders, 3 contributions, 1 agreement, 1 installment,
1 agreement document, 3 historical Treasury events. Capital receipts, custody decisions,
capital mappings, operational expenses, journals, journal lines, posting intents and subledger
entries are all **0**. No real business record was changed to make a check pass.

## 2. Corrections and disposable accounting proof

The paid-in-capital mapping API previously required the overall capability to be OPERATIONAL.
Because that capability requires an existing mapping, the configuration route could never establish
the missing mapping. The route now requires an installed schema instead. Same-origin JSON checks,
the live password session, current configure permission, entity isolation, evidence validation and
account validation remain enforced by the existing SECURITY DEFINER entry point.
Receipt, custody, preparation, decision and posting routes retain their full operational preflight.
Independent read-only review found no verified security issue in this two-file correction.

The real PostgreSQL 0036 suite now proves the combined flow on disposable synthetic fixtures:

1. A USD 25,000 CASH declaration creates no journal.
2. Actual receipt and independent custody verification create no journal.
3. Finance preparation and independent approval precede explicit posting.
4. Posting creates one intent, one balanced journal, two lines and two subledger effects:
   Dr the selected Safe ASSET/CASH; Cr the mapped SHAREHOLDER_CAPITAL EQUITY.
5. The operational Treasury subledger increases the exact selected Safe by USD 25,000;
   the capital subledger belongs to the exact shareholder.
6. A normal USD 125.50 Operational Expense uses the **same** Treasury account and cash ledger:
   Dr Expense; Cr Safe. Its policy remains approval OFF, as configured in the disposable fixture.
7. Safe subledger balance becomes USD 24,874.50 with exactly two Treasury movements.
8. The expense journal has two lines with equal debit/credit USD 125.50, one Treasury subledger
   effect and zero shareholder-capital effects. Declaration fields and posted capital remain unchanged.

These are disposable proof amounts, never proposed production transactions or balances.
The test fixture provisions evidence using the test administrator; it does **not** prove that
production operators can register the missing evidence through the application.

## 3. Narrow evidence candidate after accepted 0037

There is no authenticated application entry point that creates CAPITAL_ACCOUNT_MAPPING evidence.
Existing agreement evidence creators hard-code CAPITAL_AGREEMENT. Reusing them, arbitrary SQL
inserts, or weakening the required evidence kind is unacceptable.

A post-0037 candidate (expected number 0038, **not finalized or applied here**) is required:

- Add `abos.shareholder_capital_mapping_evidence_registrations`: immutable evidence ID/entity,
  document reference, actor, recorded-at, correlation ID, idempotency key and request fingerprint.
  Link the evidence/entity pair to `evidence_references` with an entity-qualified foreign key.
- Expose only `register_shareholder_capital_mapping_evidence(text,text,text,jsonb)` to the
  restricted Finance runtime. Owner: `abos_v1_operational_finance_owner`. Runtime gets EXECUTE only;
  no direct evidence, mapping, audit or idempotency-table DML.
- Require live PASSWORD_OPERATIONAL provenance, current `finance.capital-receipt.configure`
  permission and legal-entity scope through `operational_finance_actor`.
- Payload: documentReference, sha256, idempotencyKey, correlationId only. The browser hashes local
  bytes automatically; database validates a 64-character hexadecimal digest. Metadata/hash retention
  is distinct from private file upload/storage and from verification of signatures or legal validity.
- Derive actor/entity/timestamp; generate secure UUIDs in the database. Evidence kind is fixed
  CAPITAL_ACCOUNT_MAPPING. Reject actor/entity/kind/timestamp injection.
- Insert evidence plus immutable registration, audit/outbox and durable idempotency atomically.
  Scope replay to entity/actor/operation; changed payload with the same key fails. Reauthorize replays.
- Restrict the existing mapping function to evidence from this registration path. Add a binding
  uniqueness rule so a single evidence reference cannot silently justify multiple mapping versions.
  Treat any pre-existing conflicting binding as an upgrade failure, never silently rewrite it.
- Grant only the precise existing insert/select columns and trigger/function dependencies required
  by that function. No broad owner grants, generic evidence API or runtime table writes.
- Zero business backfill and no conversion of old agreement evidence into mapping evidence.

Mandatory disposable tests before candidate acceptance: missing/revoked permission, expired/revoked
session, synthetic provenance, entity substitution, direct runtime DML/helper execution, invalid
hash/reference, forged metadata, idempotent replay/conflict/concurrency, immutable rows, duplicate
binding, audit/outbox integrity, upgrade with preserved rows and zero Treasury/GL effects.

**Additional evidence blocker:** custody verification and Finance approval also require evidence IDs,
but the operator currently has no production registration/picker path for those purposes. A mapping
registrar alone is insufficient. Review narrowly scoped capital-custody/decision evidence registration
and source binding alongside the candidate; do not introduce a generic unrestricted evidence writer.
Complete this implementation only against the exact accepted 0037 base and independent security review.

## 4. Required operators and UI readiness

Use current legal-entity-scoped grants, not developer tokens. The owner must select actual people.
Minimum separation is three distinct people; a four-person recorder/verifier/preparer/approver setup
is clearer. The approver must also be the person who explicitly posts under the current 0036 rules.

| Responsibility | Action permission | Additional currently required reads |
| --- | --- | --- |
| Receipt recorder | shareholder.capital-receipt.record | shareholder.read; shareholder.capital-receipt.read |
| Independent custody verifier | treasury.capital-receipt.verify | shareholder.read; shareholder.capital-receipt.read |
| Finance preparer | finance.capital-receipt.prepare | shareholder.read; shareholder.capital-receipt.read |
| Independent Finance approver and poster | finance.capital-receipt.approve; finance.capital-receipt.post | shareholder.read; shareholder.capital-receipt.read |
| Mapping administrator | finance.capital-receipt.configure | Appropriate Finance configuration visibility |

Custody verifier must differ from recorder; Finance approver must differ from recorder, verifier
and preparer. Routine expense approval OFF does not remove capital's explicit approval requirement.

Production UI is **not yet operator-ready**. `/shareholders` already exposes record, verify, prepare,
Finance approve/reject, post and trace in English/Dari, but essential gaps remain:

- Raw evidence UUID entry and absent evidence/configuration UI.
- Navigation does not recognize the seven new bridge permissions. Contribution projection still
  requires shareholder.read or setup.manage; assigning action permissions alone is insufficient.
- Custody UI offers verification but not the existing backend rejection action.
- Rejected states can display as awaiting custody; main declaration receipt_status remains stale
  relative to the separate operational receipt trace.
- Trace lacks operator-friendly evidence, actor/time, reasons, policy/mapping and journal detail.
- No operational capital browser test with independent authenticated personas exists yet.

Smallest next UI slice: retain `/shareholders`; fix navigation, add a compact status-filtered capital
receipt list, add narrow evidence selection/registration, custody rejection/reason and accurate
terminal states; display trace as authoritative. Add mapping setup under Finance setup. Keep the
memory-only review route gated and do not treat it as the production workflow.
These changes depend on the coordinated evidence/read-projection candidate and remain activation blockers.

0036 also requires actual receipt date to equal declaration date. Before selecting a real contribution,
confirm this is factually correct; do not falsify dates or rewrite user records to bypass that rule.

## 5. Income readiness

**C — NOT IMPLEMENTED.** Revenue ledger types and policy labels exist, but no operational income
source, restricted posting lane, APIs, permissions or usable income UI exists. Stage 0 Sales/CRM
collections are demonstrations, not operational receipts.

The smallest separate next slice is same/base-currency Other Income: immutable source/evidence,
Treasury custody, configurable approval snapshot, idempotency/audit, Dr exact Safe/Bank ASSET,
Cr an owner-approved REVENUE account, Treasury subledger increase and register/daily-report integration.
Customer receipts require a separate AR/contract/installment allocation design; do not assume every
customer collection is immediate Revenue. No Income implementation was added to this branch.

## 6. Activation runbook — do not execute without authorization

1. Obtain accepted integrated application SHA and exact 0037 plus evidence-candidate migration checksums.
   Confirm clean checkout, guarded runtime SHA and no unexpected sessions. Re-audit current state.
2. Create a fresh private full PostgreSQL backup plus roles-only dump; validate listing and test restore.
   Back up the external document vault separately, record SHA-256s and reconcile restored metadata/files.
3. Capture deterministic ordered row fingerprints/counts of **all current** business tables, including
   0037 objects, plus migration checksums, scope/grants, vault manifest and zero posting baselines.
4. Deploy only the independently accepted additive candidate through the normal migration runner.
   Verify zero backfill, old checksums unchanged, runtime least privilege and exact guarded app SHA.
5. Owner assigns named independent scoped operators from the permission table. Use fresh password
   sessions; prove allowed reads and denied cross-entity/role actions before configuration.
6. Accounting owner confirms existing C-01 cash ledger and chooses the paid-in-capital account code/name.
   Create/configure only those explicitly authorized accounts through controlled application endpoints.
7. Configure the selected ACTIVE operational USD CASH Treasury account. Do not use the legacy DRAFT
   currency account as a substitute or initialize an invented opening balance.
8. Append capital receipt policy approval_required=true through Workflow approvals; leave EXPENSE and
   all other policies unchanged. Capture version, actor, reason, correlation and audit/outbox evidence.
9. Register the genuine mapping document reference/fingerprint through the new narrow endpoint; bind
   it to the approved EQUITY/SHAREHOLDER_CAPITAL ledger via `/api/v1/finance/shareholder-capital-mapping`.
10. Confirm owner-approved calendar/period and actual receipt/accounting dates. Open only the approved
    period through controlled authority. Capability OPERATIONAL alone does not prove an open period.
11. Capability must report PASSWORD_OPERATIONAL, correct policy/mapping versions and exact USD Treasury
    destination. Recheck operator-ready production UI and independent authenticated browser tests.
12. Owner selects **one** real DECLARED CASH contribution and confirms amount, actual cash/date,
    source and supporting evidence. Never use the cancelled contribution or an invented transaction.
13. Recorder records actual cash; confirm zero GL. Different custodian verifies physical custody;
    confirm zero GL. Finance prepares; independent approver approves; that approver explicitly posts.
14. Inspect one source-bound posting intent, one balanced journal, exactly two journal lines and two
    subledger effects; reconcile exact Safe and shareholder positions, trace and audit/outbox.
    Replaying the same command must not duplicate posting. No unrelated contribution/expense drift.
15. Compare all fingerprints against intended changes only. Keep rollback package and receipt trace;
    posted records cannot be deleted/reset. Any correction requires the separately governed reversal
    process; automatic reversal activation is outside this first production scope.

## 7. Validation evidence and limitations

- Lint: passed, zero warnings.
- Strict typecheck: 12/12 packages passed.
- Unit suites, including Finance: **163 passed, 0 failed, 0 skipped**.
- Full real PostgreSQL suite on disposable `abos-shareholder-finance-0036-pg`, port 55442:
  **198 passed, 0 failed, 0 skipped**, 26 suites. Includes 13 capital-bridge tests and combined
  Capital -> Safe -> Expense proof. The preserved database at port 55432 was not a test target.
- Production build: passed, 11/11 tasks.
- Serial browser suite on isolated port 3189: **42 passed, 0 failed, 19 skipped**. All nine executed
  smoke-tagged tests passed. Skips require explicit isolated authentication/preview fixture flags;
  this run does not establish operational capital UI readiness or exercise real business records.
- Initial sandbox-only unit/build attempts were blocked by Windows hard-link/junction permissions;
  unrestricted reruns succeeded without code changes.
- Independent review of the mapping-preflight correction: no verified security issue.
- Migration 0036 and the migration registry are unchanged; no 0037/0038 file was added.

The remaining deliverable is the coordinated post-0037 evidence/UI implementation and its full
authenticated acceptance proof. This preparation is not approval to configure or post real capital.
