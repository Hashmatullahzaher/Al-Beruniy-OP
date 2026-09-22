# Stage 1 E1 — Independent Finance Review (Claude → Codex)

**Reviewer:** Claude (shareholder domain owner / independent reviewer, per
`STAGE_01_E1_SANDBOX_OWNER_AUTHORIZATION.md` §Workstream allocation 2).
**Reviewed tree:** `0ba52a940e088a377faa183be8a337e028cf304e` (E1 coordination baseline).
**Shared contract:** `8fb471475a76587b36414dfa3ab3f8dfc0cb0124`, `stage1-e0-v1`.
**Codex E1 branch at review time:** `agent/codex/stage-1-e1-integrated-sandbox` — no change to
`packages/**` or `infrastructure/**` versus the baseline, so this review is current for E1.

**What was actually examined.** `packages/finance/src/{posting-service,journal,decimal,repository,memory-repository,reconciliation,errors}.ts`,
`packages/contracts/src/{finance,shareholder-capital,treasury,money,ids,evidence,dimensions,security,api}.ts`,
`packages/database/src/migrations.ts` and all 1 423 lines of
`infrastructure/database/migrations/0001_e0_finance_foundation.sql`.
Tests executed locally: `pnpm --filter @abos/finance test` → **23 passed, 0 failed**;
repository smoke suite → 3 passed. No finding below is inferred from documentation alone.

**Verdict:** the kernel is competently built and I accept it as a dependency **subject to F-1 and F-2**,
which are hard blockers for the E1 end-to-end path, and F-3/F-4, which are control weaknesses that
should not survive into any later gate. I have not found a way to post an unbalanced journal, to post
without an independent approver, or to mutate a posted journal.

---

## Acknowledged strengths

These are load-bearing and I relied on them when designing the shareholder domain.

- **Exact decimal arithmetic.** `ExactDecimal` is BigInt coefficient + scale with normalisation
  (`decimal.ts:1-59`). No float anywhere in the money path.
- **Journal balancing.** `validateJournalLines` requires ≥2 lines, exactly one of debit/credit per line,
  positive amounts, matching legal entity and base currency, an ACTIVE + postable account, and
  `debitTotal == creditTotal` (`journal.ts:17-38`). Independently re-enforced in SQL by
  `journals_posting_guard`, which additionally requires the totals to equal the posting intent's base
  amount (`0001_...sql:1110-1116`).
- **Immutability.** `deepFreeze` on the returned journal (`posting-service.ts:365-372`); in SQL,
  append-only `audit_records` and `evidence_references`, `prevent_posted_journal_delete`,
  `guard_posted_financial_provenance` across twelve source tables, and immutable
  `journal_reversal_links` (`0001_...sql:617-628, 712-860, 1382-1421`).
- **Segregation of duties.** Service: approver must equal the acting user, and the actor must not be the
  cashier (`posting-service.ts:242-246`). SQL: `enforce_posting_approval_sod` blocks intent creator,
  cashier and cash counter from approving (`:630-669`), and the posting guard blocks the same three
  from being the poster (`:1104-1108`). `cash_receipts` and `physical_cash_counts` carry
  `verified_by <> received_by` / `confirmed_by <> counted_by` CHECKs.
- **Idempotency.** Keyed `(legalEntityId, operation, idempotencyKey)` with a canonicalised SHA-256
  request hash, replay returns the stored journal, hash divergence raises `IDEMPOTENCY_CONFLICT`, and
  the commit path re-checks after a failed insert to resolve races (`posting-service.ts:88-148`).
  `canonicalize` sorts object keys and Map entries, so the hash is stable.
- **Source uniqueness.** `findJournalBySource` plus `UNIQUE (posting_intent_id)` on `abos.journals` and
  `UNIQUE (legal_entity_id, treasury_cash_receipt_id)` on `abos.posting_intents` give one journal per
  receipt at two layers.
- **Reversal correctness.** SQL requires the reversal to *exactly invert* every original journal line and
  every original subledger entry, requires `REVERSAL_REASON` evidence, and permits one reversal per
  journal (`:1277-1379`).
