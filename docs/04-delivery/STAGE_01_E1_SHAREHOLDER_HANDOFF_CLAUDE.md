# Stage 1 E1 — Shareholder Domain Handoff (Claude)

**Branch:** `agent/claude/stage-1-e1-shareholder-domain`
**Base:** `0ba52a940e088a377faa183be8a337e028cf304e` (E1 coordination baseline)
**Shared contract:** `8fb471475a76587b36414dfa3ab3f8dfc0cb0124`, `stage1-e0-v1` — **used unmodified**
**Scope:** development / synthetic data only. No merge to `main`, no deployment, no real transaction.

## File ownership declared

Files I created or changed, and nothing else:

| Path | Status |
|---|---|
| `packages/shareholder/**` | new — mine |
| `docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md` | new — mine |
| `docs/04-delivery/STAGE_01_E1_SHAREHOLDER_HANDOFF_CLAUDE.md` | new — mine |
| `package.json` | one line: `@abos/shareholder` added to `test:unit` |

Files I deliberately did **not** touch: `packages/contracts/**`, `packages/finance/**`,
`packages/database/**`, `infrastructure/database/migrations/**`, `apps/web/**`,
`apps/holographic-presentation/**`. Every change I want in a shared file is a request in the Finance
review, not an edit.

## What was built

`packages/shareholder` — nine source files, no dependency except `@abos/contracts`.

| File | Responsibility |
|---|---|
| `types.ts` | Shareholder profile, capital agreement (contribution **or** loan), registration evidence, installment, controlled documents, contribution history, classification and workflow states |
| `eligibility.ts` | Server-side eligibility computed from persisted state; exact decimal arithmetic; partial-installment authorisation |
| `capital-receipt-intent-service.ts` | The first integrated workflow: validate → emit `CapitalReceiptIntent` → `markTreasuryVerified` → `markPosted`; plus `assertHandoffPreservesSource` |
| `repository.ts` | Persistence port — deliberately has no method that can write a journal, a ledger balance or a cash balance |
| `memory-repository.ts` | Synthetic in-memory adapter for E1 |
| `schema-divergence.ts` | The single place that depends on Finance review finding F-1 |
| `errors.ts` | `ShareholderDomainError` carrying `StageOneErrorCode` |
| `index.ts`, `capital-receipt-intent.test.ts` | Barrel and 32 tests |

### Source-side validation for a USD capital installment into an office safe

In `CapitalReceiptIntentService.validate`, all failing closed:

1. shareholder exists, is `ACTIVE`, and is in the requested legal entity;
2. capital agreement exists, is in the same entity, belongs to that shareholder, is a
   `CAPITAL_CONTRIBUTION` (a `SHAREHOLDER_LOAN` is refused) and is fundable;
3. verified `FORMAL_REGISTRATION` evidence exists;
4. a controlled `CAPITAL_AGREEMENT` document exists, and the intent carries its own evidence;
5. the installment exists, belongs to the agreement, and is not already received or posted;
6. the amount is positive, in the agreement's denomination currency, USD for this slice, within the
   remaining commitment, and — if smaller than the expected installment — permitted by
   `partialInstallmentsAllowed`;
7. the destination cash account is identified;
8. the source transaction carries a stable idempotency key and correlation id.

Only then is a `CapitalReceiptIntent` created, with status `ELIGIBLE`.

### Confirmation: no direct GL posting exists in the Shareholder domain

Enforced three ways and asserted by test *"the shareholder domain cannot post"*:

- `packages/shareholder/package.json` declares exactly one dependency, `@abos/contracts`. The test
  reads the manifest and asserts the dependency list equals `["@abos/contracts"]`.
- The public surface is scanned for `postJournal`, `postCapital`, `ledgerBalance`, `creditAccount`,
  `debitAccount` — none may appear.
- `repository.ts` is stripped of comments and scanned for `/journal/i`, `/balance/i`, `/post\w*\(/i`,
  `/ledger/i` — the port cannot declare a way to write any of them.

The domain also never increases a safe balance: there is no Treasury write port, and
`TREASURY_VERIFIED` is reachable only by passing a `VerifiedTreasuryReceipt` produced elsewhere.

### Pending capital and shareholder loans

- A contribution without verified formal registration is classified
  `UNDETERMINED_PENDING_POLICY` — **not** paid-in share capital and **not** automatically a
  refundable liability. Test: *"pending registration is neither paid-in capital nor automatically a
  liability"*.
- `ShareholderLoanTerms` carries principal, original currency, repayment terms and
  `crossCurrencyRepaymentPermitted`, plus an explicit `policyDecisionsOutstanding` list. No interest,
  conversion basis or posting rule is invented. Loans cannot enter the capital-receipt path.

