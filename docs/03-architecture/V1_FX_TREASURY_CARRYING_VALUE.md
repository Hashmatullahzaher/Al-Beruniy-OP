# V1 foreign-currency Treasury carrying value

Migration 0064. The owner decided on 2026-11-06 that foreign-currency Treasury accounts use derived weighted-average carrying value, not automatic revaluation.

**The invariant:** when a foreign-currency Treasury account holds native zero, its base carrying value is exactly 0.00.

## Audit: behaviour before 0064

Every source that can move a Treasury account, as it stood at 0063:

| Source | Direction | Foreign currency | What it posted to Treasury |
|---|---|---|---|
| `OPENING_BALANCE` | In | Yes | `native × rate` |
| `CASH_RECEIPT` | In | Yes | `native × rate` |
| `LOAN_RECEIPT` | In | Yes | `native × rate` |
| `OPERATIONAL_EXPENSE` | Out | Yes | `native × rate` |
| `PAYMENT` | Out | Yes | `native × rate` |
| `LOAN_REPAYMENT` | Out | Yes | `native × rate` |
| `TREASURY_TRANSFER` | Out and in | Yes, same currency only | `native × rate` on both accounts |
| `REVERSAL` | Inverse | Yes | The original's lines |
| `DIRECT_SHAREHOLDER_CAPITAL` | In | No | Refused unless the accounting currency |
| `TEMPORARY_FUNDING` | In | No | A check constraint requires the accounting currency |
| `TEMPORARY_FUNDING_SETTLEMENT` | Out | No | A check constraint requires the accounting currency |
| `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` | In | No | Frozen |
| `COUNT_DIFFERENCE` | Not built | No | Registered as planned, with no code behind it |

Four outflow lanes and the transfer lane assumed `native × frozen rate = Treasury ledger amount`. An inflow at one rate and an outflow at another therefore left a base balance with no native behind it. 70,000 AFN in at 70 and out at 56 left the Safe at USD −250.

## The model

Nothing new is stored. For each account, `treasury_carrying_position` sums the posted subledger:

- **Native balance:** the sum of `original_amount`.
- **Base carrying value:** the sum of `base_amount`.

Two values stay separate, each with its own home:

| Value | Meaning | Where it lives |
|---|---|---|
| Transaction-date value | The movement at its own frozen rate | The source row and `fx_conversions`, unchanged |
| Carrying movement | What the account actually gave up or took on | The Treasury journal line and subledger entry |

The schema already had both fields, so no column was added and no number carries two meanings.

## The formula

`treasury_carrying_move` is the one rule. Every lane calls it, and each validator calls it again.

For a position of native `N` and carrying `C`, and a movement of native `a` valued at `v`:

| Case | Carrying moved |
|---|---|
| The account is in the accounting currency | `v` |
| `N` is zero, or the movement adds to the position | `v` |
| The movement reduces the position, and `a = |N|` | `|C|` exactly |
| The movement reduces the position, and `a < |N|` | `|C| × a ÷ |N|`, rounded half up |
| The movement goes through zero, `a > |N|` | `|C|`, plus `v × (a − |N|) ÷ a` for the new position |

The partial case uses the same exact integer form as `fx_amount`:

```text
K = div(2 × |C| × a × 10^s + |N|, 2 × |N|) ÷ 10^s
```

A partial `K` is held between one smallest unit and `|C|` less one smallest unit. If `|C|` is under two smallest units, no part is possible and the balance moves in full.

**Rounding is not a gain or a loss.** If a partial `K` is within one smallest unit of `v`, `K` becomes `v`. The unit stays in the position and the final movement clears it. Without this, an ordinary same-rate expense could demand an FX account over a cent.

### What `v` is

`v` is the amount the other side of the journal moves by:

| Lane | `v` |
|---|---|
| Expense, payment, receipt, loan receipt | The transaction-date value |
| Transfer, source account | The transaction-date value |
| Transfer, destination account | The carrying value that left the source |
| Loan repayment | The loan carrying value being extinguished |

### Direction

