# V1 Shareholder → Finance bridge: isolated application design

Status: REVIEW REQUIRED. This is an isolated application/domain implementation and schema proposal, not authorization to enable operational capital receipt or posting.

Accepted source: `8caeae419735f61d41afd9f307b8c9d9f95307b0`. The owner's 2026-10-13 assignment overrides stale repository statements that Codex is paused. Claude's Security Rotation S1, the operational checkout, `runtime-0035`, `runtime-0032`, secrets and the preserved database are outside this task.

## 1. Boundary and evidence

Discovery used committed source files. No connection to the preserved database is required or made. The owner supplied the business baseline: two shareholders, three contributions, one cancelled USD 5,000 installment, one agreement document, and zero journals, journal lines, posting intents or subledger entries. These facts are preservation requirements, not a newly verified database inventory.

The application implementation has an in-memory repository for isolated tests and a review-only UI. There is no PostgreSQL bridge adapter, no live bridge mutation endpoint, and no migration file or registry addition. Browser review must use the isolated worktree and a separate port; it must not restart or repin the operational service. The in-memory tests can exercise record, approve, post and compensating reversal semantics only with explicit authorized fixture policy. They cannot establish PostgreSQL privilege, durability or locking guarantees.

No operational capital authority is inferred from a declaration, an uploaded agreement, a hash, a Finance role, ordinary expense approval being OFF, or removal of the synthetic authorization.

## 2. Architecture discovered and reuse

| Concern | Existing path / primitive | Reuse and restriction |
|---|---|---|
| Shareholder identity | `0031_v1_shareholder_setup.sql`: `shareholder_profiles` → `business_parties`; `packages/contracts/src/shareholder-setup.ts`; `apps/web/src/server/shareholder-setup.ts` | Preserve Type A user, Type B shareholder party and Type C ledger separation. Resolve the party from the contribution's shareholder profile on the server. |
| Contribution | `0035_v1_shareholder_contributions.sql`: `shareholder_contributions`, `shareholder_contribution_*`, lifecycle guard; `packages/contracts/src/shareholder-contributions.ts` | A CASH declaration is a business source only. Preserve its immutable identity and version. IN_KIND and CREDIT are excluded from this cash bridge. |
| Legacy agreement/installment | `capital_agreements`, `capital_installments`, `capital_agreement_commitment_usage`; `0031` setup functions | Display separately. No automatic copying, allocation, recognition or update by the new bridge. |
| Treasury custody | `cash_receipts`, `physical_cash_counts`, `treasury_finance_handoffs`; migrations `0006`, `0008`, `0032`; `packages/treasury` | Reuse receipt verification concepts and trace fields. Existing E1 mutation entry points remain synthetic-only. Do not route operational receipts through them. |
| Operational destination | `0027_v1_operational_finance_configuration.sql`: `operational_treasury_accounts`, active currency and ledger mapping | Reuse SAFE/CASH_BOX/BANK/SARAF configuration and exact entity/currency validation; no new Safe or opening balance is created by a receipt. |
| Posting intent | `posting_intents`; `packages/finance/src/posting-service.ts`; `packages/persistence/src/secure-capital-posting.ts` | Reuse one source → one intent → one journal lineage and idempotency rules. The E1 service requires a synthetic gate and is not an operational adapter. |
| Operational GL | `0028_v1_operational_expense_posting.sql`: `processing_model`, `validate_operational_journal_posting`, expense source/policy/FX validation | Reuse the existing General Ledger tables and guarded transaction pattern. Its validator currently accepts EXPENSE only; capital cannot be silently inserted through it. |
| Journal/lines | `journals`, `journal_lines`; `packages/contracts/src/finance.ts`; `packages/finance/src/journal.ts` | Reuse draft assembly, exact balanced debit/credit validation, same-entity accounts and posted immutability. Do not create a second GL. |
| Subledger | `subledger_entries`: `OPERATIONAL_TREASURY`, `SHAREHOLDER_CAPITAL` | Link Treasury and shareholder effects to the same journal's exact lines. Partition original balances by currency. A declaration has no subledger effect. |
| Reversal | `journal_reversal_requests`, `journal_reversal_links`; `0023_v1_reversal_requests.sql`; `apps/web/src/server/reversals.ts` | Reuse permanent request/decision history and compensating-link invariants. Actual production reversal posting remains unavailable until its policy is approved. |
| Authorization | `0032_v1_operational_gate_separation.sql`: `operational_bearer_context`, database session provenance, live user/grants | Fresh `PASSWORD_OPERATIONAL` session, live RBAC and legal-entity scope. Never accept actor, role or policy claims directly from a browser. Legacy synthetic authorization remains separate. |
| Decimal money | `packages/contracts/src/money.ts`, `packages/finance/src/decimal.ts`: `ExactDecimal`; PostgreSQL `numeric` | Decimal strings and exact arithmetic. No JavaScript floating-point money, silent conversion or mixed-currency total. |
| Idempotency | `idempotency_records`, source uniqueness on `posting_intents`, journal uniqueness on intent | Reuse durable request fingerprints and response lineage; proposed receipt-specific constraints close concurrent posting paths. |
| Evidence | `evidence_references`, agreement-specific `capital_agreement_evidence` (`0031`), private immutable document versions (`0033`/`0034`) | Resolve the exact same-entity agreement/receipt link and immutable version. A hash proves byte integrity, not signatures, registration, legal validity or shareholder identity. No document versions change. |
| Audit/events | `audit_records`, `outbox_events`; current setup/expense audit helpers | Append bounded source/actor/correlation/status metadata in the same transaction. Never log bearer tokens or file bytes. Future event consumers must reauthorize scope. No live AI/Telegram action is introduced. |

