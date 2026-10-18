# V1 Temporary Funding — migration 0037

Status: implemented on `claude/p2-temporary-funding`, rebased on the deployed Shareholders → Finance
baseline `8f388f91d5d80de3a1647790038cd61fe7b1acd1` (0036). **Not deployed.** Migrations 0001–0036 are
unchanged; the 0036 checksum stays `669c8afb6938d135800d6c96c74110038c21dded2312f2055517f2a736493a3d`.

## 1. Business rule and first production scope

A cash shortage is never represented by letting physical Safe cash go negative. When a person or
organization temporarily funds the business, the company records an explicit per-provider liability
on a ledger account with control type **`TEMPORARY_FUNDING_PAYABLE`**.

**Active in this slice:**
- base currency only;
- the provider must already exist as a same-entity Business Party;
- Mode A, `PROVIDER_PAID_EXPENSE_DIRECTLY`, and Mode B, `PROVIDER_FUNDED_SAFE`;
- partial and full settlement;
- independent approval;
- idempotent posting;
- a provider-specific liability and subledger.

**Not active:**
- funding reversal;
- foreign currency, FX snapshots, conversion and FX gain/loss;
- a provider registration workflow;
- the Safe non-negative guard.

## 2. Journal contracts (one balanced two-line journal each)

| Event | Line 1 | Line 2 | Subledgers |
|---|---|---|---|
| Mode A | Dr the expense category's EXPENSE ledger (payee party, dimensions) | Cr the mapped payable (provider party) | `TEMPORARY_FUNDING_PAYABLE` +amount on line 2 only. **No Treasury effect.** |
| Mode B | Dr the selected Safe / cash box / petty cash ledger (ACTIVE, ASSET, CASH, base currency, no dimensions) | Cr the mapped payable (provider party) | `OPERATIONAL_TREASURY` +amount on line 1; `TEMPORARY_FUNDING_PAYABLE` +amount on line 2 |
| Settlement | Dr the mapped payable (provider party) | Cr the selected Treasury source (ACTIVE, ASSET, CASH, base currency) | `TEMPORARY_FUNDING_PAYABLE` −amount on line 1, with funding and settlement lineage; `OPERATIONAL_TREASURY` −amount on line 2 |

A settlement uses the funding's own mapping version. It never creates an expense line and never reposts the original journal.

## 2a. Provider classification

`provider_kind` records only what live Business Party roles prove on the funding date:

| Kind | Rule |
|---|---|
| `SHAREHOLDER` | the party holds a current SHAREHOLDER role (takes precedence) |
| `EMPLOYEE` | otherwise, the party holds a current EMPLOYEE role |
| `EXTERNAL_OTHER` | any other person or organization |

`business_parties` has no authoritative person/organization attribute, so no such classification is stored. The recorder's `providerKind` must equal the database-derived value (checked by the entry point and the funding insert guard); `INDIVIDUAL`, `ORGANIZATION` and `EMPLOYEE_OFFICER` are not accepted. The UI shows the derived type and does not ask for it.

## 3. Source discriminators

| Source | `posting_intents.intent_kind` | `source_type` (intent, lines, subledger) | Typed FK |
|---|---|---|---|
| Funding | `TEMPORARY_FUNDING` | **`TEMPORARY_FUNDING`** | `temporary_funding_id` |
| Settlement | `TEMPORARY_FUNDING_SETTLEMENT` | **`TEMPORARY_FUNDING_SETTLEMENT`** | `temporary_funding_settlement_id` (+ `temporary_funding_id`) |

- **Model-aware CHECK.** `posting_intents_temporary_funding_source` admits exactly two disjoint OPERATIONAL_V1 shapes. Each must carry its policy version, mapping version and `operational_version`. Neither may carry any expense, capital or legacy lineage. Every other intent must carry no funding lineage.
- **Unchanged checks.** The 0036 checks (`posting_intents_capital_source_required`, `posting_intents_operational_expense_source` and the legacy checks) are not altered. `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` is not reused.

## 4. Schema

**New tables** (all entity-qualified FKs; no deletes; guarded transitions):