- **No invented FX.** The same-currency slice explicitly rejects an FX snapshot
  (`posting-service.ts:254`), and both `posting_intents` and `journal_lines` CHECK
  `conversion_snapshot_reference IS NULL`.

---

## Findings

Severity: **HIGH** = blocks E1 or defeats a stated control. **MEDIUM** = real control gap, not
currently exploitable end-to-end. **LOW** = correctness/robustness hygiene.

### F-1 — HIGH — `CapitalAgreementStatus` is unreachable from persisted data

- Contract: `CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED"`
  (`packages/contracts/src/shareholder-capital.ts:11`).
- Database: `CHECK (status IN ('DRAFT','PENDING_EVIDENCE','ELIGIBLE','SUSPENDED','CLOSED'))`
  (`0001_e0_finance_foundation.sql:213`).
- Kernel: `assertFinance(eligibility.agreementStatus === "APPROVED", "CAPITAL_AGREEMENT_REQUIRED", …)`
  (`posting-service.ts:236`).

`APPROVED` cannot be stored, and `PENDING_EVIDENCE` / `ELIGIBLE` cannot be expressed in the contract.
Any adapter reading a real row must either invent a mapping or fail. This blocks the E1 happy path the
moment persistence replaces in-memory fixtures.

**Proposed resolution (needs your decision, Codex — I have not changed either artefact):**
adopt the DB vocabulary in the contract, i.e.
`"DRAFT" | "PENDING_EVIDENCE" | "ELIGIBLE" | "SUSPENDED" | "CLOSED"`, and change the kernel assertion
to `=== "ELIGIBLE"`. `ELIGIBLE` is the more accurate word: the gate is "this agreement may fund an
installment", not "someone approved a document". This is an additive `stage1-e0-v2` contract bump.
I have isolated my dependency on this in one file — `packages/shareholder/src/schema-divergence.ts` —
so the fix is a single edit on my side once you rule.

**Test to add on your side:** a posting attempt whose eligibility carries each non-eligible status,
asserting `CAPITAL_AGREEMENT_REQUIRED`.

### F-2 — HIGH — `CapitalReceiptIntent` has no table and no referential integrity

`CapitalReceiptIntent` is the shareholder domain's sole output and the value
`CapitalPostingIntent.sourceIntentId` points at, yet there is no `abos.capital_receipt_intents` table
(full table list confirmed: 29 tables, none for receipt intents).
`abos.posting_intents.source_id` is a bare `uuid` with `UNIQUE (legal_entity_id, source_type, source_id)`
and **no foreign key** (`0001_...sql:366-401`).

Consequences: the source record cannot be durably stored for E1; its status lifecycle
(`DRAFT → ELIGIBLE → TREASURY_VERIFIED → POSTED`) has no persisted home; `findJournalBySource` enforces
uniqueness over an identifier the database does not own; and nothing prevents a posting intent from
citing a `source_id` that never existed.

**Proposed resolution:** add `abos.capital_receipt_intents` in your migration (you own migrations; I
have not written SQL). Minimum columns for the contract to round-trip: `id`, `legal_entity_id`,
`shareholder_business_party_id`, `capital_agreement_id`, `capital_installment_id`,
`expected_destination_cash_account_id`, `amount numeric CHECK (amount > 0)`, `currency_code`,
`status CHECK (status IN ('DRAFT','ELIGIBLE','REJECTED','TREASURY_VERIFIED','POSTED'))`,
`business_event_at`, `idempotency_key`, `correlation_id`, `version`, project/department/cost-centre
dimension columns, plus `UNIQUE (legal_entity_id, idempotency_key)`,
`UNIQUE (id, legal_entity_id)`, `UNIQUE (id, currency_code)` and composite FKs to
`capital_installments(id, legal_entity_id)` and `(id, currency_code)` mirroring the pattern you already
use on `cash_receipts`. Then add
`FOREIGN KEY (source_id, legal_entity_id) REFERENCES abos.capital_receipt_intents(id, legal_entity_id)`
on `posting_intents` for `source_type = 'SHAREHOLDER_CAPITAL_INSTALLMENT'`.
My `ShareholderRepository` port (`packages/shareholder/src/repository.ts`) is written to exactly this
shape, so your adapter can implement it without touching my domain code.

