# V1 reporting, trial balance and financial statements (Slice 7) — design

Status: design, written from trunk `dd5464d` (production runs the final 0051 at `8783298`). It was audited against a production-shaped database at 0051. It precedes any Slice 7 migration.

Governing principle (owner instruction of 2026-10-31): every financial report derives from the same accounting truth, posted journals, their lines and their approved dimensions and subledgers. Source confidentiality may hide source detail; it never changes an account's balance.

## 1. Audit of the current reporting foundation

| Primitive (current definition) | What it does | Verdict |
|---|---|---|
| `ledger_account_balances(entity, from, to)` (0020, restated 0045) | Per account: Σ base debit, Σ base credit and net over POSTED journals in a date range. No actor, no scope filter. Called by no function today | **Correct math; reuse** as the basis of the trial-balance primitive |
| `finance_gl_visible_lines(entity, actor, from, to, account)` (0024) | Posted lines in a range, **excluding** lines whose project, department or cost centre is outside the reader's scope | **Defect against the governing principle.** Totals change with the reader. Retire it; the GL page and activity move to the new primitive, which masks detail and never excludes money |
| `finance_general_ledger_page` / `finance_general_ledger_activity` (0024) | Paged lines, and per-account debit/credit activity in a range, both over `finance_gl_visible_lines`. Authorised through `finance_runtime_authorize` with the operational bearer context. `isBalance = false`, no opening balance | Restate them over the new primitive: restricted lines included and masked, totals unchanged by scope |
| `finance_general_ledger` (0020/0032) | Older unpaged variant of the same logic (the same scope exclusion, inline) | Duplicate: not used by the web layer (it calls `_page` and `_activity`). Retire in place (no runtime grant) when 0052 restates the GL |
| GL `?journalId=` drill-down | The direct-capital screen links `/finance/general-ledger?journalId=…`, but neither the API nor the page reads `journalId`: the person lands on the whole ledger | **Weakness to fix.** Add a journal detail read: header, lines, source, reversal links. The GL page opens it for `?journalId=` |
| GL source column | Shows `sourceType · sourceId` as raw text, with no link to the business record | Replace with a source link where the reader may see the source module |
| `treasury_account_balances` (0045, restated 0050) | Per Treasury account: opening (opening-balance movements net of their reversals), inflows, outflows and book, in the **native** currency, from posted `OPERATIONAL_TREASURY` subledger entries | Correct; reuse for Safe and Saraf statements. Native is primary |
| `treasury_account_movements` (0045) | A Treasury account's posted movements, native amount, with the reference **masked, not excluded**, outside scope | Correct pattern (the model for every masked report); extend with base amount, rate, source and counterparty |
| `shareholder_capital_balances(entity)` (0029/0040) | Per shareholder party and currency: posted capital from the `SHAREHOLDER_CAPITAL` subledger | Correct; reuse for the shareholder statement (equity) |
| Shareholder loans | Posted through TEMPORARY_FUNDING / TEMPORARY_FUNDING_SETTLEMENT with the `TEMPORARY_FUNDING_PAYABLE` subledger, per party (0037). Legacy `SHAREHOLDER_LOAN` subledger type exists but no active source posts it | Loan statement = the `TEMPORARY_FUNDING_PAYABLE` subledger per party |
| Daily Report `operational_finance_daily_report` (0029, restated 0050) | Expenses per category and currency **from the expense module** (`operational_expense_effects`), filtered to the reader's scope; Treasury movements of the day from `treasury_account_balances` | An operational expense register, not a ledger report. Keep it as the register. The new Period Summary and Income Statement never derive from it |
| Transaction register (`/finance/transactions`) | Expenses recorded in a date range (expense module) | Register; keep as is |
| FX (0051) | Native amount and currency, accounting amount and snapshot reference on every line; `fx_conversions` holds the policy version, rounding and residual | Reuse; reports read conversions by `conversion_snapshot_reference` |
| Periods (0040/0050) | `accounting_periods` (PENDING, OPEN, CLOSED, with an event history) inside `fiscal_years` (`GREGORIAN`, `SOLAR_HIJRI` or `CUSTOM`); periods store Gregorian dates and English and Dari names | Reports select by period, range or as-of date. Period status is displayed but never changes the arithmetic |
| Calendar | Dates are stored as Gregorian dates; `@abos/calendar` formats Gregorian and Solar Hijri, and Dari digits | Reports return ISO dates and the UI shows both calendars (`formatDual`) |
| Reversals (0050) | A reversal is its own posted journal (source `REVERSAL`) with an immutable `journal_reversal_links` row | Ledger reports show both; summaries net naturally; history marks the original "reversed" through the link |
| Opening balances (0046) | A posted OPENING_BALANCE journal (Dr Safe / Cr opening balance equity) | It is ledger activity like any other. A trial-balance opening is all posted activity before the start date, never the source table |
| Dimensions | Lines carry `project_id`, `department_id` and `cost_center_id`; readers hold `user_scope_grants` per kind | Used to mask detail per line, never to remove amounts |
| Indexes | `journal_lines(ledger_account_id, journal_id)`, `journals(accounting_period_id, status)`. No index on `journals(legal_entity_id, accounting_effective_date)` or on the Treasury account of `subledger_entries` | Production has 0 journals. Measure plans with synthetic volume (section 13) and add an index only on evidence |

