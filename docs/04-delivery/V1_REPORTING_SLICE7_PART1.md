# Slice 7 part 1 — trial balance, account statement and journal detail (migration 0053)

Status: IMPLEMENTED as migration **0053**, on top of the deployed 0052 (Financial Year Close). It was built as 0052 before the owner correction and renumbered and rebased without rebuilding. Validated on disposable databases; deployment follows the owner's conditional authorization of 2026-10-31 once every check is green.
Design: `docs/03-architecture/V1_REPORTING_AND_FINANCIAL_STATEMENTS_DESIGN.md`. The design audit found no genuine owner decision, so implementation proceeded directly (owner instruction of 2026-10-31).

## 1. Definition of done

| Requirement | Where it is proven |
|---|---|
| Trial balance by period, date range or as-of date (year to date) | `reporting-trial-balance.test.ts` (empty company; ledger truth; boundaries); `v1-trial-balance.spec.ts` |
| Per account: opening, period and ending debit and credit kept apart, never one signed number. Totals prove debits = credits, and integrity requires no unbalanced posted journal | ledger-truth test: every account equals the posted lines; all three total pairs balance |
| An opening is all posted activity before the start, never the opening-balance table | boundaries test: September's ending = October's opening; the opening-balance journal appears as September activity and opening balance equity stays visible |
| Reversals act through their own posted journals | the reversed payment shows 100 debit and 100 credit and nets to 0; the statement links the original and the reversal both ways |
| Closing the financial year never changes its report | boundaries test: September is identical before and after the 0052 year close; the range then reports the year as closed. Months carry no close state in any report |
| USD totals with native AFN detail | ledger-truth test: the AFN Safe shows 80.00 USD with native AFN 5,600.00 |
| Account statement: opening, lines, running balance, closing, source and journal links | account-statement test: the running balance and the closing equal the trial balance; October opens with September's closing |
| Journal drill-down (`?journalId=` was ignored before) | journal detail: source, frozen FX rate and policy, and reversal links in both directions; `v1-trial-balance.spec.ts` opens a journal from the General Ledger |
| Source confidentiality hides detail, never money | scope test: a restricted reader's trial balance is identical, the restricted line is masked, and GL activity totals equal the trial balance. Source-permission test: a reader without shareholder permission sees "Capital received", without the shareholder, inside the Safe balance |
| Cross-company, synthetic-session and permission denial; reports never write | denial test |

## 2. What changed (0053)

**Primitives** (internal, executable only by the operational Finance owner):
- `report_line_visible`
- `report_account_balances`: arithmetic only, with no reader
- `report_native_balances`
- `report_range`
- `report_journal_source`

**Entry points:** `finance_trial_balance`, `finance_account_statement` and `finance_journal_detail`, all under the permission `finance.report.operational.read`.

**General Ledger** (`finance_gl_visible_lines`, the page, the activity and the older `finance_general_ledger`):
- every posted line is now kept in the pages and totals;
- a line outside the reader's project, department or cost-centre scope keeps its date, account and amounts;
- its reference and source are masked (`restricted`).

Before 0053 such lines were left out, so a restricted reader saw different totals; that contradicted the governing principle.

**Screens:**
- Trial balance (`/finance/trial-balance`, in the navigation);
- Account statement (`/finance/account-statement`, from each trial-balance account);
- the journal panel on the General Ledger (`?journalId=`).

All screens show dual dates and support English, Dari and right-to-left layout, with printing.

**Grants:** column-level read of the account parent and the financial-year fields for the Finance owner. No table, row, journal or backfill.

## 3. Behaviour changes to note

- The General Ledger now shows restricted lines (masked) and the company's true totals to every reader with the report permission.
- An as-of date with no financial year covering it starts the calendar year.

## 4. Performance (measured, not assumed)