### F-3 — HIGH — the synthetic-only safeguard is advisory, not authoritative

`assertPolicyAllowsKernel` (`posting-service.ts:258-262`) is the *only* thing standing between the
kernel and a real posting, and it reads a `CapitalPostingIntentPolicy` **supplied by the caller** in
`PostCapitalReceiptCommand.configuration.policy`. There is no policy table, no `environment` column and
no SQL constraint anywhere in the migration (`grep` for `environment|configuration_state|real_posting|
policy_version|finance_policy` returns nothing). A caller that hands the service
`{ environment: "test", configurationState: "SYNTHETIC_TEST_ONLY", realPostingEnabled: false }` while
connected to a non-synthetic database will post, and the database will accept it.

The E1 authorization requires that "any simulation of `CLIENT_FINANCE_APPROVED` must be a test-only
fixture that is technically barred from live configuration". Today nothing is technically barred.

**Proposed resolution:** persist the gate. A single-row-per-entity `abos.finance_policy`
(`legal_entity_id`, `environment`, `configuration_state`, `policy_version_id`, `base_currency_code`,
`real_posting_enabled boolean`) written only by migration/seed, read by the service instead of the
command parameter, plus a posting-guard clause that raises unless
`configuration_state = 'SYNTHETIC_TEST_ONLY' AND real_posting_enabled = false` for the E1 gate.
Belt and braces: a deployment-time CHECK that rejects `real_posting_enabled = true` while the migration
catalog is at `stage1-e0-*`.

### F-4 — HIGH — over-contribution is not durably prevented

The only guard is `intent.originalAmount <= eligibility.eligibleAmount`
(`posting-service.ts:238-239`), and `eligibility` is caller-supplied. In SQL:
`capital_agreements.committed_amount > 0` is the sole related CHECK (`:209`); there is no constraint
that Σ posted installments ≤ committed amount, and `capital_installments.expected_amount > 0` is not
aggregated against the parent agreement either. `CapitalAgreementSummary.contributedAmount` exists in
the contract but has no column.

A defective or hostile caller can therefore post installments totalling more than the commitment, and
nothing in the ledger or the schema objects.

**Proposed resolution:** materialise `contributed_amount` on `capital_agreements`, maintained by a
trigger on posted capital journals, with `CHECK (contributed_amount <= committed_amount)`; and compute
eligibility server-side from persisted rows rather than accepting it as a parameter. I compute
eligibility from repository state on my side (`packages/shareholder/src/eligibility.ts`) and never trust
a caller-supplied figure — but Finance should not trust mine either once persistence lands.

Related: `CapitalAgreementSummary.partialInstallmentsAllowed` has **no DB column** and is **never read
by the kernel**, so a partial payment against an agreement that forbids partials cannot fail closed in
Finance. I enforce it source-side; `CapitalInstallmentEligibility` should carry it so you can too.

### F-5 — MEDIUM — reversal has no separation from the original poster

`reverseJournal` asserts the `finance.journal.reverse` permission, entity scope, reason and evidence
(`posting-service.ts:160-175`) but never compares the actor to
`original.postedByUserAccountId`. The SQL posting guard blocks the reverser from being the intent
creator, cashier or counter, but not from being the person who posted the entry being reversed. The
same user can therefore post and then unilaterally reverse.

**Proposed resolution:** add
`assertFinance(actor.userAccountId !== original.postedByUserAccountId, "SEGREGATION_OF_DUTIES_VIOLATION", …)`
and mirror it in `journals_posting_guard` for `intent_kind = 'REVERSAL'`.

### F-6 — MEDIUM — the reversal's accounting date is unconstrained

`assertPeriodOpen(command.accountingPeriod, original.legalEntityId, command.accountingPeriod.startsOn)`
(`posting-service.ts:172`) passes the period's own start date as the effective date, so the
date-in-range test is vacuous. `ReverseJournalCommand` has no `accountingEffectiveDate` field at all,
and the caller chooses which open period to reverse into.

**Proposed resolution:** add `accountingEffectiveDate` to `ReverseJournalCommand` and validate it the
way `postCapitalReceipt` does; consider requiring the reversal period to be the original period or a
later open one, never an earlier one.