## 2. Is the Chart of Accounts classification sufficient?

`ledger_accounts.account_type` is constrained to `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE` and `EXPENSE`. Every posting account has exactly one type and one currency, and `parent_ledger_account_id` gives a hierarchy.

- **Trial balance:** sufficient. It needs only debit and credit truth per account.
- **Income statement:** sufficient. Revenue (`REVENUE`) minus expenses (`EXPENSE`), grouped by parent account.
- **Balance sheet:** sufficient. Assets (`ASSET`) = liabilities (`LIABILITY`) + equity (`EQUITY`) + current earnings, where current earnings = Σ REVENUE − Σ EXPENSE up to the date, because no year-end closing entry exists yet.
  - Shareholder capital (control `SHAREHOLDER_CAPITAL`) is equity.
  - Shareholder loans (control `TEMPORARY_FUNDING_PAYABLE` / `SHAREHOLDER_LOAN`) are liabilities.
  - Opening balance equity (control `OPENING_BALANCE_EQUITY`) stays visible in equity.
- **Finer presentation sections** (current vs non-current, operating vs other) do not exist. V1 statements present by account type and parent account, which is a correct statement without them.
  - A `statement_section` attribute can be added later without changing the arithmetic.
  - This is not a prerequisite and not an owner decision.

## 3. Trial balance mathematics

Inputs: legal entity, from the session. The range is one of:
- an accounting period: from = `starts_on`, to = `ends_on`;
- a date range;
- an as-of date: to = the date, from = the start of the fiscal year containing it, which gives year-to-date activity.

For each ledger account `a`, over POSTED journals of the entity only (base currency):
- `opening_net(a) = Σ base_debit − Σ base_credit` of lines dated **before** `from`;
- `period_debit(a) = Σ base_debit` and `period_credit(a) = Σ base_credit` of lines dated `from` to `to`, gross, never netted;
- `ending_net(a) = opening_net(a) + period_debit(a) − period_credit(a)`;
- each net balance is shown on its natural side:
  - **debit column** = the net if it is positive;
  - **credit column** = −net if the net is negative;
  - zero shows on neither side.

**Totals:**
- Σ opening debit = Σ opening credit;
- Σ period debit = Σ period credit;
- Σ ending debit = Σ ending credit.

These equalities follow from every journal balancing (the kernel guarantees debits = credits per journal). The report returns the totals and `balanced`. It also reports any unbalanced posted journal as an integrity failure, which must be 0.

**Which accounts appear:** every account with activity or a non-zero balance, plus, on request, every account. Each account appears once, in the accounting currency.

**Native detail:** for an account whose lines carry another original currency, the report gives per original currency the period native debit and credit and the ending native net. It is information only; it never enters the base totals.

**Inactive accounts with a balance** still appear: status never hides money.

**Period status** (OPEN or CLOSED) is shown, never used in the arithmetic: a closed month reports the same numbers forever.

## 4. Opening balances

- A trial-balance or statement opening figure is **all posted activity before the start date**, of every source.
- An OPENING_BALANCE journal is one such source: it appears as ordinary period activity in the month it is dated, and in later months' openings.
- A reversed opening balance contributes its original and its reversal, so the net is 0.
- Opening balance equity is an ordinary EQUITY account in the trial balance.

