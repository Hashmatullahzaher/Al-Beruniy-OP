# V1 capital, shareholder loan and provider loan: audit and decision

Written before any migration, from the schema at 0060 and a restored copy of production. Figures describe production on 2026-11-05.

## What exists today

| Path | Status | Business source | Posting | Journal | Treasury | Reporting |
|---|---|---|---|---|---|---|
| Direct shareholder capital | Live lane | `direct_capital_receipts` | Posting kernel, source `DIRECT_SHAREHOLDER_CAPITAL` | Dr Treasury (or asset or expense), Cr Equity | `OPERATIONAL_TREASURY` subledger when cash moves | `SHAREHOLDER_CAPITAL` subledger, position kind CAPITAL |
| Legacy capital bridge | Frozen | `shareholder_capital_receipts` | Hand-written, source `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` | Dr Treasury, Cr Equity | Yes | Position kind CAPITAL |
| Temporary funding, into a Safe | Lane exists, never configured | `temporary_fundings`, mode `PROVIDER_FUNDED_SAFE` | Hand-written inserts, not the kernel draft | Dr Treasury, Cr `TEMPORARY_FUNDING_PAYABLE` | Yes | `TEMPORARY_FUNDING_PAYABLE` subledger, position kind LOAN |
| Temporary funding, bill paid directly | Lane exists, never configured | `temporary_fundings`, mode `PROVIDER_PAID_EXPENSE_DIRECTLY` | Hand-written inserts | Dr Expense, Cr payable | No | Position kind LOAN |
| Temporary funding repayment | Lane exists, never configured | `temporary_funding_settlements` | Hand-written inserts | Dr payable, Cr Treasury | Yes | Position kind LOAN, repayment |
| Opening balance | Live lane | `treasury_opening_balances` | Posting kernel | Dr Treasury, Cr Opening Balance Equity | Yes | Separate, never capital or a loan |
| Other money received | Live lane | `treasury_cash_receipts` | Posting kernel | Dr Treasury, Cr income | Yes | Income |

Production holds 0 journals, 0 temporary fundings, 0 settlements, 0 funding mappings and 0 provider identities. It has 3 shareholder profiles, 4 declared contributions and 0 capital receipts.

## Duplicate and dormant concepts

| Concept | Where | State |
|---|---|---|
| `capital_agreements.agreement_kind = 'SHAREHOLDER_LOAN'` | Legacy agreement model | Blocked from every pipeline, by test |
| `capital_receipt_intents.classification = 'SHAREHOLDER_LOAN_PRINCIPAL'` | Legacy E1 lane | Refused by CHECK |
| `shareholder_contributions.credit_classification = 'SHAREHOLDER_LOAN'` | Declarations | Label only |
| `posting_intents.intent_kind = 'SHAREHOLDER_LOAN_RECEIPT'` | Intent CHECK | Allowed, no writer |
| Control `SHAREHOLDER_LOAN` | Chart of Accounts | Allowed, no writer. The payment lane refuses it |
| Subledger `SHAREHOLDER_LOAN` | `subledger_entries` | Allowed, no writer. Read by `report_party_positions` |
| Control `TEMPORARY_FUNDING_PAYABLE` | Chart of Accounts | Used only by temporary funding |
| Workflow type `TEMPORARY_FUNDING` | Approval policy | Must be ON, or recording is refused |

So there are three debt vocabularies and one lane that could write any of them, and that lane has never run in production.

## Is temporary funding already a loan?

Mathematically, yes, in `PROVIDER_FUNDED_SAFE` mode. The journal is Dr Treasury, Cr liability, and repayment is its inverse. Reports already treat it as position kind LOAN.

As a lane, it cannot become the canonical loan without replacing most of what it is:

| Requirement | Temporary funding today |
|---|---|
| Posting kernel | Writes intents, journals and subledgers by hand |
| AFN | Refused by CHECK on both tables: `original_currency_code = base_currency_code` |
| Standard reversal | Refused by trigger and registry. `OPEN_ITEMS` records that its lineage was never designed |
| Approval policy | Approval must be ON. A single operator cannot use it at all |
| Plain lender | Needs a versioned provider identity profile with evidence first |
| Simple accounts | Needs a versioned payable mapping first |

