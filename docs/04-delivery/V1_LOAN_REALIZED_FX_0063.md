# V1 realized FX on loan settlement: migration 0063

The design and the mathematics are in `docs/03-architecture/V1_LOAN_REALIZED_FX.md`.

Not deployed. Production stays at 0060 until the owner authorizes 0061, 0062 and 0063, which deploy together.

## What was built

- **Settlement:** a repayment removes carrying value, and any difference from the cash paid is a realized FX gain or loss in the same journal.
- **Accounts:** the Chart of Accounts roles `REALIZED_FX_GAIN` (income) and `REALIZED_FX_LOSS` (expense).
- **Kernel:** per-line amounts and an optional third line for `LOAN_REPAYMENT` and `REVERSAL`.
- **Reversal:** copies each posted line's amount, and reads no rate.
- **Statement:** each movement shows its carrying value, its cash value and any realized difference.
- **Readiness:** Add Money and Loans list what is missing, with links, through `finance_loan_readiness`.
- **Temporary funding:** its page directs new borrowing to Loans.

## Journals

A loan of AFN 7,000 received at 70, so carried at USD 100.

| Event | Debit | Credit |
|---|---|---|
| Repay AFN 3,500 at 70 | Loan Payable 50.00 | AFN Safe 50.00 |
| Repay AFN 3,500 at 80 | Loan Payable 50.00 | AFN Safe 43.75, Realized FX Gain 6.25 |
| Repay AFN 3,500 at 50 | Loan Payable 50.00, Realized FX Loss 20.00 | AFN Safe 70.00 |
| Reversal of that last one | AFN Safe 70.00 | Loan Payable 50.00, Realized FX Loss 20.00 |

## Before use in production

After deployment:

1. A Super Administrator gives a role the four loan permissions.
2. Someone creates the Shareholder Loan Payable and Other Loan Payable accounts.
3. Before a foreign-currency loan is repaid at a different rate, someone creates the Realized FX Gain and Realized FX Loss accounts.

No migration does any of these. Add Money and Loans show which are outstanding. A repayment that needs a missing account is refused before anything is written.

## Tests

`packages/e1-integration/src/loan-realized-fx.test.ts` holds the 22 owner cases, numbered as the owner listed them, and proves each against posted journal lines. The USD and same-rate cases run before any FX account exists.

`apps/web/tests/v1-operational-finance.spec.ts` step 14 runs the whole path through the screens: it creates the accounts from what the loan screen says is missing, receives AFN, repays it at a worse rate, and reads the reports.

## Decisions on record

- A lender paying a company bill directly stays outside V1, as `Loan-funded direct settlement / lender-paid expense`.
- `FX_DIFFERENCE` keeps currency exchange and revaluation. Loan settlement uses the two new roles.

## Open for the owner

Safes are not revalued. See "Consequences to know" in the architecture document.