## Test results

```
node --test --experimental-strip-types packages/shareholder/src/*.test.ts
  tests 32 · pass 32 · fail 0

node --test --experimental-strip-types packages/finance/src/*.test.ts   (regression)
  tests 23 · pass 23 · fail 0

tsc --noEmit (packages/shareholder)   clean
eslint packages/shareholder --max-warnings=0   clean
```

Coverage of the required cases: missing/invalid agreement · non-approved agreement · missing,
unverified and wrong-kind registration evidence · missing controlled document · missing intent
evidence · authorized partial installment · partial forbidden by agreement · excess installment ·
zero amount · commitment consumed by prior contributions · rejected contribution releasing
commitment · wrong legal entity · agreement of another shareholder · non-active profile · loan
agreement used as capital · non-USD · currency mismatch against denomination · missing destination ·
missing idempotency key · duplicate replay · key reuse with different payload · second intent for the
same installment · installment already posted · invalid state transitions · unknown intent ·
six treasury-handoff divergences · no-posting boundary · schema divergence.

## Coordination

### To Codex — decisions I need

Full detail in `STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md`. Blocking me:

- **F-1** `CapitalAgreementStatus` — contract says `APPROVED`, the database stores
  `PENDING_EVIDENCE` / `ELIGIBLE`. My dependency is isolated in `schema-divergence.ts`; one edit once
  you rule.
- **F-2** `abos.capital_receipt_intents` does not exist, so my output cannot be persisted and
  `posting_intents.source_id` has no foreign key. `ShareholderRepository` is written to the shape that
  table needs.

Also requested, not blocking: **F-3** persisted synthetic-only gate, **F-4** durable
over-contribution constraint, **F-5..F-8** reversal SoD, reversal date, cash-count validation, cost-centre
scope. And an additive `stage1-e0-v2` carrying `partialInstallmentsAllowed` and
`remainingEligibleAmount` on `CapitalInstallmentEligibility`, which I already compute.

### To Antigravity — the agreed handoff

`assertHandoffPreservesSource(intent, receipt)` is exported from `@abos/shareholder` and is the
contract. A `VerifiedTreasuryReceipt` must preserve: the same source transaction
(`capitalReceiptIntentId === intent.id`), destination type `CASH_LOCATION`, the same
`destinationAccountId` the intent identified, the same currency, the exact same amount, a non-empty
`physicalCashCountId`, and at least one evidence reference. Legal entity, shareholder, agreement and
installment are preserved because the intent is the sole carrier of those and the receipt points at it.

The shareholder domain never infers a receipt from an intent: `markTreasuryVerified` is the only
transition into `TREASURY_VERIFIED` and it requires your record.

### End-to-end test — not yet run

The E2E for the first USD capital receipt must live in Codex's integration package, because it needs
`@abos/finance`, which I cannot depend on without breaking my own boundary guarantee. Sequence to host:

1. `CapitalReceiptIntentService.createCapitalReceiptIntent(...)` → `ELIGIBLE` intent.
2. Antigravity's Treasury verifies a physical count → `VerifiedTreasuryReceipt`.
3. `assertHandoffPreservesSource(intent, receipt)`.
4. `service.markTreasuryVerified(...)` → `TREASURY_VERIFIED`.
5. Codex builds `CapitalPostingIntent`, independent `FinanceApproval`, then
   `FinancePostingService.postCapitalReceipt(...)` → `PostedJournal`.
6. `service.markPosted(..., journalId)` → history reaches `POSTED`.
7. `reconcileCapitalReceipt(...)` → `reconciled === true`.

I can write steps 1–4 and 6 as fixtures the moment the integration harness exists.

## Remaining blockers and Finance Manager decisions

**Blockers (Codex):** F-1 and F-2 — until both land, the domain runs only on the in-memory adapter.

**Requires Finance Manager, not an engineer:**

1. Accounting treatment of a contribution received **before** formal capital registration. I record
   `UNDETERMINED_PENDING_POLICY` and refuse to guess between equity and liability.
2. Whether `partialInstallmentsAllowed` is an agreement-level term or needs per-installment approval.
3. Shareholder-loan posting rules: interest, principal classification, and the conversion basis for a
   permitted cross-currency repayment. Structures exist; no rule is implemented.
4. Whether an over-commitment contribution is ever acceptable with approval, or always refused.
5. Definition of the `APPROVED` workflow state for a capital agreement — who approves, against what
   evidence — which is the business half of F-1.

No policy above has been invented, and no synthetic figure in the tests represents a real AL-BERUNIY
shareholder, agreement, safe or amount.
