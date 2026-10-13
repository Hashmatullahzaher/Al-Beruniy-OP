# P2 Temporary Funding — schema proposal and isolated implementation

Status: **isolated proposal, not a migration.** Branch `claude/p2-temporary-funding` (from
`8caeae419735f61d41afd9f307b8c9d9f95307b0`). The SQL lives at
`infrastructure/database/proposals/p2_temporary_funding.sql`. It is not registered in
`packages/database/src/migrations.ts`. It is applied only by the isolated test suite after
migrations 0001–0035 in a disposable database. No migration number is assigned; migration 0036 was
not created. Coordination authority: `codex/v1-shareholder-finance-bridge` @ `1758f03`, specifically
`V1_SHAREHOLDER_FINANCE_MIGRATION_READINESS_MANIFEST.md` and `V1_SHAREHOLDER_FINANCE_P2_SCHEMA_HANDOFF.md`.

## 1. Business rule and architecture

A cash shortage is never represented by letting physical Safe cash go negative. When a person or
organization temporarily funds the business, the company records an explicit liability,
**Temporary Funding Payable**, per provider.

- **Ownership.** Temporary Funding is an Operational V1 Finance capability. It is owned by
  `abos_v1_operational_finance_owner`, written only through SECURITY DEFINER entry points, and
  executable only by `abos_e1_runtime`. Identity, legal entity and permissions are resolved in
  PostgreSQL from the live session (`identity_actor_context`).
- **Domain actor.** P2 has its own actor helper, `temporary_funding_actor`, which follows the
  `shareholder_setup_actor` pattern. The hard-coded allowlist in `operational_finance_actor` is unchanged.
- **Data model.** Funding objects are typed and domain-specific. P2 makes only narrow, typed
  extensions to the shared `posting_intents` and `subledger_entries` tables.

## 2. Lifecycle (fitted to ABOS conventions)

| Requested | ABOS state | Notes |
|---|---|---|
| Draft → Submitted | `PENDING_APPROVAL` (created) | There is no separate stored draft. As in the expense lane, the form is the draft. |
| Approved → Posted | `POSTED` | The approver posts in the same transaction as the decision, following the 0028 convention. There is no separate post permission. |
| Partially Settled / Settled | derived `lifecycleStatus` | Computed from posted settlements, never stored, so it cannot drift. |
| Rejected / Cancelled | `REJECTED` / `CANCELLED` | Final. A reason is required. Cancelling is limited to the creator while the funding is pending. |
| Reversed | `REVERSED` | Only through an independent reversal request and decision. |

Settlements have the states `PENDING_APPROVAL → POSTED | REJECTED | CANCELLED`. Reversals have the states `REQUESTED → POSTED | REJECTED`.

## 3. Journals

| Event | Line 1 | Line 2 | Subledgers |
|---|---|---|---|
| Mode A `PROVIDER_PAID_EXPENSE` | Dr expense category ledger (payee party, dimensions) | Cr payable (provider party) | `TEMPORARY_FUNDING_PAYABLE` +amount on line 2. **No Treasury entry: the Safe is unchanged.** |
| Mode B `PROVIDER_FUNDED_SAFE` | Dr Safe / cash-box / petty-cash ledger | Cr payable (provider party) | `OPERATIONAL_TREASURY` +amount on line 1; `TEMPORARY_FUNDING_PAYABLE` +amount on line 2 |
| Settlement | Dr payable (provider party) | Cr Treasury ledger (Safe or bank) | `TEMPORARY_FUNDING_PAYABLE` −amount on line 1; `OPERATIONAL_TREASURY` −amount on line 2 |
| Reversal | exact mirror of the original lines | | negated mirror of every subledger entry, with the same funding lineage |

A settlement debits the payable and **never reposts the expense**. It always uses the funding's own
mapping version, so a later mapping change cannot split one liability across two accounts. In Mode B,
any later expense uses the normal 0028 expense flow.

## 4. Settlement

- Partial settlement is allowed. Over-settlement is refused twice:
  - **On create (reservation rule):** pending plus posted settlements must not exceed the funded amount. This is checked under the funding row lock and a per-funding advisory lock.
  - **On post:** posted settlements plus the new one must not exceed the funded amount. The journal validator checks this again.
- A settlement is decided by someone other than its creator and other than the provider user.
- A reversed or unposted funding cannot be settled. While a reversal is waiting for a decision, no new settlement can be created.

## 5. Safe strategy (staged)

**Stage 1 (now).** `operational_treasury_cash_guard()` is wired into `operational_expense_post`,
into settlements and into Mode B reversals.
- It takes a per-account advisory lock.
- With no approved opening control on the account, it returns at once. Behaviour is unchanged today, because no opening balances are formally approved.