**Method.** A disposable copy of the post-0051 production database, with the reporting migration (now 0053) applied, was loaded with 25,000 balanced posted journals: 50,000 lines across 20 accounts, every day of 2026. Constraints and triggers were bypassed on that copy only, for the load. The figures are `EXPLAIN (ANALYZE, BUFFERS)` measurements on the test container (1 GB):

| Query | Plan | Time |
|---|---|---|
| Trial-balance arithmetic for September (opening + period per account) | hash join, sequential scan of both tables, grouped by account | 42 ms (32 ms as the function call) |
| The same, full year | — | 37 ms |
| Native-currency detail, full year | — | 12 ms |
| Integrity check (no unbalanced posted journal) | hash join + group per journal | 79 ms |
| Account statement opening (one account) | bitmap scan on `journal_lines_account_idx` | 10 ms |
| Account statement lines and running balance (one account, September) | bitmap scan on `journal_lines_account_idx`, sort by (date, posting time, journal, line) | 6 ms |
| General Ledger masked lines (September, 4,080 lines) | — | 24 ms |

**Conclusion.** No cache, materialized balance or new index is needed: every report is recomputed from posted lines in well under a second at this volume. The journals scans are sequential because 75% of journals fall inside the filter. The candidate index for a much larger ledger is `journals(legal_entity_id, status, accounting_effective_date)`, to be added only on measured need.

**Query shape fixes made during the review:**
- the trial balance computes the native-currency detail once (a materialized CTE), not once per account;
- the account statement computes its opening from its own account's lines through the account index, not from the whole company's ledger.

## 5. Chart of Accounts classification (design conclusion)

`ledger_accounts.account_type` is a constrained column with exactly the five values `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE` (income) and `EXPENSE`. Every account has exactly one type (NOT NULL, CHECK-enforced), and the type of a control account is enforced by `coa_validate`.

The model therefore reliably distinguishes asset, liability, equity, income and expense without reading codes or names. That is sufficient for a correct:
- **income statement:** REVENUE − EXPENSE over a range;
- **balance sheet:** ASSET = LIABILITY + EQUITY + unclosed current earnings, with shareholder capital in equity, shareholder loans in liabilities and opening balance equity visible.

Finer presentation sections (current vs non-current) are not present. They are not needed for correctness and can be added later without changing the arithmetic. No classification fix is required before the statements.

## 6. Validation (rebased onto the deployed 0052)

| Check | Result |
|---|---|
| Renumbering | The work was built as 0052, then renumbered 0053 and replayed on trunk after the deployed 0052 Financial Year Close. Only shared lists conflicted: the registry, the upgrade lists, the security inventory and the authenticator. It was not rebuilt. The functions 0053 restates do not overlap any function 0052 restated, so 0053 cannot undo 0052 |
| Year semantics | Report months carry no close state. The range reports whether its financial year is closed (`fiscalYear.closed`). The trial-balance hint says the financial year is still active, never that a month is open |
| PostgreSQL suites | reporting-trial-balance 7/7 (closing the financial year leaves September identical), general-ledger-activity, security-ownership (scope masks detail and never removes lines: 2 lines always; 0 → 2 → 0 lines with detail as scope is granted and revoked), financial-year-close, and both upgrade suites: 30/30 |
| Full integration on a fresh install | see the 0053 entry of the session record |
| Production-shaped upgrade (post-0052 production dump → 0053 + 0054, repository runner) | Applied exactly `0053_v1_reporting_trial_balance` and `0054_v1_financial_year_preview_warnings`; the rerun applied nothing. 99 tables before and after; 98 byte-identical; only `schema_migrations` changed (51 → 53). The runtime can call the three report entry points and none of the primitives; 137 SECURITY DEFINER functions |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser (mocked) | 85 passed and 14 skipped (database-backed, opt-in) at 4 workers, with 1 shell skip-link focus flake under load that passes alone (shell, trial balance and financial year 17/17) |
| Performance | Measured on 50,000 lines (§4). The report queries are unchanged by the renumbering. The range adds one read of the year's `closed_at`, and the journal guard of 0052 acts only on inserts and updates |