ABOS quotes USD 1 = this many AFN, so a lower number is a stronger AFN. The rule needs no direction logic. Every journal has a debit side `X` and a credit side `Y`:

| Result | Line 3 |
|---|---|
| `X = Y` | None |
| `X > Y` | Credit Realized FX Gain by `X − Y` |
| `X < Y` | Debit Realized FX Loss by `Y − X` |

| Lane | `X` (debit) | `Y` (credit) |
|---|---|---|
| Expense | Expense at day's value | Treasury carrying |
| Payment | Payable at day's value | Treasury carrying |
| Cash receipt | Treasury carrying | Income at day's value |
| Loan receipt | Treasury carrying | Liability at day's value |
| Transfer | Destination carrying | Source carrying |
| Loan repayment | Liability carrying | Treasury carrying |

The FX line carries the native amount, as every operational line must. It names no party. On an expense it keeps the expense's dimensions.

## Examples

70,000 AFN enters a Safe at 70, so native 70,000 and carrying USD 1,000.

| Event | Debit | Credit |
|---|---|---|
| Spent at 70 | Expense 1,000 | Safe 1,000 |
| Spent at 56 | Expense 1,250 | Safe 1,000, Realized FX Gain 250 |
| Spent at 80 | Expense 875, Realized FX Loss 125 | Safe 1,000 |
| Moved to another AFN Safe on a day at 80 | Other Safe 1,000 | Safe 1,000 |

At 56 the AFN is stronger, so it buys more than it cost. The net cost is still the USD 1,000 the AFN cost.

### Loan repayment

A repayment has two carrying values. It removes the loan's, it removes the Treasury's, and the difference is the whole realized effect.

| Situation | Debit | Credit |
|---|---|---|
| Loan of 7,000 at 70, repaid from that same AFN, on a day at 56 | Loan 100 | Safe 100 |
| Half repaid from AFN bought at 50 | Loan 50, Realized FX Loss 20 | Safe 70 |
| Half repaid from AFN bought at 80 | Loan 50 | Safe 43.75, Realized FX Gain 6.25 |

The first row realizes nothing at any rate. The asset and the liability moved together, so their FX effects offset. This replaces 0063's rule, which compared the loan to the day's cash value and left the opposite difference in the Safe.

## The one check

Formulas alone cannot hold the invariant, because a position changes over time. `treasury_position_stays_valid` asks one question: would this change leave native and value disagreeing, on its date or any later one?

Native and value must have the same sign. That single test covers native zero with a value left, a value of the wrong sign, and a balance with no value.

It is the only refusal of its kind, and it is narrow. Everything else proceeds.

| Movement | Result |
|---|---|
| Dated today | Always allowed. A final movement clears exactly |
| A late receipt, behind later spending | Allowed. It only adds |
| A late outflow that would leave native zero with a value on a later day | Refused, `TREASURY_FX_OUT_OF_ORDER` |
| Reversing an outflow, with later outflows standing | Allowed. It only adds back |
| Reversing a receipt, leaving a valid position | Allowed |
| Reversing a receipt whose money has been spent, leaving native zero with a value | Refused, `TREASURY_LATER_MOVEMENT` |

The check applies to foreign-currency accounts only. A position that already disagrees can only come from a history posted before 0064, and a movement is not refused for what it did not cause.

A movement dated behind others uses the position held on its own date. It does not recalculate any later movement, and later journals stay exactly as posted. Later movements take the position as it now stands, and the next full disposal realizes any difference.

## Late-dated movements

**V1 rule: posted carrying allocations are immutable. They are not recalculated when a later posting uses an earlier business date.**

- A late-dated movement uses the position held on its own date.
- Movements already posted keep the carrying value they posted, including any realized FX.
- The difference this leaves is realized by the next full disposal.
- A late movement that would leave native zero with a value on a later day is refused, `TREASURY_FX_OUT_OF_ORDER`.

There is no warning on the form for a late-dated foreign-currency posting. If the product needs one, it will be proposed separately.

## Accounts below zero