**Stage 2 (data-driven, no code change).** Once a row exists in `operational_treasury_cash_controls`
for an account, the guard is active. That row holds:
- an approved opening amount ≥ 0 and its as-of date;
- `OPENING_RECONCILIATION` evidence;
- a recorder and an approver, who must be different people.

For that account:
- recorded cash = opening + posted `OPERATIONAL_TREASURY` movements after the as-of date;
- any outflow that would make recorded cash negative fails **before posting**;
- movements dated on or before the opening date are refused.

The proven end state: an ordinary Safe-funded expense that exceeds recorded cash is refused and stays unposted. The shortfall is then recorded as Temporary Funding.

**Activation blocker.** No entry point creates cash controls. An owner-approved opening-balance policy is required first.

## 6. Provider and subledger

- **Providers.** A provider is an ACTIVE `business_parties` row in the same legal entity.
- **`provider_kind`** is validated against the party's live roles on the funding date:

  | Kind | Rule |
  |---|---|
  | `SHAREHOLDER` | requires the SHAREHOLDER role |
  | `EMPLOYEE_OFFICER` | requires the EMPLOYEE role |
  | `OTHER_PERSON` / `ORGANIZATION` | must hold neither role |

  A shareholder's funding therefore always shows as a shareholder's. It is still a payable, never capital.
- **Provider user.** `provider_user_account_id` is optional and allowed only for `EMPLOYEE_OFFICER`. When set, that user can never approve or settle-approve the funding.
- **Subledger type.** The new type is `TEMPORARY_FUNDING_PAYABLE`. It requires `business_party_id`; the shared `subledger_entries_check` is extended from the two shareholder types to three. It requires `temporary_funding_id` lineage (new CHECK).
- **Lineage on reversal.** A new trigger on `journal_reversal_links` requires every reversal to preserve that lineage. This follows the 0028 Treasury-identity pattern.
- **Balance.** The provider balance is read from posted payable subledger entries, which are authoritative. The tests check it against the funding and settlement totals.
- **No capital contamination.** Shareholder providers never create `SHAREHOLDER_CAPITAL` or `SHAREHOLDER_LOAN` subledger rows, EQUITY lines, or capital-control lines. The payable mapping rejects any account that is not a LIABILITY or that carries a reserved control type (`NULL` or `OTHER` only).

## 7. Authorization (new FINANCE permissions)

| Code | Independence | Use |
|---|---|---|
| `finance.temporary-funding.read` | no | workspace |
| `finance.temporary-funding.create` | no | record a funding, cancel own pending funding |
| `finance.temporary-funding.approve` | **yes** | approve or reject and post. Never the creator, never the provider user. |
| `finance.temporary-funding.settle` | no | request a repayment, cancel own pending repayment |
| `finance.temporary-funding.settle-approve` | **yes** | approve or reject and post a repayment. Never its requester, never the provider user. |
| `finance.temporary-funding.reverse` | **yes** | request or decide a reversal. The decider is never the requester, the funding creator, the original approver/poster or the provider user. |
| `finance.temporary-funding.configure` | no | append a payable-mapping version |

**Catalogue numbering.** Sort orders are 530–590. The catalogue version is computed as max+1 at apply time; **the coordinator assigns the final number.**

**Policy.** Adds the workflow type `TEMPORARY_FUNDING` ("Temporary funding" / "تمویل موقت", sort 80). A trigger refuses any `TEMPORARY_FUNDING` policy version with `approval_required = false`, so every funding event needs approval. If no policy exists, creation fails closed.

## 8. Idempotency, concurrency and reversal

- **Request idempotency.** `idempotency_records` scopes:
  - `entity:TEMPORARY_FUNDING_CREATE`
  - `…:TEMPORARY_FUNDING_SETTLEMENT_CREATE`
  - `…:TEMPORARY_FUNDING_REVERSAL_REQUEST`

  The fingerprint includes the actor. An identical retry returns the recorded response with `replayed: true`. Reusing a key with different details is refused.
- **Decisions.** Each decision uses `expected_version`, a per-funding advisory lock and `FOR UPDATE`. The same decision by the same actor replays.
- **Lock order** is always funding, then settlement or reversal.
- **No double posting** is enforced by the database:

  | Mechanism | Scope |
  |---|---|
  | partial unique indexes on `posting_intents` | per funding, per settlement, per reversal |
  | existing unique keys | `(legal_entity_id, idempotency_key)` and `(legal_entity_id, source_type, source_id)` on intents |
  | `journals.posting_intent_id` unique | one journal per intent |
  | one decision row per funding and per settlement | decisions |
  | partial unique index | one open or posted reversal per funding |