Acceptance mapping: A1 authorization/SoD, A4 balanced immutable posting and subledger reconciliation, A8 document/workflow/audit, A10 safe migration/release; REQ-FIN-001..007 and REQ-TRC-001..004. Blueprint references: BP-04 Financial Architecture, BP-17 Workflow/Approvals, BP-23 Security, BP-26 Transaction Traceability.

## 3. Separate facts and state

```text
0035 contribution declaration (unchanged business source)
  → zero or many actual receipt records
  → independent receipt/accounting decision
  → one posting intent per accepted receipt
  → one balanced journal and matching subledger effects
  → optional separately approved compensating reversal
```

The displayed journey is Declared → Received → Approved → Posted. Persist separate receipt, decision and posting dimensions:

| Dimension | Proposed states | Meaning |
|---|---|---|
| Declaration | Existing DRAFT / DECLARED / CANCELLED | Source business record. Future receipt/posting status is derived, not written back as an accounting fact. |
| Receipt | RECORDED / CANCELLED | An actual receipt asserted by an authorized recorder, with immutable amount, destination, date and source. |
| Approval | PENDING / APPROVED / REJECTED | Accounting review decision; approval alone has no journal or GL balance. |
| Posting | NOT_POSTED / POSTED / REVERSED | Financial effect and separately linked compensating reversal. |

RECORDED is not the same as verified physical custody. A future custody-verification decision must be resolved server-side when the approved policy requires it; a Finance approval cannot replace Treasury verification. Rejection does not prove money was returned. Cancellation of a receipt does not prove cash was never received. Production release must define how to correct an erroneous receipt or account for actual returned custody; these exceptional states cannot become a silent way to reduce custody or receive the same amount twice.

For the isolated kernel, RECORDED receipts continue to count toward the received allocation even if their accounting decision is rejected or their posting is reversed. Only cancellation of an unapproved erroneous fixture receipt releases allocation; this is not proof that physical funds were returned. A future database adapter must use the approved custody/correction policy. Accounting reversal alone does not reopen the contribution's receiving capacity or reverse physical cash custody. Derived totals retain separate gross receipt, posted and reversed information.

Multiple partial receipts are allowed by the proposed application model. Sum the allocation of active receipts under an exclusive lock on the exact contribution. A receipt must be positive, have an enabled currency equal to both declaration and receiving destination, and fit the remaining declared amount. No automatic currency conversion is allowed to satisfy an over-receipt check. Future legacy agreement installments remain separate and retain their existing partial-payment/commitment rules.

## 4. Accounting treatment and policy gates

| Step | Journal / cash / subledger |
|---|---|
| Declared | No journal, no cash/bank movement, no Treasury or shareholder accounting subledger. Business commitment/declaration only. |
| Received | Store exact original amount/currency, actual receipt date, configured destination, payment/reference if available, optional evidence link, recorder and timestamp. No GL entry during recording. Actual custody and unposted reconciliation are visible separately. |
| Approved | Append the independent decision and policy version. Do not post automatically or consume an approval twice. |
| Posted | Under approved paid-in-equity recognition policy: debit the destination's approved active CASH control (or approved SARAF control only where the destination and accounting policy allow it); credit the approved active SHAREHOLDER_CAPITAL control account. Exactly two lines balance to the authoritative base amount. |
| Reversed | New journal with the original lines' debit/credit exchanged and compensating signed subledger effects, linked to the original. Original intent, journal and lines remain immutable. |

