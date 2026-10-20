# V1 administrative approval controls — deployment review

Owner order: **OWNER DECISION — IMPLEMENT ADMIN-CONTROLLED APPROVAL SWITCHES FOR V1**.
Repository: `Hashmatullahzaher/Al-Beruniy-OP`.
Branch: `codex/v1-admin-approval-switches-0039`.
Accepted production/code baseline: `9f05efd7279e77bbf3e219535bcebeb305118c56`.

This checkpoint is implementation for review, **not authorization to deploy**. Migration 0039,
company policies and the production account release have not been applied to the preserved database.
No real receipt, custody verification, intent, journal, Safe effect or period opening is authorized here.

## 1–5. Revision, changed files and migration

Implementation/final revision and completed validation totals are recorded in the delivery response.
Migration: `infrastructure/database/migrations/0039_v1_admin_approval_controls.sql`.
SHA-256: `e61215e72d6853bf8a3d796d01222b98937f464b2b316b800f5bfc5d3c8f796b`.
The registry contains this checksum. Migrations 0001–0038 and their registered checksums are unchanged.

Files changed, relative to the accepted baseline:

- `apps/web/playwright.capital.config.ts`
- `apps/web/src/app/api/v1/admin/finance-workflows/route.ts`
- `apps/web/src/app/api/v1/finance/accounts/[accountId]/reevaluate/route.ts`
- `apps/web/src/components/ChartOfAccountsWorkspace.tsx`
- `apps/web/src/components/FinanceWorkflowPolicyWorkspace.tsx`
- `apps/web/src/components/ShareholderCapitalBridge.tsx`
- `apps/web/src/server/chart-of-accounts.ts`
- `apps/web/tests/v1-shareholder-capital-activation.spec.ts`
- `apps/web/tests/v1-workflow-policy.spec.ts`
- `apps/web/tests/workflow-approval-controls.spec.ts`
- `packages/contracts/src/shareholder-finance-bridge.ts`
- `packages/contracts/src/workflow-policy.ts`
- `packages/database/src/migrations.ts`
- `packages/e1-integration/src/admin-approval-switches.test.ts`
- `packages/e1-integration/src/admin-approval-upgrade.test.ts`
- `packages/e1-integration/src/security-ownership.test.ts`
- `packages/e1-integration/src/safes-saraf.test.ts`
- `packages/e1-integration/src/shareholder-finance-bridge-schema-gated.test.ts`
- `packages/e1-integration/src/workflow-policy.test.ts`
- `packages/identity/src/identity-service.ts`
- `packages/sandbox-auth/src/authenticator.ts`
- The migration and this report.

## 6–7. Administrative interface and workflow catalogue

Route: **`/admin/finance-workflows`**, navigation **Workflow approvals**.
Authenticated API: `GET/PUT /api/v1/admin/finance-workflows`.
Independent switches use these exact canonical identifiers:

| Workflow | Identifier |
| --- | --- |
| Chart of Accounts | `CHART_OF_ACCOUNTS` (new configuration category) |
| Shareholder capital receipt | `SHAREHOLDER_CAPITAL_RECEIPT` (existing) |
| Customer receipt | `CUSTOMER_RECEIPT` |
| Other income | `OTHER_INCOME` |
| Expense | `EXPENSE` |
| Supplier payment | `SUPPLIER_PAYMENT` |
| Salary or wage payment | `SALARY_PAYMENT` |
| Treasury transfer | `TREASURY_TRANSFER` |
| Temporary Funding | `TEMPORARY_FUNDING` |

The catalogue is configuration, not a claim that every future business workflow is implemented.
No duplicate Capital identifier is added. No entity policy is seeded by 0039. Existing Expense and
Temporary Funding behavior/configuration remain unchanged. The bilingual interface shows current
ON/OFF, version, actor, database time, reason and complete version history. English/Dari, RTL and
tablet controls remain available.

## 8–9. Versioning, authorization and least privilege

`finance_workflow_policy_versions` remains append-only and entity/workflow/version unique.
The new command receipt `finance_workflow_policy_commands` stores the policy FK, derived actor/entity,
idempotency key, normalized request fingerprint, correlation UUID and original response snapshot.
No command receipt may be updated/deleted. Keys are unique within entity + actor; a changed request
under the same key is rejected. A command-key lock and entity/workflow policy lock serialize writes.
Expected-version comparison rejects stale changes without blind retries or lost updates.