- **Intent idempotency-key prefixes:** `TFP:`, `TFS:`, `TFR:`.
- **Reversal.** A posted `REVERSAL` intent is created with:
  - `source_type = 'TEMPORARY_FUNDING_REVERSAL'`, `source_id` = the original journal;
  - `REVERSAL_REASON` evidence (`document_id` = reversal id, sha256 of the reason);
  - an exact mirror journal, and a `journal_reversal_links` row in the same transaction.

  The legacy link validators, the 0028 Treasury-identity validator and the new lineage validator all apply. A funding with pending or posted settlements cannot be reversed.

## 9. UI (`/finance/temporary-funding`, English and Dari)

- **Two panels kept apart.**
  - **Physical Safe (cash on hand):** per account, recorded movements, inflow from temporary funding, repayments, and whether negative cash is enforced. The enforced flag reads "Not yet enforced — no approved opening balance" until stage 2.
  - **Temporary Funding Payable:** owed to providers. Shows the total plus a per-provider table of funded, repaid, outstanding and status. It is labelled "a liability, not shareholder capital".
- **Recording form:** the mode ("Paid an expense directly" or "Put cash into the Safe"), the provider type, and a provider filtered by role.
- **Funding cards** carry the role-aware actions: approve/reject, cancel, request repayment, approve repayment, request/decide reversal.
- **Errors** appear as business-language messages in both languages.
- **Navigation:** the "Daily work" entry appears for any of the seven permissions. Permission copy is added for the role editor.

## 10. Schema summary

**New tables (all entity-qualified FKs; no deletes; guarded transitions):**

| Table | Purpose |
|---|---|
| `temporary_funding_account_mapping_versions` | append-only payable ledger mapping per entity; sequential `version`; ledger-reference freeze trigger |
| `temporary_fundings` | typed source: mode, provider kind/party/user, Mode A expense fields or Mode B Safe account, amounts (same-currency CHECK), policy version, mapping version, correlation, idempotency key + fingerprint, status, version, journal |
| `temporary_funding_decisions` | one APPROVED/REJECTED decision per funding; independence trigger |
| `temporary_funding_settlements` | typed settlement source: Treasury account, amount, date, policy version, idempotency, status, version, journal |
| `temporary_funding_settlement_decisions` | one decision per settlement; independence trigger |
| `temporary_funding_reversals` | requested/decided reversal with original + reversal journal and evidence; one open/posted per funding |
| `operational_treasury_cash_controls` | stage-2 approved opening position per Treasury account; insert-only; recorder ≠ approver |

**Shared-table extensions:**
- `posting_intents`:
  - kinds `TEMPORARY_FUNDING` and `TEMPORARY_FUNDING_SETTLEMENT`;
  - columns `temporary_funding_id`, `temporary_funding_settlement_id`, `temporary_funding_reversal_id`, `temporary_funding_mapping_version_id`;
  - the **shared** `finance_workflow_policy_version_id` (created with `ADD COLUMN IF NOT EXISTS` and a named FK guarded by existence);
  - three model-aware source CHECKs and three partial unique indexes.
- `subledger_entries`: type `TEMPORARY_FUNDING_PAYABLE`, column `temporary_funding_id`, the party CHECK extended, the lineage CHECK, and an index.
- `journal_reversal_links`: the lineage guard trigger.
- `finance_workflow_types`: the type CHECK extended, plus a row.
- `finance_workflow_policy_versions`: an approval-required trigger for `TEMPORARY_FUNDING` only.

**Function changes:**
- **`validate_operational_journal_posting`** is replaced with the 0028 body **verbatim**, plus a dispatch preamble. Funding, settlement and funding-reversal journals go to `validate_temporary_funding_journal`. Every other Operational V1 journal runs the unchanged expense body.
- **`operational_expense_post`** is replaced verbatim, plus one call to the stage-1 cash guard.

## 11. Shareholder-Finance collision resolution