No numeric account codes are shipped or invented. Resolve actual approved ledger IDs for the legal entity, account currency, type/control relationship and required dimensions. No mapping, no posting. A SARAF label alone does not establish custody, receivable/payable treatment or company-confirmation policy.

Paid-in equity treatment is conditional on the approved legal/accounting decision. Funds received before formal registration may require a liability or pending-capital treatment; the repository leaves this unresolved. This task does not select an interim account, create one, waive registration, activate a DRAFT agreement, or assert that an optional document proves eligibility. Non-cash contribution valuation, shareholder loans, offsets, credit classification, fees, exchange gains/losses and P2 Temporary Funding are excluded.

The isolated implementation supports exact same-currency receipt/base posting only. Other supported transaction currencies remain visible but posting is blocked when conversion is required. Future FX reuses immutable `exchange_rate_snapshots` with entity, original/base currency, rate date/effective time, approved source/version and exact decimal rate. The base currency is server-resolved from the legal entity's approved currency policy. No fallback rate, invented rounding, rate selection or exchange policy is introduced.

Posting additionally requires an open accounting period covering the actual accounting effective date, active mapped accounts, valid dimensions, immutable source/receipt/policy/evidence snapshots and current posting authorization. Repeat calls revalidate the actor even when returning an earlier result. A replay after permission or session revocation must fail rather than return privileged data.

## 5. Authorization and audit

| Action | Existing meaning reused in isolated tests | Proposed operational boundary |
|---|---|---|
| Read bridge | Shareholder setup/Finance read scope | Capital-receipt read catalogue entry, database session/scope, permitted source and metadata fields only. |
| Record/cancel erroneous unapproved receipt | `treasury.cash-receipt.record` | Capital-specific operational record entry point; no automatic extension of legacy E1 Treasury EXECUTE. |
| Review/approve/reject | `finance.posting-intent.approve` | Capital-specific accounting approval permission and formal/custody checks; independent of the recorder and other conflicting custody participants. |
| Post | `finance.journal.post` | Capital-specific operational post permission, designated decision/actor rules and approved recognition policy. |
| Request/approve reversal | `finance.reversal.request` / `finance.reversal.approve` | Reuse existing request/decision concepts and exclude original source preparer/approver/poster according to the conservative existing rules. Actual reversal post requires a separately approved policy. |

Permission strings used by isolated fixtures are not an operational grant. Proposed new catalogue codes and role assignment require review (see schema proposal). Do not add legacy money-moving permission codes to the `0032` operational allowlist. Do not accept browser-submitted `ServerActorContext`, account mappings, approval flags, session provenance, policy versions, verifier identity or reversal approver identity as authority. The repository authority port must independently resolve and revalidate those facts. Any eventual PostgreSQL entry point repeats validation at transaction time.

Ordinary Al-Beruniy operational Finance approval OFF applies to its configured expense workflow. It does not authorize self-approval of this new capital/custody workflow. Platform configurability remains; capital-specific maker/checker or OFF behavior requires a distinct immutable policy decision. Until that decision, isolated tests use the conservative independent recorder/checker/poster rules and production capital mutations stay unavailable.

Every successful state change appends one auditable event with source contribution/receipt, actor, timestamp, before/after state, policy/evidence references and correlation ID. Idempotent retries do not create another state change or duplicate audit event. Denials expose safe typed errors and leave no partial business state. Failed-authorization logging must redact credentials and avoid cross-entity details.

## 6. Idempotency, concurrency and atomicity

Receipt identity, not shareholder/currency, is the posting source. Two receipts may exist against one declaration; one receipt has at most one normal posting. Scope an idempotency key by entity/action and retain a canonical fingerprint of immutable input. Same key/same input returns the existing authorized result. Same key/different input rejects.

The in-memory repository serializes exclusive operations and commits receipt/intent/journal/subledger/audit/idempotency together. It demonstrates retry and simultaneous-request semantics only within one process. It provides no cross-process or crash durability guarantee.