| Table | Purpose |
|---|---|
| `temporary_funding_account_mapping_versions` | domain-specific, legal-entity scoped, append-only, sequentially versioned payable mapping |
| `temporary_funding_provider_identity_versions` | per-provider, append-only, versioned identity profile: `ABOS_USER` + exact user, or `NO_ABOS_USER`; evidence-backed; Super Administrator only |
| `temporary_fundings` | typed funding source |
| `temporary_funding_decisions` | one decision per funding |
| `temporary_funding_settlements` | typed settlement source; records the funding version it was requested against |
| `temporary_funding_settlement_decisions` | one decision per settlement |

- **Mapping version columns:** the evidence reference, the evidence document reference, the change reason, the actor, a timestamp, correlation and idempotency metadata.
- **Mapping version controls:** UPDATE and DELETE are refused. Inserting a version freezes the ledger account through `ledger_account_references`.
- **Funding source:** mode, provider kind, provider party, the **bound provider identity version** and the user it named (copied by the database, never supplied), the Mode A expense fields or the Mode B Safe, amounts, the bound policy and mapping versions, idempotency, status and version.
- **Same-currency rule:** CHECK(original = base), plus a currency-qualified FK to the Treasury account.

**Shared objects extended (narrow and typed):**
- `posting_intents`:
  - intent kinds `TEMPORARY_FUNDING` and `TEMPORARY_FUNDING_SETTLEMENT`;
  - columns `temporary_funding_id`, `temporary_funding_settlement_id`, `temporary_funding_mapping_version_id`;
  - the source CHECK, plus one-intent-per-funding and one-intent-per-settlement unique indexes.
  - It **reuses** the 0036 columns `finance_workflow_policy_version_id` and `operational_version`.
- `subledger_entries`:
  - type `TEMPORARY_FUNDING_PAYABLE`;
  - columns `temporary_funding_id` and `temporary_funding_settlement_id`;
  - the party CHECK, extended so this type requires the provider party;
  - a lineage CHECK: the payable type requires funding lineage, settlement lineage only on payable rows, and no Treasury or capital lineage.
- `ledger_accounts`: control type `TEMPORARY_FUNDING_PAYABLE`. The Chart of Accounts rules (`coa_validate`) accept it on LIABILITY accounts only. No existing account is converted.
- `evidence_references`: kind `TEMPORARY_FUNDING_ACCOUNT_MAPPING`.
- `finance_workflow_types`: `TEMPORARY_FUNDING` ("Temporary funding" / "تمویل موقت", sort 80).
- `journal_reversal_links`: trigger `aa_journal_reversal_links_temporary_funding_inactive` refuses any link that touches a funding or settlement journal.
- `operational_finance_actor`: the 0036 closed allowlist plus the six funding permissions.
- `validate_operational_journal_posting`: the 0036 body **verbatim**, plus a dispatch arm that returns for the two funding source types.
- New trigger `journals_operational_temporary_funding_posting_guard` → `validate_temporary_funding_journal_posting()`. This is the same pattern as 0036's capital validator.

## 5. Payable control and mapping evidence

The mapping requires an account that is:
- `account_type = LIABILITY`, `control_account_type = TEMPORARY_FUNDING_PAYABLE`;
- ACTIVE, posting allowed;
- in the same entity and the approved base currency;
- free of required dimensions.

AP, OTHER and NULL control accounts and the capital account are refused (tested).

`configure_temporary_funding_mapping` records, in one transaction:
- the structured evidence fact (`evidence_references`, kind `TEMPORARY_FUNDING_ACCOUNT_MAPPING`, `document_id` = mapping version id, SHA-256 of the authorization document);
- the new mapping version with the document reference and change reason;
- an audit fact and an outbox fact;
- the idempotency record.

The mapping evidence is created atomically because no generic evidence-recording entry point exists. Capital mapping evidence has the same gap (see decisions). **The referenced file is only fingerprinted (SHA-256) in the browser; it is not uploaded and is not retained in the ABOS document vault by this workflow.** The UI states this next to every evidence field. The same applies to provider identity evidence.

## 6. Workflow policy binding

- **Reuse.** P2 reuses `finance_workflow_policy_versions` and `posting_intents.finance_workflow_policy_version_id`. It adds no policy-version table.
- **Binding.** Recording binds the latest `TEMPORARY_FUNDING` policy version to the funding. Requesting a settlement binds it to the settlement. The posting intent carries it.
- **Fail closed.** These all refuse when the bound policy or the current policy does not say `approval_required = true`:
  - recording a funding;
  - requesting a settlement;
  - approving a funding or a settlement;
  - the journal validator.
