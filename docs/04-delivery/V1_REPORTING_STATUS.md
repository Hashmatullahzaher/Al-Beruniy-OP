# V1 reporting status

All reports derive from posted journals and their lines, through shared primitives. There is no balance table and no report totals table.

| Report | Status | Migration | Where |
|---|---|---|---|
| Trial Balance | Done | 0053 | `/finance/trial-balance` |
| General Ledger | Done | 0053, masking in 0057 | `/finance/general-ledger` |
| Account Statement | Done | 0053, 0055, masking in 0057 | `/finance/account-statement` |
| Safe / Saraf Statement | Done, deployed | 0057 | `/finance/safe-statement` |
| Shareholder Statement | Done, deployed | 0058 | `/finance/shareholder-statement` |
| Financial Summary | Done, deployed | 0058 | `/finance/financial-summary` |
| Income Statement | Done, deployed | 0059 | `/finance/income-statement` |
| Balance Sheet | Done, deployed | 0059 | `/finance/balance-sheet` |

0057, 0058 and the final 0059 were deployed on 2026-11-05 from `a4cefdd7bd3400bc0e1687e0c1330a0f49a00e76`, and 0060 the same day from `84922b13c5fdfec1a1e0f8f155a069156caf7cce`. See `V1_REPORTING_DEPLOYMENT_2026-11-05.md`.

## Migrations

| Migration | Checksum |
|---|---|
| `0057_v1_safe_saraf_statement` | `cb8512702e6ae1141e961d7f30b43855200feeae938fb60f8eadbde0245bae1e` |
| `0058_v1_shareholder_statement_and_summary` | `71ad6d017c95db75842196e09370d05de70c344c2ee0cfd9af9e809b011793d1` |
| `0059_v1_income_statement_and_balance_sheet` | `0c5a6c379a1380d0516b23f4eff6d838b5fe53aa5b03f07dc3efc6e7ac41f9c7` |
| `0060_v1_reversal_confidentiality` | `e1142a9451f8da44301fb22e5806ed1a9ba5d893865ccc11a1081d4f1d0ba6fe` |

Each slice was validated at its exact commit, in order. 0059 was amended before deployment for the owner's Saraf decision, which replaced its earlier checksum `eb19c9c96526edbb9a6563d1e4422ae460cd04f9160b40c41fa745a784b34d0f`. That checksum is superseded and must not be used. The owner authorized deployment on 2026-11-05.

## Validation

The table records each slice as first merged. The final 0059 was validated again after the amendment; see the deployment record.

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

The 15 mocked skips are 13 tests that need a database, which ran in the database-backed suite, and the 2 below. On `next start`, the `capital-bridge-review` and `shareholder-finance-capability` specs are excluded because they test a dev-only review server that production correctly refuses. The 2 database-backed skips are `direct-shareholder-capital-operational`, which needs its own disposable database and password fixture. `packages/e1-integration/scripts/direct-capital-preview.ts` builds that fixture, and since 2026-11-05 both tests run as their own step of every validation run.

## Delivery records

- `V1_REPORTING_0057_SAFE_STATEMENT.md`, which also holds the audit of the reporting foundation
- `V1_REPORTING_0058_SHAREHOLDER_AND_SUMMARY.md`
- `V1_REPORTING_0059_FINANCIAL_STATEMENTS.md`
- `V1_REPORTING_0060_REVERSAL_CONFIDENTIALITY.md`
- `docs/03-architecture/V1_CHART_OF_ACCOUNTS_CLASSIFICATION_AUDIT.md`

## Owner decisions (final, 2026-11-05)

1. **Retained earnings: derive it.** No year-end closing journal is posted. The Balance Sheet derives "Result of earlier years" and "Result of the current year" from posted activity. Revisit before the first statutory filing.
2. **Current and non-current, operating and other: stay with the present structure.** No `statement_section` for now. Add it only if an auditor, lender or reporting requirement needs classified presentation.
3. **A negative ASSET-type Saraf: present it as a liability on the Balance Sheet.** Presentation only. No journal is posted, and the Trial Balance, General Ledger, Safe / Saraf Statement and Financial Summary keep the real negative balance. See `V1_REPORTING_0059_FINANCIAL_STATEMENTS.md`.

## Known debt

- The operational E2E can stall under `next dev` on a machine short of memory. See "The `next dev` stall" in `V1_REPORTING_DEPLOYMENT_2026-11-05.md`. Treat the database-backed suite on a production build as the gate.
- Loans moved to their own lane in 0061 and 0062 (`V1_LOANS_0061_0062.md`), with realized FX on settlement in 0063 (`V1_LOAN_REALIZED_FX_0063.md`), not yet deployed. Legacy temporary funding keeps its behaviour and still cannot be reversed.
- PDF and Excel export are not built. Reports print cleanly.
- `ledger_account_balances` and `finance_general_ledger` are unused older functions, kept because applied migrations are not rewritten.
- `/finance/capital-bridge-review` shows signed-out visitors an error page instead of "not found". It exposes no data.
