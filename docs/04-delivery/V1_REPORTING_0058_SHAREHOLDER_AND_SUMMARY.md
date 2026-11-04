# V1 reporting 0058: Shareholder Statement and Financial Summary

Migration `0058_v1_shareholder_statement_and_summary`. Read functions only: no table, no row, no journal. Not deployed to preserved production: that needs separate owner authorization.

## Purpose

- **Shareholder Statement:** what a person put in as capital and, separately, what the company owes them as a loan.
- **Financial Summary:** where the company's money came from and went in a period, and the result.

## Architecture

| Function | Role |
|---|---|
| `report_range` (restated) | Adds a whole financial year as a period, and lists the company's financial years |
| `report_income_result` | Income, expenses and result from classified ledger accounts. 0059 uses the same function |
| `report_treasury_flows` | Every Treasury movement by what it really is, in native and accounting currency |
| `report_party_positions` | Capital and loans per party, from the subledgers |
| `finance_management_summary` | The Financial Summary entry point |
| `finance_shareholder_statement` | The Shareholder Statement entry point |

Screens: `/finance/financial-summary`, `/finance/shareholder-statement`. APIs under `/api/v1/finance/` with the same names. `ReportFilters` is the shared period chooser.

## Accounting mathematics

**Effective source.** A reversal counts as the source it reverses. A reversed capital receipt reduces capital received, and a reversed transfer stays a transfer.

**Summary categories**, each net of its reversals:

| Figure | Source |
|---|---|
| Shareholder capital received | `DIRECT_SHAREHOLDER_CAPITAL` |
| Loans received | `TEMPORARY_FUNDING` into a Treasury account |
| Other money received | `CASH_RECEIPT` |
| Expenses paid | `OPERATIONAL_EXPENSE` |
| Supplier and other payments | `PAYMENT` |
| Loan repayments | `TEMPORARY_FUNDING_SETTLEMENT` |
| Opening balances recorded | `OPENING_BALANCE`, shown apart: not money received |
| Transfers | `TREASURY_TRANSFER`, shown apart: never money received or paid |

**Identity:** opening + received − paid + opening balances recorded + transfers in − transfers out = closing. It is checked in each currency and in the accounting currency.

**Three-way proof of the closing position:** the Treasury accounts, the flows and the ledger accounts must all agree.

**Profit** comes from classified ledger accounts, so it can differ from money paid. An expense paid directly by a lender is an expense but never left Treasury.

**Equity:** minus the sum of `SHAREHOLDER_CAPITAL` entries. **Debt:** minus the sum of `TEMPORARY_FUNDING_PAYABLE` and `SHAREHOLDER_LOAN` entries. They are never added together. Each is reconciled to its control accounts in the ledger.

**Agreed capital** is the declared cash contributions, the same figure as the Shareholders page. It is information only and never decides a balance.

## Security

| Reader | Receives |
|---|---|
| `finance.report.operational.read` only | Company totals, nobody named, no party ids |
| `shareholder.read` or `shareholder.capital-receipt.read` | Shareholders and their capital. No loan figures |
| `finance.temporary-funding.read` | People with loans and their loans. No capital figures |
| Someone they may not see | Reported exactly like someone who does not exist |

Journal links need report permission, and Safe links need Safe or report permission. Line and source masking use the 0057 primitives.

## Known debt

- Temporary funding is the only loan source today, and it cannot be reversed. A dedicated shareholder loan product remains policy-gated (V1 #14). The statement already reads the `SHAREHOLDER_LOAN` subledger, so it needs no change when that lands.
- The Shareholders page still computes "contributed" from source rows, not the subledger. The two agree today, and it is reconciled by test.