## 5. Reversals

| Report | Treatment |
|---|---|
| Trial balance, income statement, balance sheet, period summary | Arithmetic only: the original and the reversal are both posted lines and net naturally, each on its own date |
| Account and Safe statements, general ledger | Both lines appear. The original is marked "reversed by RV-…" and the reversal "reverses …", through `journal_reversal_links` |
| Journal detail | Shows its reversal link in either direction |
| Period summary counts | Show reversals as their own line ("reversals"), in addition to their netting effect |

A reversal is never hidden and the original is never removed.

## 6. FX presentation

**Accounting reports** (trial balance, income statement, balance sheet, account statement balances) are in the accounting currency (USD).

**Native detail per line** (account statement, journal detail, Safe statement):
- native amount and currency;
- the accounting amount;
- the frozen rate: `exchange_rate_snapshots` through `conversion_snapshot_reference`, with the rate date, source and quote convention;
- the FX policy version, rounding mode and residual, from `fx_conversions`.

**Safe and Saraf statements** are in the native currency, which is primary. The accounting-currency amount is a secondary column. A Safe balance is never collapsed into USD.

No revaluation, settlement difference or cross-currency exchange is computed.

## 7. Transfers

- A TREASURY_TRANSFER journal debits one Treasury account and credits another, both ASSET.
- In the **trial balance** and **balance sheet** a transfer changes two asset accounts and nets to 0; it needs no special treatment.
- In the **period summary**, company-wide money in and money out exclude movements whose source is TREASURY_TRANSFER, which are shown separately as "transfers between accounts". The same applies to their reversals: a reversal whose original is a transfer is reported as a transfer reversal.
- In a **Safe statement** a transfer is a real movement of that Safe (in or out), labelled "Transfer to / from {account}".

## 8. Security and scoping model

- **Authority.** New entry points are `SECURITY DEFINER` functions owned by `abos_v1_operational_finance_owner`. The session comes from `operational_finance_actor`, which refuses synthetic sessions. The permission is `finance.report.operational.read`, and `treasury.safe.read` or a Safe responsibility for Safe statements.
- **Company.** Always the session's legal entity; another company's account, journal or Safe is "not found".
- **Arithmetic** never depends on the reader. The primitives take no actor.
- **Line detail** (journal reference, description, source, counterparty) is masked when the line carries a project, department or cost centre outside the reader's scope. The masked line keeps its date and amount and is labelled "Restricted movement".
- **Source detail** (counterparty names, shareholder names) is shown only with the source module's read permission:
  - shareholder sources need `shareholder.read` or `shareholder.capital-receipt.read`;
  - temporary funding needs `finance.temporary-funding.read`.
  - Without it, the line shows a generic description such as "Capital received", "Funding received" or "Expense". The amount is never hidden.
- **Example.** A cashier who reads Safe A but not shareholders sees the capital deposit as "Capital received", with its amount in the Safe balance.

## 9. Proposed database functions (all `STABLE`, exact numeric)

