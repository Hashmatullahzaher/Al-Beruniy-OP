# V1 loans: realized FX on settlement

Migration 0063, changed by 0064. The owner decided that a foreign-currency loan must leave no USD behind once its native principal is repaid.

**Superseded in part.** 0064 gave the Treasury side its own carrying value. The liability mathematics below still apply: `K` is what leaves the loan. But the realized result is now the difference between the two carrying values, not `P − K`. Read `V1_FX_TREASURY_CARRYING_VALUE.md` for the current rule, and "Consequences to know" below as history.

## The rule

A repayment removes **carrying value** from the liability. The Treasury is credited with **the cash at the repayment's own frozen rate**. The difference between the two is a realized FX gain or loss, posted in the same journal.

Principal itself never reaches income or expense. Only the difference does.

## The mathematics

For one loan:

| Symbol | Meaning | Source |
|---|---|---|
| `N` | Native principal still owed | `loan_position`, from posted journals |
| `C` | Carrying value still owed, in the accounting currency | `loan_position`, from posted journals |
| `a` | Native amount of this repayment | The repayment |
| `P` | Cash value of this repayment | `a` at its own frozen rate, from `fx_conversions` |
| `s` | Decimal places of the accounting currency | The same frozen conversion |

The carrying value removed, `K`:

- **Final repayment (`a = N`):** `K = C` exactly. Nothing can be left behind.
- **Partial repayment (`a < N`):** `K = C × a ÷ N`, rounded half up to `s` places.

`K` is computed in exact decimal arithmetic, using the same integer form as `fx_amount`:

```text
K = div(2 × C × a × 10^s + N, 2 × N) ÷ 10^s
```

A partial `K` is then held between one smallest unit and `C` less one smallest unit. So a part never removes nothing, and never removes everything. If `C` is a single smallest unit, no part can exist, and the repayment is refused until it is made in full.

The realized difference is `D = P − K`:

| `D` | Journal |
|---|---|
| Zero | Dr Liability `K`, Cr Treasury `P`. Two lines, the same as a USD repayment |
| Positive, a loss | Dr Liability `K`, Dr Realized FX Loss `D`, Cr Treasury `P` |
| Negative, a gain | Dr Liability `K`, Cr Treasury `P`, Cr Realized FX Gain `−D` |

No line is ever written with a zero amount, and no FX account is asked for unless `D` is not zero.

### Why it always ends at zero

`K` is what the liability subledger entry records, so `C` is always the original value less everything still removed. A final repayment takes all of `C`, whatever earlier rounding did. Reversals put back exactly what their originals removed, so the same holds after any order of repayments and reversals.

### One receipt per loan

A loan has exactly one receipt: `abos.loans` is one row with one journal. There is no FIFO question and no pool of receipts to allocate between. If a later slice allows a second receipt into a loan, `C` and `N` already sum everything posted, so the same remaining-carrying-value method applies.

### Worked example

10,000 AFN received at 70 is carried at USD 142.86.

| Repayment | Rate | Cash `P` | `K` | `D` | Remaining `N` | Remaining `C` |
|---|---|---|---|---|---|---|
| 3,000 | 80 | 37.50 | 42.86 | Gain 5.36 | 7,000 | 100.00 |
| 3,333 | 50 | 66.66 | 47.61 | Loss 19.05 | 3,667 | 52.39 |
| 3,667 | 64 | 57.30 | 52.39 | Loss 4.91 | 0 | 0.00 |

The differences net to a loss of 18.60, which is 142.86 received less 161.46 paid.

## When it is worked out

At posting, under the loan row's lock, in `loan_repayment_post`. A repayment waiting for approval has frozen its cash value but not its carrying value, so it settles whatever is owed when it is approved. Two pending repayments settle in the order they are approved.

The journal validator works the settlement out again from the journals, and refuses the posting unless every line matches exactly.

A repayment dated earlier than one already posted still uses the position at posting. The order of posting decides the allocation, and it is recorded in the journals, so it never changes afterwards.

## What the kernel gained

Each change is general, and a source that does not use it behaves exactly as before.

- `posting_kernel_draft` accepts `p_line_base_amounts`, one amount per line. Without it, every line carries the one amount.
- `posting_sources.line_count_max` lets a source allow one more line. Only `LOAN_REPAYMENT` and `REVERSAL` use it.
- `reversal_post` copies each original line's amount, so a three-line journal reverses exactly. No rate is read.
- The intent's `base_amount` stays the journal's total, so the kernel's balance check is unchanged. For a repayment that total is the larger of `P` and `K`. The cash is proved separately, against the frozen conversion.

Each FX line carries the repayment's native amount and currency, as an AFN expense line does. `journal_lines` requires a positive original amount on every operational line, and that constraint was not weakened.

## Accounts

Two new Chart of Accounts controls, each fixed to one type:

| Control | Account type |
|---|---|
| `REALIZED_FX_GAIN` | `REVENUE` |
| `REALIZED_FX_LOSS` | `EXPENSE` |

`FX_DIFFERENCE` was not reused. It is one account of either type, so it could not hold both a gain and a loss, and it belongs to the FX policy's rounding.

No migration creates these accounts. A repayment that needs one is refused before anything is written. Exactly one usable account of the role must exist: active, in the accounting currency, accepting postings, with no required dimensions.

## Readiness

`finance_loan_readiness` names the state of the four account roles and the reader's own loan permissions. It says nothing about any lender or loan.

Add Money and Loans show what is missing, with a link to a filled-in Chart of Accounts form. The person still gives the code and saves through the usual command. Someone who can read roles sees which loan permissions reach no active person. Nothing is granted or created automatically.

## Consequences to know

**Rounding can realize a small difference at an unchanged rate.** Each repayment's cash is rounded on its own. Repaying in many parts at the loan's own rate can therefore realize a cent. It is real and it is recorded, and that repayment needs the FX account like any other.

**The Safe's USD value is not revalued.** Treasury is credited at the repayment's rate, as the owner specified, and Safes have no revaluation in V1. So when AFN comes in at one rate and leaves at another, the Safe's AFN balance returns to zero, but its USD book value does not. A realized loss leaves the empty Safe with a negative USD value, and a gain leaves it with a positive one.

The company's total stays correct and the Balance Sheet balances, but the Safe's USD line and the realized result both carry that amount. Clearing it needs Safe revaluation or cost tracking, which is outside this slice.

## Outside this slice

- **Loan-funded direct settlement / lender-paid expense.** A lender paying a company bill directly is a different business event. It is not a loan receipt into Treasury, capital or an opening balance, and it stays out of V1 until a real case needs it. Do not record it as a loan receipt: that would show money in a Safe that never arrived.
- Loan interest.
- Revaluation of loans or Safes.
- Cross-currency repayment.