The proposed persistent adapter uses one database transaction, stable lock ordering, contribution row/allocation lock before recording, receipt lock before deciding/posting, version comparison, authoritative permission/policy/account/period locks, and database uniqueness. Lock-only access to protected records must use reviewed controlled helpers, not broad UPDATE grants. No successful response precedes durable commit. Failure rolls back source allocation and all financial rows; outbox and audit occur in the same commit. A delayed retry sees the prior source result without producing another journal. Independent idempotency keys cannot bypass source uniqueness.

## 7. Preservation and UI

Zemar's USD 50,000 declarations dated 2026-10-06 and 2026-10-07 remain two separate contribution IDs. Hashmatullah's legacy USD 20,000 commitment and new USD 20,000 contribution remain separate source models. The cancelled USD 5,000 installment is never revived or allocated. No receipt, accounting balance or backfill is inferred from these owner-supplied examples.

The review screen keeps declared, received, outstanding and posted amounts distinct and denominated. It displays each contribution's source reference/date and separate receipt rows with receipt/approval/posting states. No total combines different currencies. The current review-only UI exposes local simulation actions only: every state change stays in component memory, reload clears it, every business API request is refused by its browser tests, and the page states the boundary prominently. A future operational screen must render actions only from server-resolved permissions and prerequisites. Records labelled demonstration/illustrative data cannot be confused with the real shareholder ledger.

English/Dari wording uses ordinary operational terms: Declared capital / سرمایه اظهارشده; Amount received / مبلغ دریافت‌شده; Outstanding / باقی‌مانده; Awaiting review / در انتظار بررسی; Approved / تأییدشده; Posted to accounts / ثبت‌شده در حساب‌ها; Reversed / برگشت‌داده‌شده. Use current language context and RTL layout; currency codes, decimal strings and identifiers retain legible LTR presentation. The operational UI must not ask users to type hashes.

## 8. Review gates and unresolved decisions

1. Finance/accounting owner: approved paid-in-equity mapping, pre-registration funds treatment and required agreement eligibility/registration linkage for a `0035` contribution.
2. Treasury/owner: actual-receipt verification (physical cash count, bank evidence, Saraf acknowledgment), acceptable evidence reuse and who confirms custody.
3. Owner: capital-specific approval route and independence, including whether any direct-post route is allowed. Ordinary expense approval OFF is insufficient.
4. Finance: partial receipt allocation; rejected/cancelled physical funds correction and re-receipt policy; refund versus accounting reversal effects.
5. Finance: reversal effective date/period, evidence, participant exclusions, custody/commitment reopening policy. Existing production reversal posting remains fail-closed.
6. Finance: FX direction, precision/rounding, approved historical source/time and gain/loss treatment before cross-currency capital posting.
7. Security reviewer: proposed role grants/function ownership and direct-execution attack proof; schema review before any migration generation.

Current database barriers are intentional: `0035` prevents later contribution states; `0032` confines E1 capital custody/posting to synthetic provenance; `0028` operational GL validates EXPENSE only. Deployment requires a separately reviewed narrow extension, not removal of those protections.

Tests for this assignment cover isolated domain invariants and UI behavior. No database test harness, database setup/seed/reset, migration, operational login, real receipt or posting is run. The separate schema proposal lists the future disposable PostgreSQL tests required after authorization. Neither document claims production readiness. Stop after isolated implementation/report for review; no merge, deployment, runtime change, migration 0036 or P2 work.

## 9. Isolated validation record

Validation on 2026-10-13 used only this dedicated worktree and local in-memory/browser fixtures:

- ESLint: pass, zero warnings.
- Workspace strict typecheck: 12 packages passed.
- Unit suites: 157 passed, 0 failed, including 62 Finance tests and the bridge authorization/concurrency/reversal attacks.
- Production build: 11 tasks passed; `/finance/capital-bridge-review` was emitted as a static review route.
- Bridge browser acceptance: 5 passed, 0 failed, covering local workflow, action gating, exact totals, error states, English/Dari, RTL, keyboard operation and tablet/phone overflow.
- Full serial browser suite with all database-backed flags disabled: 39 passed, 19 skipped, 0 failed. The 19 skips are the intentionally gated PostgreSQL/owner-demo workflows.
- Smoke suite: 8 passed, 0 failed.

PostgreSQL integration/attack tests are deliberately not reported as passing. They require the separately approved future schema/migration and an explicitly disposable database. No operational environment was contacted for these checks.
