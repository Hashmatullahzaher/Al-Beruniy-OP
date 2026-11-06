# V1 foreign-currency Treasury carrying value: migration 0064

The design and the mathematics are in `docs/03-architecture/V1_FX_TREASURY_CARRYING_VALUE.md`.

Not deployed. Production stays at 0060 until the owner authorizes 0061 to 0064, which deploy together.

## What was built

- **The rule:** `treasury_carrying_move` works out what a movement posts to Treasury. Every lane calls it, and every validator calls it again.
- **The read:** `treasury_carrying_position` derives native and carrying from posted movements. Nothing new is stored.
- **The check:** `treasury_position_stays_valid` refuses the few movements and reversals that would break the invariant.
- **Registry:** expense, payment, cash receipt, transfer and loan receipt may have the third FX line, as loan repayment and reversal already could.
- **Loans:** a repayment reconciles the liability's carrying value with the Treasury's. The difference is the whole realized effect.
- **Safe statement:** shows the day's value, the carrying movement and the running carrying value, and marks a history that needs correcting.
- **Financial Summary:** realized FX has its own lines, outside income and expenses.
- **Screens:** a refusal for a missing FX account links to the Chart of Accounts on every money form.

## Before and after, by source

| Source | Before 0064 | After 0064 |
|---|---|---|
| Opening balance | Treasury at the day's value | The same. Refused if it lands on an amount already owed at another value |
| Cash receipt | Treasury and income at the day's value | The same, unless it reduces an amount owed, which can realize FX |
| Expense | Expense and Treasury at the day's value | Expense at the day's value, Treasury at carrying, FX for the difference |
| Payment | Payable and Treasury at the day's value | Payable at the day's value, Treasury at carrying, FX for the difference |
| Transfer | Both accounts at the day's value | Both accounts at the source's carrying value, no FX. FX only when the money settles an amount the destination owes |
| Loan receipt | Treasury and liability at the day's value | The same, unless it reduces an amount owed |
| Loan repayment (0063) | Liability at carrying, Treasury at the day's value, FX for the difference | Liability at carrying, Treasury at carrying, FX for the difference between those two |
| Reversal | Exact inverse | Exact inverse. Refused only if it would leave a value with no balance |
| Accounting-currency movements | Unchanged | Unchanged, with no new lock and no new check |

## Before use in production

Nothing new beyond the steps in `V1_LOAN_REALIZED_FX_0063.md`. The two realized FX accounts are now needed whenever foreign currency settles at a value other than what it carried, on any lane, not only on a loan. A movement that needs one is refused until it exists.

## Tests

`packages/e1-integration/src/fx-treasury-carrying.test.ts` holds the 22 owner cases, numbered as the owner listed them, plus the owner's examples A, B and C. The same-rate and transfer cases run before any FX account exists.

`packages/e1-integration/src/fx-treasury-upgrade.test.ts` upgrades a company holding AFN history posted under the old rule.

`packages/e1-integration/src/loan-realized-fx.test.ts` keeps the 0063 cases. A repayment there draws on a Safe holding that AFN at that day's rate, so the Treasury's carrying value equals the day's value and every 0063 figure is still asserted.

`apps/web/tests/v1-operational-finance.spec.ts` step 14 runs it through the screens: AFN repaid from the same basis realizes nothing, then the rest is spent at a better rate and the gain appears once.

## Decisions on record

- Weighted average, derived. No FIFO, no LIFO, no automatic revaluation.
- Period-end revaluation is a future explicit source.
- Cross-currency transfer stays refused.