| Coordination point | Resolution |
|---|---|
| `posting_intents.finance_workflow_policy_version_id` | Reused **by name and meaning**. Created with `ADD COLUMN IF NOT EXISTS` and an entity-qualified FK guarded by a `pg_constraint` existence check, so either lane can land first. No second equivalent column. |
| Operational V1 source dispatch | Typed FK columns with their own model-aware CHECKs (`kind ⇔ FK`, `FK = source_id`, fixed `source_type`). `posting_intents_operational_expense_source`, `posting_intents_capital_source_required` and the legacy branches are untouched. The validator gains a dispatcher only; Codex's capital-receipt branch can add its own dispatch arm the same way. **Merge note:** both lanes replace `posting_intents_intent_kind_check` and `validate_operational_journal_posting`, so whichever lands second must union the kind lists and the dispatch arms. |
| Custody/funding verification | No generic custody table. Funding verification is the typed approval decision (maker ≠ checker ≠ provider) plus a posted journal. Physical custody of Safe cash is the stage-2 cash control (`OPENING_RECONCILIATION` evidence), not a receipt-custody record. |
| Mapping versions | Domain-specific `temporary_funding_account_mapping_versions`, append-only and sequential, with ledger freeze on reference. **Difference from Codex:** no evidence is required on a mapping version (decision below). |
| Idempotency / journal uniqueness | Domain prefixes `TFP:`/`TFS:`/`TFR:` on intent keys. Partial unique index per typed source. The existing unique keys remain the last line of defence. |
| Provider subledger lineage | A party-bearing subledger type with an exact `temporary_funding_id` lineage CHECK, preserved through reversals by trigger. Capital and loan subledger types are not reused. |
| Reserved names | None used: no `shareholder_capital_*` tables, no `shareholder_capital_receipt_id`, no `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` discriminator, no capital permission codes. A test asserts that the reserved table and column names are absent. |
| Intent kinds | P2 adds two kinds of its own. Codex adds none for capital, so there is no kind collision. |

## 12. Validation (disposable local PostgreSQL 17 container only)

- **New isolated suite:** `packages/e1-integration/src/temporary-funding-proposal.test.ts`, **14/14 pass**. It covers:
  - the proposal applying after 0035, and the reserved names being absent;
  - stage-1 expense behaviour unchanged;
  - Mode A (Safe unchanged) and Mode B (Safe +);
  - partial and full settlement, over-settlement refused, expense not reposted;
  - replayed retries, conflicting key reuse, and an impossible duplicate intent;
  - concurrent approvals (one post) and concurrent settlements (no over-settlement);
  - reversal (exact mirror, link, evidence, segregation of duties);
  - authorization (maker-checker, provider independence, missing authority, runtime cannot read tables or call internals, immutability);
  - cancel and reject;
  - cross-company isolation;
  - no shareholder-capital contamination and provider-kind role rules;
  - the stage-2 guard (expense refused before posting, settlement refused, recorded cash exact);
  - forged typed-source intents and duplicate journals refused inside the owner boundary.
- **Full `@abos/e1-integration` suite:** 199/199 pass.
- **Unit tests:** all pass. **Typecheck:** 12/12 pass. **ESLint:** 0 warnings. **`next build`:** succeeds.
- **UI check** on a second disposable preview database, using the in-app browser and synthetic accounts only:
  - submit as preparer, then approve as approver: payable 250.00, Safe unchanged;
  - over-repayment refused in business language;
  - a 100.00 repayment approved: "Partly repaid", payable 150.00;
  - full Dari rendering.

## 13. Decisions needed and blockers

1. **Reversal posting policy.** 0023 left Finance reversal posting "awaiting policy". This proposal implements a funding-specific, evidence-backed reversal for **unsettled** fundings only. The owner or Finance Manager must accept it, or it can be dropped before promotion.
2. **Opening-balance policy.** Stage 2 activation needs an approved opening amount and evidence per Treasury account, and an entry point to record and approve them. It is not built.
3. **FX.** The first activation is base-currency only, matching Codex's same-currency first activation. Foreign-currency funding needs a snapshot and revaluation policy.
4. **Provider roles.** There is no `FUNDING_PROVIDER` role. Other persons and organizations are any ACTIVE party without a shareholder or employee role. Employees and officers need an EMPLOYEE role, and no party-creation entry point exists for them yet.
5. **Payable control type.** The payable is accepted with control type `NULL` or `OTHER`. A dedicated control type may be wanted.
6. **Catalogue version.** To be assigned by the coordinator. The TS `INDEPENDENCE_PERMISSIONS` mirror, `security-ownership.test.ts` (definer count), `workflow-policy.test.ts` (7 types) and `identity-admin.test.ts` must be updated **at promotion**. They are untouched here so the baseline stays green.
7. **Mapping evidence.** P2 records a reason, not evidence, on mapping versions. This differs from the capital mapping and is an open decision.
8. **Reports.** The daily financial report and Treasury views do not yet label Temporary Funding Treasury movements separately.
9. **Merge order with the Shareholder-Finance bridge.** See section 11: the intent-kind CHECK and the validator dispatcher must be unioned by whichever lane lands second.

## 14. Isolation statement

This work used only:
- the P2 worktree;
- the disposable container `abos-p2-tempfunding-pg`, with databases `abos_p2_tempfunding_test` and `abos_p2_tf_preview`;
- private configuration under `AppData\Local\AlBeruniyOS\config\p2-tempfunding`.

It did not touch:
- the live database, runtime-0035 or runtime-0032;
- security configuration, or the Codex branch;
- deployment;
- migration 0036, which was not created.