`finance_workflow_policy_set_command(text,text,text,jsonb)` is the sole enabled setter. The old
unkeyed setter is revoked from the runtime and fails closed. PostgreSQL resolves a live
`PASSWORD_OPERATIONAL` session, current entity scope and `admin.finance-workflow.manage` permission.
Internal `system.local-bootstrap.%` actors and developer sessions are refused. Actor/company/time
cannot be supplied by the client. Authorization precedes even idempotent replay. The web mutation
also retains same-origin/JSON/session-cookie controls.

The existing `abos_v1_workflow_policy_owner` remains NOLOGIN, without role membership; 0039 explicitly
fails if it has inherited or granted membership. It owns the setter, has narrowly scoped command
receipt SELECT/INSERT, and no CoA or financial-table authority is added. Identity runtime receives
EXECUTE only. CoA owner receives only the five required immutable policy columns and narrowly scoped
release-receipt INSERT/new governance-column UPDATE. Finance runtime receives EXECUTE on account
reevaluation, never table DML. Capital evidence/projection owners receive only additional policy
columns required by their existing functions. No PUBLIC execution is introduced.

## 10–12. ON/OFF and in-flight semantics

**CoA:** missing policy safely preserves legacy review-required behavior. New or materially changed
account definitions snapshot the effective policy. ON sets governance `PENDING_REVIEW`; independent
review remains available. OFF sets `NOT_REQUIRED`, with no reviewer or review decision. Existing CoA
lifecycle is preserved: valid newly created ledger accounts were already ACTIVE under migration 0014;
governance review is separate. 0039 does not invent a new account-activation or posting bypass.

**Capital:** receipt recording remains distinct from declaration, independent custody, prepare and
explicit final posting. PREPARE binds the current immutable policy and mapping. ON creates
`PENDING_APPROVAL` intent v1; independent approval produces v2; the original approver posts v3.
OFF creates `VALIDATED` intent v1; the original preparer explicitly posts v2 with current prepare
**and** post permissions, without any approval decision/evidence/approve permission.

Both paths still enforce live authority/entity, exact declared CASH source, actual amount/date,
eligible base-currency Safe/ledger, approved capital mapping and evidence, independent custody,
open period, fixed-precision amounts, immutable source facts, balanced journal, both subledgers and
durable idempotency. Trigger-level policy/version/actor checks match command-level rules. The 0037
generic posting dispatcher and Temporary Funding lane are unchanged.

Changing the global switch never changes an intent's bound policy. A bound ON transaction still
requires approval after a global OFF change; a bound OFF transaction stays approval-free after a
global ON change. A receipt not yet prepared uses the effective policy at PREPARE. Completed facts
and historical approvals are never rewritten. Switching policy alone creates no financial object.

## 13–14. Existing paid-in-capital account and explicit release

Read-only inspection identified **actual code `E1`, not `E-01`**:
`c7ebf087-9c69-4aa3-9687-7436d9477ad8`, English name `Paid in shareholder capital`.
It is EQUITY / SHAREHOLDER_CAPITAL / USD, ACTIVE, posting-enabled, without required dimensions;
governance v1 remains PENDING_REVIEW/CREATED, created and last changed by Zemar, with no reviewer.
No rename, replacement or release was performed. Its exact identity must be confirmed in the future
deployment preflight, without silently changing the owner's original record.

After a separately authorized explicit CoA OFF policy, the user can choose **Re-evaluate under
current policy**. `finance_account_policy_reevaluate(text,uuid,jsonb)` requires account-manage
permission, exact entity/account/version, reason, idempotency key and correlation UUID. It only
releases ACTIVE/PENDING_REVIEW under an explicitly configured current OFF policy. It reruns
`coa_validate` and the single-capital-account invariant, changes governance to NOT_REQUIRED, binds the
policy, increments governance version and appends immutable `ledger_account_policy_releases` plus
`LEDGER_ACCOUNT_RELEASED_UNDER_POLICY` audit metadata with `approvalOccurred=false`.

Creation/last-change history is preserved. No `ledger_account_review_decisions` row is inserted,
no reviewer is invented and no ledger/business/accounting amount is written. A flagged correction
is not released by this action. Replays require current live authority and return the original result.