- **Tested:** a newer policy with approval off blocks both recording and approval until approval is required again.

## 7. Segregation of duties and actor identity

- **Actor identity.** Actor and legal entity come only from `identity_actor_context`, which requires a live `PASSWORD_OPERATIONAL` session. `temporary_funding_actor` re-checks the provenance explicitly. Synthetic-developer, forged-token and forged-proof calls fail closed (tested).
- **Funding decision.** The decider is never the recorder and never the provider's user. This is enforced by the entry point, by a BEFORE INSERT trigger on decisions, and by the journal validator (the poster must be the APPROVED decider).
- **Settlement decision.** The decider is never the settlement preparer and never the provider's user. It is enforced in the same three places.
- **Provider identity is database-authoritative.** No Business Party ↔ User relationship exists elsewhere in ABOS, so 0037 adds the smallest safe one: `temporary_funding_provider_identity_versions`.
  - Each version binds legal entity + Business Party + identity mode (`ABOS_USER` with exactly one user, or `NO_ABOS_USER`). It is append-only, versioned against an expected version, idempotent, audited, and backed by evidence (document reference + SHA-256) and a reason. Nothing is inferred or backfilled.
  - **Authority:** only a Super Administrator — the existing `admin.users.manage` **and** `admin.roles.manage` pair, checked in PostgreSQL from the password session. No Finance permission can set it; the funding recorder cannot supply or override it.
  - An `ABOS_USER` must be ACTIVE with a live grant in the same legal entity, and may be the current identity of at most one provider (otherwise ambiguous and refused).
  - `record_temporary_funding` no longer accepts any user field (`providerUserAccountId` is an unsupported field). It resolves the provider's **current** profile; a missing, invalid or ambiguous profile fails closed. The funding stores the exact profile version and its user; a guard refuses any insert that binds a stale, foreign or mismatched profile.
  - The bound user is refused by the funding decision and the settlement decision (entry point, decision triggers and journal validator). A later profile change never alters an earlier funding's bound identity.

## 8. Idempotency and concurrency

- **Replay and conflicts.** Each entry point uses `idempotency_records` with scope `temporary-funding:<operation>:<entity>:<actor>`. The fingerprint is the canonical JSONB payload without `correlationId`, plus the target id and the actor. Same key and same payload replays the stored response (`replayed: true`) without new audit or outbox facts. Same key with a different payload is refused.
- **Single posting.** A funding and a settlement each post once:
  - status guards and a single decision row;
  - one-intent-per-source unique indexes;
  - the existing unique `(entity, source_type, source_id)` and journal-per-intent keys;
  - the intent idempotency keys `TFP:<funding id>` and `TFS:<settlement id>`.
- **Locking and staleness.** Decisions and settlement requests take a per-funding advisory lock and `FOR UPDATE`, in the order funding then settlement. A stale `expectedVersion` or `expectedFundingVersion` is refused.
- **Settlement limits.** Pending plus posted settlements may never exceed the funded amount (checked under the lock). Posting re-checks posted plus this one against the funded amount, and the validator re-checks posted ≤ funded.
- **Tested:** concurrent approvals post once; concurrent settlement requests and duplicate settlement decisions cannot over-settle.

## 9. Permissions (catalogue version 10, FINANCE, sort 600–650)

| Code | Independence |
|---|---|
| `finance.temporary-funding.read` | no |
| `finance.temporary-funding.record` | no |
| `finance.temporary-funding.approve` | **yes** |
| `finance.temporary-funding.settle` | no |
| `finance.temporary-funding.settle-approve` | **yes** |
| `finance.temporary-funding.configure` | no |

- No reversal permission exists.
- 0036 uses version 9 and sort 530–590, so there is no collision.
- The TS `INDEPENDENCE_PERMISSIONS` mirror and `FinancePermission` are updated.

## 10. Security

**Entry points.** Seven SECURITY DEFINER entry points, owned by `abos_v1_operational_finance_owner`:
- `temporary_funding_workspace`
- `configure_temporary_funding_mapping`
- `configure_temporary_funding_provider_identity` (Super Administrator only)
- `record_temporary_funding`
- `decide_temporary_funding`
- `request_temporary_funding_settlement`
- `decide_temporary_funding_settlement`