### F-7 — MEDIUM — the cash count behind a verified receipt is never checked in the kernel

`VerifiedTreasuryReceipt.physicalCashCountId` is carried through the contract but
`assertPostable` checks only `status === "VERIFIED"`, the linkage ids, the cashier identity, the
destination and the amount (`posting-service.ts:248-252`). Nothing asserts that the count exists, is
`CONFIRMED`, belongs to the same cash account and currency, or that its counted amount reconciles.
The SQL triggers cover this for the persisted path; the service and `InMemoryFinancePostingRepository`
accept any uuid, which is exactly the path E1 integration tests run on.

**Proposed resolution:** pass the `PhysicalCashCount` record into `PostCapitalReceiptCommand` (or look
it up through the repository) and assert status/account/currency/amount before posting.

### F-8 — MEDIUM — actor scope ignores cost centre

`assertActorScope` validates legal entity, department and project (`posting-service.ts:272-284`) but
never `dimensions.costCenterId`, although `ledger_accounts.requires_cost_center` exists and
`PROJECT_LEVEL` dimensions make `costCenterId` mandatory. `ServerActorContext` has no `costCenterIds`
field, so the check cannot currently be written — this is a contract gap as much as a code gap.

**Proposed resolution:** add `costCenterIds` to `ServerActorContext` and assert it alongside the others.

### F-9 — LOW — `findJournalBySource` discards the branded id types

`findJournalBySource(sourceType: string, sourceId: string)` (`repository.ts:30`) takes plain strings
while every other signature in the contract uses `OpaqueId`. Callers can transpose the two arguments
without a type error.

**Proposed resolution:** `sourceType: PostedJournal["sourceType"]`, `sourceId: CapitalReceiptIntentId | JournalId`.

### F-10 — LOW — ledger-account configuration is outside the idempotency fingerprint

`capitalReceiptFingerprint` (`posting-service.ts:300-315`) includes the two configured ledger account
ids but not `configuration.ledgerAccounts` itself. If an account's `postable`/`status` changed between
a first failed attempt and a retry with the same key, the retry would return the stored journal rather
than revalidating. Negligible under E1's fixed synthetic configuration; worth closing before any gate
where configuration can change at runtime.

### F-11 — LOW — `ReconciliationResult` counts are hard-coded

`reconcileCapitalReceipt` always reports `sourceCount: 1, journalCount: 1` (`reconciliation.ts:20-21`).
Correct for the single-receipt slice and the `scope` field says so, but the type invites a portfolio
reading. Suggest renaming to `reconcileSingleCapitalReceipt` or accepting arrays.

---

## Items I explicitly checked and found sound

- Cashier cannot self-approve: covered in service and SQL (two independent layers).
- Duplicate post of the same receipt intent: covered by `findJournalBySource`, `UNIQUE (posting_intent_id)` and `UNIQUE (legal_entity_id, treasury_cash_receipt_id)`.
- Idempotency-key reuse with a different payload: raises `IDEMPOTENCY_CONFLICT`, including on the race path.
- Closed period, wrong entity, missing permission, AFN, `OWNER_PROVISIONAL`, staging and production: all fail closed, with tests.
- Posted journal mutation/deletion: blocked in SQL; the returned object is deep-frozen in JS.
- Reversal without evidence, repeated reversal, non-inverting reversal: blocked.
- Draft records changing a posted balance: not possible — balances derive from posted journal lines only.

## Requested response from Codex

1. A ruling on **F-1** (status vocabulary) so I can finalise `schema-divergence.ts`.
2. Ownership confirmation and a target migration for **F-2** (`capital_receipt_intents` + FK).
3. Accept/defer with rationale on **F-3** and **F-4**; both are stated controls in the E1 authorization,
   so a deferral needs an owner-visible note rather than a silent one.
4. F-5 through F-8 accepted into your branch, or bounced back with reasons.
5. Confirmation that `CapitalInstallmentEligibility` may additively carry `partialInstallmentsAllowed`
   and `remainingEligibleAmount` in `stage1-e0-v2`.

I have changed **no** shared file: no contract, no migration, no Finance source. Everything above is a
request, not an edit.
