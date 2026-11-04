# V1 reporting 0059: Income Statement and Balance Sheet

Migration `0059_v1_income_statement_and_balance_sheet`. Read functions only: no table, no row, no journal. Not deployed to preserved production: that needs separate owner authorization.

The audit in `docs/03-architecture/V1_CHART_OF_ACCOUNTS_CLASSIFICATION_AUDIT.md` found no classification migration necessary, so this number holds the statements themselves.

## Architecture

| Function | Role |
|---|---|
| `report_classified_accounts` | Every account with its class, parent and position, over `report_account_balances` |
| `report_year_start` | The first day of the financial year holding a date |
| `finance_income_statement` | The Income Statement entry point |
| `finance_balance_sheet` | The Balance Sheet entry point |

Screens: `/finance/income-statement`, `/finance/balance-sheet`. Both carry account-level arithmetic only and never a source, so they need only the report permission and read the same for every report reader.

## Accounting mathematics

**Income Statement.** Income is credit less debit on REVENUE accounts; expenses are debit less credit on EXPENSE accounts. The ledger account decides, so any posting appears whichever module made it. Reversals net through their journals. AFN activity appears at its stored accounting amount, and nothing is recomputed.

**Balance Sheet.** At a date, each ASSET, LIABILITY and EQUITY account shows its balance on its natural side. A negative balance stays in its class as a negative figure.

**Accumulated result.** No closing or retained earnings journal exists, and none is posted. The result is derived from REVENUE and EXPENSE accounts and shown inside equity on two lines:

- **Result of earlier years:** everything before the financial year holding the date.
- **Result of the current year:** from that year's first day to the date.

Closing a financial year changes no figure, and the following year shows that result under earlier years.

**Validation.** `Assets − Liabilities − Equity` is shown on the statement, in exact decimals, with a count of any unbalanced posted journal. Opening Balance Equity is always shown while the account exists.

**Treasury proof.** The Treasury accounting value is compared with the ledger accounts of the Treasury accounts.

## Drill-down

Every account line opens its Account Statement for the same period, which opens the journal and then the business source where the reader is authorized. The current-year result opens the Income Statement.

## Reconciliation

`report-reconciliation.test.ts` is permanent. On one company holding every kind of event, it proves the Trial Balance, Safe Statements, canonical Treasury balances, ledger, Shareholder Statement, Financial Summary, Income Statement and Balance Sheet all agree, that reversals net in each, that AFN reconciles through the frozen conversions with no revaluation, and that a restricted reader gets identical mathematics and no source detail.

## Known debt

See the owner decisions in `V1_REPORTING_STATUS.md`. Statutory presentation (current and non-current, operating and other) is not available, because the schema does not record it.