## 15–19. Verification and independent review

Tests are confined to disposable databases/storage and test servers.

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Unit tests (all nine tested packages) | 163 | 0 | 0 |
| Full PostgreSQL suite (29 suites) | 228 | 0 | 0 |
| Exact final-checksum historical upgrade recheck | 1 | 0 | 0 |
| Targeted approval/ownership/policy PostgreSQL checkpoint | 19 | 0 | 0 |
| Treasury event regression checkpoint | 5 | 0 | 0 |
| General serial browser suite | 44 | 0 | 20 |
| Authenticated serial browser suite | 4 | 0 | 0 |

The 20 general-suite skips are existing environment-gated authenticated journeys. The separate
authenticated run executes the relevant policy administration, Capital ON, Capital OFF and Temporary
Funding journeys without skips. Nine passing general browser cases are smoke checks; the Capital ON
authenticated journey is also a smoke case. No production smoke was run before authorization.
Lint passes with zero warnings; strict typecheck passes all 12 workspaces; production build passes
all 11 tasks. The only final migration formatting adjustment removes a blank line after the SQL,
without changing any statement. Its final checksum is verified by the registry/unit checks and
an additional normal-runner historical-upgrade check against the exact final file.

Coverage includes:

- Administrative ON/OFF, immutability/history, actual actor/audit/correlation, durable replay,
  request conflicts, stale/concurrent versions, revocation, developer/bootstrap/forgery/wrong-runtime
  refusal and company isolation.
- CoA ON/OFF/new definitions, controlled old pending-account release, real capital-control account
  release shape, invalid account rejection, stale/unauthorized/unknown-account refusals, no fake
  decisions and intact creation/history.
- Capital OFF with independent custody, missing mapping/evidence and closed-period refusals,
  exact balanced posting and zero approval decisions; ON/OFF in-flight binding in both directions.
- Historical upgrade using the normal migration runner: original business fields, policy/review
  history and old checksums preserved; only protective governance defaults, canonical type and
  empty command/release tables added. Repeat migration runner is a no-op. Runtime table access denied.
- Full Treasury, legacy E1, operational Expense, Temporary Funding, GL, identity, evidence/storage,
  capital commitment, ownership and concurrency regressions.
- Real password/restricted-runtime browser journeys for ON and OFF Capital, explicit posting,
  future global-policy change, zero fake approvals, balanced journal/subledgers, Dari and tablet.
- Administrative permission assignment, real policy history and denied unauthorized API mutation;
  focused retry identity and CoA release UI coverage.

Independent read-only security review checked Capital binding/immutability, CoA validation/lock order,
workflow-owner membership, column privileges, session provenance and unchanged 0037 dispatch. It
identified the missing explicit membership assertion and an excessive read grant; both were fixed.
Final independent review found no remaining verified defect. Initial sandbox-only unit/build link
failures were rerun with normal Windows permissions; no workaround weakened code/security.
An existing Treasury regression assumed wall-clock timestamps always sort in lifecycle order.
The final isolated run exposed that assumption during host/VM clock movement. The test now proves
all five exact predecessor/successor edges and immutable row snapshots once each, independently of
wall-clock ordering. No Treasury production function or event timestamp was changed.

## 20. Production boundary and next authorized deployment

**No production transaction, policy switch, account release, period opening, migration application,
credential/startup change or deployment occurred.** The preserved runtime remains on the accepted
0038 checkpoint. Production-safe smoke is deferred until deployment is separately authorized.

Future controlled deployment must first reconfirm runtime/HEAD, migration registry, private backup
and test restore, business fingerprints, vault consistency, active sessions and exact account identity.
Apply only reviewed 0039 via the normal runner and guarded runtime procedure. With a real permitted
password user, append CoA OFF and Capital v4 OFF only if the current Capital policy is still v3.
Any drift requires re-reading current state, not overriding versions. Leave Expense and Temporary
Funding untouched. Then explicitly reevaluate the identified existing capital account, verify its
policy-release audit and zero review decisions, rerun read-only smoke and business fingerprints.
Do not create a receipt, cash verification, posting intent, journal or open period during that work.

Until that authorization: **STOP FOR FINAL REVIEW — NOT DEPLOYED**.