**Internal primitives** (caller's rights, executable only by the operational Finance owner):
- `report_account_balances(entity, from, to)`: per account, `opening_debit`, `opening_credit` (gross, before `from`), `period_debit`, `period_credit`, with the native-currency breakdown. It supersedes the unused `ledger_account_balances`, which stays for compatibility.
- `report_line_visible(entity, actor, project, department, cost_center)`: the one scope test (a boolean) used to mask detail.
- `report_journal_source(entity, actor, journal)`: the business source of a journal (type, id, label, route), masked when the source module is not readable.
- `report_range(entity, period, from, to, as_of)`: resolves the range, the fiscal year, period names and statuses.

**Entry points** (runtime-executable `SECURITY DEFINER`):
1. `finance_trial_balance(proof, runtime, token, payload)`: payload `{periodId | from,to | asOf, includeZero}`.
2. `finance_account_statement(proof, runtime, token, payload)`: payload `{accountId, periodId | from,to}`. Returns the opening, lines in order with a running balance, masked detail, source and reversal links, and the closing.
3. `finance_journal_detail(proof, runtime, token, journalId)`: the journal header, lines with native and FX detail, the source and reversal links. It fixes the `?journalId=` weakness.
4. `treasury_account_statement`: native opening, movements with base amount and frozen rate, counterparty, journal, and native closing.
5. `finance_shareholder_statement`: capital (contributed, reversals, effective, optional agreed total) and loans (received, repaid, outstanding), per shareholder.
6. `finance_period_summary`: Treasury opening and closing (native per currency, and base); money in by kind; transfers separately; reversals; income, expenses and profit; the period status.
7. `finance_income_statement`: REVENUE and EXPENSE by parent account for the range, with year-to-date.
8. `finance_balance_sheet`: ASSET, LIABILITY and EQUITY plus current earnings as of a date, with a `balanced` check and the Treasury reconciliation (each Safe's book in base equals its ledger account's balance).

The GL page and activity are restated over the masked primitive (`finance_gl_visible_lines` is retired). Their totals then equal the trial balance's period columns for every reader.

## 10. Screens and routes

Finance → Accounting navigation:
- Trial Balance (`/finance/trial-balance`)
- General Ledger (`/finance/general-ledger`, with `?journalId=` opening the journal detail)
- Account Statement (`/finance/account-statement?accountId=`)
- Safes & Saraf (the statement on each Safe card)
- Shareholders (the statement)
- Income Statement (`/finance/income-statement`)
- Balance Sheet (`/finance/balance-sheet`)
- Period Summary (`/finance/period-summary`)

Filters: period, from/to date, account, currency where relevant, Safe or Saraf, shareholder. English and Dari, right-to-left, dual dates, and a print stylesheet. PDF and Excel export are not in this slice.

## 11. Migration plan

- **0053:** the shared primitives, the trial balance, the account statement, the journal detail, and the GL restated over the masked primitive (fixing the scope-exclusion defect and the `journalId` drill-down). Reporting permission wiring in `operational_finance_actor`.
- **0053:** the Safe and Saraf statement, shareholder statement, period summary, income statement and balance sheet over the same primitives.

Each migration only adds or restates read functions: no table, no row and no backfill. Each has its own checksum, fresh-install run, production-shaped upgrade proof and report.

## 12. Test plan (PostgreSQL integration, then browser)

**Scenarios on one synthetic company:**
- a zero-journal company (all reports empty and balanced);
- an opening balance, capital receipt, loan (temporary funding) and its settlement;
- a cash receipt, expense, payment and transfer;
- a reversal, including of an opening balance;
- an AFN receipt and an AFN expense (native and base);
- Safe and Saraf native balances, including a negative Saraf.

**Properties:**
- Σ debit = Σ credit (opening, period and ending);
- the trial balance ending = the opening of the next period;
- period boundaries (the last day in, the next day out);
- a closed period reports identically before and after closing;
- the GL activity totals equal the trial-balance period columns;
- the account statement closing equals the trial-balance ending;
- each Safe's book in base equals its ledger account's trial-balance net;
- the balance sheet balances; the income statement equals the classified ledger activity.

**Security:**
- cross-company denial; synthetic-session denial;
- a scope-restricted reader gets identical totals with masked detail;
- a source-permission-restricted reader (cashier without shareholder read) gets the Safe balance including capital, under a generic description.

**Performance:** `EXPLAIN (ANALYZE)` of the trial balance and the account statement at 50,000 synthetic lines on a disposable database, recorded in the report.

**Then:** fresh install, production-shaped upgrade, full integration, unit, typecheck, lint, build, smoke and browser (mocked UI specs for each screen).

## 13. Performance

- Production has 0 journals.
- The trial balance is one grouped scan of `journal_lines ⨝ journals` per entity and range. The account statement uses `journal_lines(ledger_account_id, journal_id)`.
- Plans are measured with synthetic volume before any index is added. If one is needed, the candidate is `journals(legal_entity_id, status, accounting_effective_date)`.
- No cached totals, no materialized balances; every figure is recomputed from posted lines.

## 14. Owner decisions

**None is required to start.** Classification is sufficient (section 2). Masking rather than excluding follows the owner's governing principle. Fixing the GL scope exclusion is a correction to that principle, not a new decision.

Notes for the owner:
- The balance sheet shows unclosed "current earnings" in equity until a year-end close process exists. That process is future work and does not affect V1 correctness.
- After 0053 a scope-restricted reader of the General Ledger sees the company's true totals, with restricted lines masked; before, those lines were left out.
