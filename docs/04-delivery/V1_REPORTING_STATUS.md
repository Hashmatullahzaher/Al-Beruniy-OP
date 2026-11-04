# V1 reporting status

All reports derive from posted journals and their lines, through shared primitives. There is no balance table and no report totals table.

| Report | Status | Migration | Where |
|---|---|---|---|
| Trial Balance | Done | 0053 | `/finance/trial-balance` |
| General Ledger | Done | 0053, masking in 0057 | `/finance/general-ledger` |
| Account Statement | Done | 0053, 0055, masking in 0057 | `/finance/account-statement` |
| Safe / Saraf Statement | Done, not deployed | 0057 | `/finance/safe-statement` |
| Shareholder Statement | Done, not deployed | 0058 | `/finance/shareholder-statement` |
| Financial Summary | Done, not deployed | 0058 | `/finance/financial-summary` |
| Income Statement | Done, not deployed | 0059 | `/finance/income-statement` |
| Balance Sheet | Done, not deployed | 0059 | `/finance/balance-sheet` |

"Not deployed" means merged to trunk and ready, waiting for owner authorization.

## Delivery records

- `V1_REPORTING_0057_SAFE_STATEMENT.md`, which also holds the audit of the reporting foundation
- `V1_REPORTING_0058_SHAREHOLDER_AND_SUMMARY.md`
- `V1_REPORTING_0059_FINANCIAL_STATEMENTS.md`
- `docs/03-architecture/V1_CHART_OF_ACCOUNTS_CLASSIFICATION_AUDIT.md`

## OWNER DECISION REQUIRED

None of these blocks a report. Each report is correct today; these are choices about accounting presentation that the system should not make alone.

### 1. Retained earnings at year end

**Question:** when a financial year closes, should its result be moved to a retained earnings account by a closing journal?

- **Option A, keep deriving it (current behaviour).** The Balance Sheet shows "Result of earlier years" and "Result of the current year", worked out from income and expense accounts. No journal is posted.
- **Option B, post a closing entry.** A year-end journal moves the result to a retained earnings equity account, and income and expense accounts start the next year at zero.

**Accounting effect:** total equity is the same either way. Option B adds a real ledger balance for retained earnings, but it needs a new posting source and a defined account, and the Trial Balance would change shape at year end.

**Recommendation:** Option A for V1. Revisit Option B before the first statutory filing.

### 2. Current and non-current, operating and other

**Question:** do you need statements split into current and non-current items, or operating and other income?

- **Option A, stay with the present structure.** Statements present by class and by the groups the schema guarantees.
- **Option B, add an optional presentation attribute.** One `statement_section` per ledger account, set by your accountant. Accounts without one are flagged, never guessed.

**Accounting effect:** presentation only. No figure changes.

**Recommendation:** Option A now. Choose Option B if an auditor or lender asks for classified statements.

### 3. A Saraf with a negative balance on the Balance Sheet

**Question:** when an ASSET-type Saraf is negative, should the Balance Sheet keep it under Treasury as a negative figure, or show it under liabilities?

- **Option A, keep it in Treasury (current behaviour).** It stays in its account's class as a negative figure, with a note. The Treasury total equals the Treasury accounts.
- **Option B, reclassify it at the reporting date.** Treasury and liabilities both rise by that amount. This is the usual presentation for an overdraft.

**Accounting effect:** total assets and total liabilities change by the same amount. Equity does not change.

**Recommendation:** Option A for now, as it keeps Treasury reconciling line by line. Choose Option B if your accountant prefers overdraft presentation.

## Known debt

- A dedicated shareholder loan product remains policy-gated (V1 #14). Loans today are temporary funding, which cannot be reversed.
- PDF and Excel export are not built. Reports print cleanly.
- `ledger_account_balances` and `finance_general_ledger` are unused older functions, kept because applied migrations are not rewritten.
- `/finance/capital-bridge-review` shows signed-out visitors an error page instead of "not found". It exposes no data.
