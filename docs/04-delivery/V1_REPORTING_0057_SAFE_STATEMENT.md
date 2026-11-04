# V1 reporting 0057: Safe and Saraf statement

Migration `0057_v1_safe_saraf_statement`. It adds read functions and one index. It adds no table, no row and no journal. Not deployed to preserved production: that needs separate owner authorization.

## 1. Audit of the reporting foundation

Read from the final catalogue of a restored production database at 0056.

| Area | How it derives today | Finding |
|---|---|---|
| Trial Balance | `report_account_balances`: posted journal lines only, no reader in the arithmetic | Correct; stays the foundation |
| Account Statement | Opening and lines from posted journal lines | Correct arithmetic; reference and source leaked (below) |
| General Ledger | Posted lines, restricted lines masked (0053) | Correct arithmetic; returned raw `sourceId` and reference to any report reader |
| Safe balances | `treasury_account_balances`: posted `OPERATIONAL_TREASURY` entries, native currency | Correct; the statement's opening and closing use it |
| Accounting value of a Safe | An inline sum in `treasury_safes_workspace` | Duplicate maths; now `treasury_account_base_balance` |
| Scope test | `report_line_visible`, plus an inline copy in `treasury_account_movements` | Duplicate; the copy is retired |
| Shareholder capital | `shareholder_capital_balances`, from the `SHAREHOLDER_CAPITAL` subledger | Correct; reused in 0058 |
| Shareholder loans | `TEMPORARY_FUNDING_PAYABLE` subledger per party | Correct; reused in 0058 |
| FX | Native amount on the line and subledger; rate in `exchange_rate_snapshots`; policy, rounding and exact amount in `fx_conversions` | Correct; nothing is revalued. The policy version is empty when no explicit policy existed at posting |
| Reversals | A separate posted journal plus an immutable `journal_reversal_links` row; Treasury movements are inverted exactly | Correct; both movements appear and net naturally |
| Opening balances | An ordinary posted `OPENING_BALANCE` journal | Correct; a report's opening is all posted activity before its start |
| Financial-year filtering | `report_range`; year status is displayed, never used in arithmetic | Correct; reused |

### Confidentiality defects found and fixed

1. **Journal references embed the source record's id.** `CAP-`, `RC-`, `PY-`, `TR-`, `OB-` and `TFS-` references end in the source UUID. Anyone shown the reference received the source id.
2. **`report_journal_source` gated only capital and funding.** Expense, receipt, payment and transfer sources gave their id, link and counterparty to any report reader.
3. **The General Ledger page returned `sourceId`.**
4. **The reversal list fix of 2026-11-04 was incomplete.** It removed source fields but left the capital reference, which carries the receipt id.

The fix is one rule in the primitives:

- `report_source_readable` names the permission for each source type and fails closed for any source it does not name.
- `report_journal_reference` gives a reader without that permission a neutral `JRN-` reference built from the journal id.
- The Account Statement, journal detail, reversal list, Safes page and General Ledger all use them.

**Behaviour change:** a report-only reader no longer sees payer, payee, expense id or business references. They still see every amount, date and generic label.

| Source | Permission that opens it |
|---|---|
| Direct shareholder capital | `shareholder.read` or `shareholder.capital-receipt.read` |
| Temporary funding and its settlement | `finance.temporary-funding.read` |
| Expense | `finance.expense.read` |
| Cash receipt, payment, transfer, opening balance | `treasury.safe.read`, or responsibility for that Safe on its statement |
| Reversal | Any reader of the report; its reference names only the reversal. The reference of what it reverses follows that source's rule |

## 2. The statement

`treasury_account_statement(proof, runtime, token, payload)`, screen `/finance/safe-statement`, API `/api/v1/finance/safe-statement`.

- **Access:** `treasury.safe.read` or `finance.report.operational.read` opens every account. A person responsible for a Safe opens that Safe only. Another account is reported exactly like one that does not exist.
- **Balance:** native currency. Opening and closing come from `treasury_account_balances`, not a new sum.
- **Accounting value:** secondary, labelled as such, from the amount frozen at posting. It is never called the Safe balance.
- **Saraf:** negative balances are kept and explained as an amount owed.
- **Transfers:** money out of one account, money in to the other, `kind` = `TRANSFER`. `report_effective_source_type` keeps the reversal of a transfer internal too, so 0058 can exclude both from company money in and out.
- **Reversals:** both movements appear, the original marked and the reversal linked, with the running balance through both.
- **Reconciliation:** every statement compares its accounting value with the ledger account and shows the result.
- **Limit:** 5,000 lines per statement, then the reader is asked for a shorter period, as on the Account Statement.

## 3. Performance

Measured on a disposable production copy with 25,000 posted journals, 50,000 lines and 25,000 Treasury entries across 8 Safes.

| Query | Without index | With index |
|---|---|---|
| `treasury_account_balances`, one Safe | 100 ms | 21 ms |
| Statement, one Safe, one month | 333 ms | about 200 ms |
| Statement, one Safe, full year (3,125 lines) | 1.39 s | 1.36 s |

The partial index `subledger_entries_operational_treasury_account_idx` was added on this evidence, because the balance function also runs for every Safe on the Safes page. The full-year time is mostly per-line masking. There is no cached or materialized balance.

## 4. Print

Reports now print without the navigation, filters and footer. This also repairs the existing Trial Balance Print button.

## 5. Not in this slice

The company-wide summary of money in and out is 0058. The statement provides the `kind` and totals it needs.