## Phase 16 decisions

**Can temporary funding be evolved into the canonical loan source?** No. Evolving it would change the guarded shape of its tables, validators and triggers, and each of the six rows above would be rewritten. What remained would share only a table name that the product is retiring.

**Do we need a new canonical loan source?** Yes: `LOAN_RECEIPT` and `LOAN_REPAYMENT`, through the existing posting kernel. This is not a second debt subsystem, because temporary funding stops being a live lane. It is one posting engine, one live debt lane, and one compatibility lane that takes no new business.

**Is a general lender entity required?** No. `business_parties` already gives a lender identity, legal-entity isolation and subledger attribution, and a shareholder is already a party through `shareholder_profiles`. A loan stores its `lender_type`. A shareholder keeps one party and two separate positions, so capital and loans never merge. A `LENDER` party role records people who are only lenders.

**What becomes legacy compatibility only?**

| Item | Treatment |
|---|---|
| `temporary_fundings`, settlements, decisions, mappings, provider identities | Kept, no rows or functions removed |
| Sources `TEMPORARY_FUNDING`, `TEMPORARY_FUNDING_SETTLEMENT` | Stay ACTIVE so existing records can finish and post, marked `compatibility_only` |
| Their reports and drill-down | Unchanged, position kind LOAN |
| Their reversal | Stays refused, which is their existing behaviour |
| Temporary funding screen | Leaves the main navigation. New business uses Loans |
| `capital_agreements` kind `SHAREHOLDER_LOAN` and the other dormant labels | Untouched, still blocked |

## Target model

| Answer to "Where did this money come from?" | Lane | Journal |
|---|---|---|
| Shareholder Capital | Existing direct capital lane | Dr Treasury, Cr Equity |
| Shareholder Loan | New `LOAN_RECEIPT`, lender type SHAREHOLDER | Dr Treasury, Cr `SHAREHOLDER_LOAN` |
| Other Loan | New `LOAN_RECEIPT`, any other lender type | Dr Treasury, Cr `LOAN_PAYABLE` |
| Opening Balance | Existing opening balance lane | Dr Treasury, Cr Opening Balance Equity |

Add Money only asks the question and hands over to the lane. It posts nothing itself.

Repayment is `LOAN_REPAYMENT`: Dr liability, Cr Treasury.

## Rules

- **Balances:** outstanding is derived from posted journals. There is no stored balance.
- **Repayment:** it cannot exceed the outstanding native principal. Overpayment is not modelled. The check runs under a lock on the loan row, so concurrent repayments serialize.
- **Reversal:** the standard mechanism, with one added rule. A loan receipt cannot be reversed while an unreversed repayment exists. Reverse the repayments first.
- **Approval:** a new `LOAN` workflow type. No saved setting or OFF posts directly, as other money movements do. ON holds the record for a second person, who approves or rejects it.
- **FX:** each receipt and repayment uses the existing frozen snapshot of its own date. There is no revaluation, no settlement gain or loss, and no cross-currency repayment.
- **Interest:** no requirement exists in V1, so it is out of scope.
- **Confidentiality:** `LOAN_RECEIPT` and `LOAN_REPAYMENT` need `finance.loan.read`. A reversal of either follows the same rule, through 0060.

## Consequences to note

- **AFN repaid at a different rate.** Superseded by 0063 (`V1_LOAN_REALIZED_FX.md`): the difference is realized and no residual remains. As first built, native outstanding reached zero, but the USD liability could keep a small residual, because a repayment uses its own day's rate and settlement differences are excluded. See the owner decision in the delivery record.
- **A lender paying a bill directly** has no Treasury movement, so it is not a Loan receipt. Temporary funding's `PROVIDER_PAID_EXPENSE_DIRECTLY` mode has no replacement in this slice. It has never been used.