A Saraf may go below zero, and a bank or other account is unlimited. A negative position is an amount owed in that currency, and it has a carrying value too.

So a position is signed, and "reducing it" works in both directions. An inflow into an amount owed can realize FX, and money sent to settle one realizes the gap between the two positions. That is the only way a same-currency transfer realizes anything, and it comes from the two carrying values, never from the day's rate.

## Reversals

Unchanged: a reversal is the exact inverse of the posted lines, and reads no rate. `reversal_post` copies each line's amount, so it restores native and carrying exactly, and any FX goes out with its movement.

The posted lines hold everything a reversal needs, so it never reconstructs an allocation from today's state. Whether a reversal may run depends only on the check above. It is refused before anything is written, and the journal list shows `LATER_TREASURY_MOVEMENT`.

That check is a definer, `treasury_reversal_safe`, owned by the operational owner. The reversal request screens belong to an older Finance owner with no access to the Treasury tables. It gets a yes-or-no answer, not table access, and the runtime cannot call it.

## Concurrency

`treasury_carrying_move` takes the account row with `FOR NO KEY UPDATE` before reading the position. A second movement waits, then reads the first one's committed result. Accounts in the accounting currency take no new lock, so they stay as concurrent as before.

A reversal takes the loan row first, as a repayment does, then its accounts in a stable order, so the two cannot deadlock.

An overdraft on a Safe is refused by the funds guard in its own words. The carrying rule steps aside for it, so a person is told the Safe lacks money, not that an FX account is missing.

## Accounts and readiness

The two roles from 0063 serve every lane. An ordinary posting never needs them. A movement that realizes a difference is refused atomically if its account is missing, with a link to the Chart of Accounts. No migration creates them.

## History posted before 0064

Production has no AFN account, so this applies only to a copy or a future import. Migration 0064 changes no posted row, because correcting history would need a journal.

| State after upgrade | Rule |
|---|---|
| Native and value have the same sign | Carries on as a position. The next full disposal realizes whatever the old rule left |
| Native zero, value left (`ORPHAN`) | Stays on the statement. A later inflow adds to it |
| Value of the wrong sign, or zero (`INVERTED`) | Money cannot leave, with `TREASURY_CARRYING_CORRECTION_REQUIRED`. An inflow can restore the sign |

The Safe statement reports the state as `carryingStatus`.

Carrying value can always be derived from these histories, because the subledger holds every movement. What cannot be derived is what the value should have been, so nothing is fabricated: the figure stays as posted, marked, and no migration writes a correcting journal.

Reversing an old journal still uses its own posted lines. That is the cleanest correction, because it restores the position as it was. The same check applies, so a reversal that would newly orphan a value is refused.

## Reports

- **Safe / Saraf Statement:** native first. Each movement shows the rate, the day's value, the carrying movement and the running carrying value. The day's value is never labelled as the account's balance.
- **Financial Summary:** income and expenses leave realized FX out, and it has its own two lines. The net result includes it.
- **Income Statement:** realized FX appears once, under its own accounts.
- **Balance Sheet:** Treasury at carrying value.
- **Trial Balance, General Ledger, Account Statement:** unchanged, because they read posted lines.

The Financial Summary's accounting-currency flows are Treasury movements, so they are at carrying value. An expense's flow is what left Treasury, not the expense.

## Consequences to know

- **A transfer still needs the day's rate.** The rate no longer affects a normal transfer. It is kept because it values a movement into an account with nothing to take value from, and to avoid changing the form. A missing rate still refuses a foreign-currency transfer.
- **A final movement can realize a cent at an unchanged rate.** Its value is frozen and it must clear what remains, so a rounding residue has nowhere else to go. That movement needs the FX account.
- **A late movement changes what later ones would have been.** It never changes them, because posted journals are immutable. The next full disposal realizes the difference instead.

## Outside this slice

- Closing-rate or period-end revaluation. It stays a future explicit accounting source.
- FIFO and LIFO.
- Cross-currency exchange between Treasury accounts, which stays refused.
- A correction source for a pre-0064 orphan.
