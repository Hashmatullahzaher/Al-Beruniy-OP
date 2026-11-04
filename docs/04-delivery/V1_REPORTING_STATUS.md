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

## Migrations

| Migration | Checksum |
|---|---|
| `0057_v1_safe_saraf_statement` | `cb8512702e6ae1141e961d7f30b43855200feeae938fb60f8eadbde0245bae1e` |
| `0058_v1_shareholder_statement_and_summary` | `71ad6d017c95db75842196e09370d05de70c344c2ee0cfd9af9e809b011793d1` |
| `0059_v1_income_statement_and_balance_sheet` | `eb19c9c96526edbb9a6563d1e4422ae460cd04f9160b40c41fa745a784b34d0f` |

Each slice was validated at its exact commit, in order. Preserved production stays at 0056 until the owner authorizes these.

## Validation

| Check | 0057 | 0058 | 0059 |
|---|---|---|---|
| Full integration | 356 of 356 | 372 of 372 | 386 of 386 |
| Unit | 176 of 176 | 176 of 176 | 176 of 176 |
| Typecheck and lint | Clean | Clean | Clean |
| Mocked browser (`next dev`) | 122 passed, 15 skipped | 132 passed, 15 skipped | 141 passed, 15 skipped |
| Database-backed browser | 135 passed, 2 skipped | 145 passed, 2 skipped | 154 passed, 2 skipped |
| Smoke on `next start` | 16 of 16 | 18 of 18 | 20 of 20 |
| Mocked browser on `next start` | 114 passed, 15 skipped | 124 passed, 15 skipped | 133 passed, 15 skipped |
| First-run and operational E2E on `next start` | 3 of 3, twice | 3 of 3, twice | 3 of 3, twice |
| Restart cycles | 5, identical | 5, identical | 5, identical |
| Disconnect targets recovered | 74 of 74 | 78 of 78 | 82 of 82 |
| Upgrade from production at 0056 | Clean | Clean | Clean |

Upgrade proof, on a restored copy of production: the real runner applied only the expected migrations, a second run applied nothing, only `schema_migrations` changed among the 99 tables, journals stayed at 0, and no function became public. After 0059 there are 143 SECURITY DEFINER functions, up from 138.

The 15 mocked skips are 13 tests that need a database, which ran in the database-backed suite, and the 2 below. On `next start`, the `capital-bridge-review` and `shareholder-finance-capability` specs are excluded because they test a dev-only review server that production correctly refuses. The 2 database-backed skips need a dedicated password fixture for direct capital, which these slices did not change; the same flow passes in the operational E2E and integration.

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