Each uses `SET search_path = pg_catalog, pg_temp` and fully-qualified objects. PUBLIC EXECUTE is revoked and EXECUTE is granted to `abos_e1_runtime` only.

**Helpers.** All helpers are invoker-rights and executable only by the owner. The posting helpers refuse any other `current_user`.

**Runtime limits.** Runtimes have no table privileges and no SET ROLE. No new role is created. The owner gets column-level INSERT/UPDATE only. The definer inventory test moves from 90 to 97.

## 11. Audit and outbox

Each action writes one audit row and one outbox event (`finance.<action>`):

| Action | When |
|---|---|
| `TEMPORARY_FUNDING_RECORDED` | a funding is recorded and submitted |
| `TEMPORARY_FUNDING_APPROVED` / `_REJECTED` | the funding decision |
| `TEMPORARY_FUNDING_POSTED` | the funding journal posts |
| `TEMPORARY_FUNDING_SETTLEMENT_REQUESTED` | a settlement is requested |
| `TEMPORARY_FUNDING_SETTLEMENT_APPROVED` / `_REJECTED` | the settlement decision |
| `TEMPORARY_FUNDING_SETTLEMENT_POSTED` | the settlement journal posts |
| `TEMPORARY_FUNDING_MAPPING_CONFIGURED` | a payable mapping version is configured |
| `TEMPORARY_FUNDING_PROVIDER_IDENTITY_CONFIGURED` | a provider identity version is configured |

A replay writes none.

## 12. Reversal and Safe guard

- **Reversal is fail-closed:**
  - no reversal entry point, permission or table;
  - any `journal_reversal_links` row touching a funding or settlement journal is refused;
  - the workspace reports `reversalAvailable: false`.
- **The Safe non-negative guard is dormant.** 0037 adds no cash-control table or guard, and `operational_expense_post` is untouched.
  - **Tested:** a Safe-funded expense far beyond recorded Safe cash still posts exactly as before.
  - **Future path:** (1) the explicit Temporary Funding liability, done here; (2) approved opening Safe balances or counts; (3) only then the fail-before-post insufficient-cash guard.

## 13. Application

- **Server side.** `SandboxAuthenticator.temporaryFundingWorkspace` / `temporaryFundingCommand` call the six entry points. `apps/web/src/server/temporary-funding.ts` is the server adapter. The route is `/api/v1/finance/operations/temporary-funding`. There is no in-memory fallback.
- **Page.** `/finance/temporary-funding` is bilingual English/Dari with RTL. It shows:
  - Physical Safe movements and the Temporary Funding Payable in separate panels; the payable is labelled as a liability, not capital;
  - the provider, mode, amount, outstanding payable and status (owed / partly repaid / repaid) for each funding;
  - each funding's repayment history.
- **Mode wording.** Mode A says "Safe unchanged"; Mode B says "Safe funded".
- **Actions.** Only enabled actions appear: record, approve/reject, request repayment, approve/reject repayment, configure the mapping. Reversal is not shown.
- **Other screens.** The Chart of Accounts offers the "Temporary funding payable" control type. Workflow approvals lists "Temporary funding" from the database.

## 14. Remaining owner / accounting decisions

1. **Reversal policy.** Funding reversal stays unavailable until an owner/accounting policy activates it.
2. **Opening Safe balances.** An approved opening-balance policy and workflow is needed before any non-negative guard.
3. **Evidence recording.** There is no generic evidence entry point. P2 records mapping evidence atomically from a document reference and SHA-256. Capital mapping (0036) expects a pre-existing evidence row and has no way to create one.
4. **Provider identity.** 0037's provider identity profile is domain-specific. If ABOS later gains a general Business Party ↔ User relationship, the profile should be derived from it. A Super Administrator who wrongly records `NO_ABOS_USER` for a person who does use ABOS defeats the rule; the evidence, reason and audit trail make that accountable but cannot prevent it.
5. **Provider registration.** Employees and organizations must already exist as Business Parties.
6. **FX.** Cross-currency funding needs an exchange and revaluation policy.
7. **Reporting.** The daily financial report does not yet label temporary funding movements separately.
