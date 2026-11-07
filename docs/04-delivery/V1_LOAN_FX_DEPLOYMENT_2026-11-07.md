# V1 loan and foreign-currency Treasury deployment, 2026-11-07

Owner-authorized deployment of `0061 -> 0062 -> 0063 -> 0064` to preserved production, from trunk `176ae30522788e2211c51a8642b468991875e01b`. 0065 was not authorized and is not deployed. Production was deliberately not repinned to the later trunk, which holds 0065.

## Result

| Check | Before | After |
|---|---|---|
| Runtime | `84922b13c5fdfec1a1e0f8f155a069156caf7cce` | `176ae30522788e2211c51a8642b468991875e01b` |
| Latest migration | 0060 | 0064 |
| Migrations | 59 | 63 |
| Tables | 99 | 101 |
| Journals, lines, subledger entries | 0, 0, 0 | 0, 0, 0 |
| Loans, loan repayments | no table | 0, 0 |
| Safe balance (USD): opening, in, out, book | 0, 0, 0, 0 | 0, 0, 0, 0 |
| FY 2026 | Open | Open |
| Definers | 143 | 150 |
| PUBLIC execute on definers | 0 | 0 |
| Runtime table writes | 0 | 0 |
| Functions | 364 | 394, one signature replaced (`posting_kernel_draft`) |
| Vault reconciliation | Clean | Clean |
| `documents`, `document_links`, 0065 in the register | absent | absent |

The web app was down for about 40 seconds. No posted financial history exists, and none was changed.

## Migrations

| Migration | SHA-256 |
|---|---|
| `0061_v1_loan_model_and_lanes` | `fd98ffe2058b6c98e5f628721b5bc1bb6d17edb7393e16bd7e4f29aa6efbd8c4` |
| `0062_v1_loan_reporting` | `a6f2e4f549cff0b5c09e047fecb2ac332860198e0fa3bab476e678a5bf73bd32` |
| `0063_v1_realized_fx_loan_settlement` | `41b93e06ad2c8c8c7bbd5606d3fbfdd14066ca47bbf164e4c21346df2a5c56a4` |
| `0064_v1_fx_treasury_carrying_value` | `b9cbc161e67ecedf39892bb81a80687223422a854371acb0a9eafec28207211c` |

The live register holds these exact checksums. Predecessor `0060_v1_reversal_confidentiality` is `e1142a9451f8da44301fb22e5806ed1a9ba5d893865ccc11a1081d4f1d0ba6fe`.

## Backups

| Item | Value |
|---|---|
| Fresh pre-deployment dump | SHA-256 `55ff4700af7e01d76c202d4d9072d82d5d072253c7b147e981b461bcb582c116`, 2,375,461 bytes |
| Test restore of that dump | 99 of 99 table fingerprints identical to production |
| Production against the earlier seal | 99 of 99 table fingerprints identical |
| Post-deployment dump | SHA-256 `fc45afafaf264b424352658f58f6bde2af58a43868c750772fdc1293e3f8498e`, 2,517,810 bytes |

## What changed in the rows

Among the existing tables, only these changed:

- `permission_catalogue`: 56 to 60, adding the four loan permissions
- `finance_workflow_types`: 11 to 12, adding `LOAN`
- `posting_sources`: adding `LOAN_RECEIPT` and `LOAN_REPAYMENT`
- `schema_migrations`: four rows

`loans` and `loan_repayments` are new and empty. No permission was granted and no account was created.

## Protected rehearsal on the fresh dump

| Check | Result |
|---|---|
| Runner | Applied exactly 4; second run applied 0 |
| Smoke on `next start` | 20 of 20 |
| Mocked browser on `next start` | 155 passed, 15 skipped |
| Operational E2E on `next start` | 3 of 3, twice |
| Refusal gates | 12 of 12 |
| Database rollback on a copy | Fingerprint and functions identical |
| Code rollback to `84922b1` on a 0064 copy | Every route, sign-in and browser check clean |

The refusal gates cover wrong database, wrong commit, wrong pinned checksum, altered recorded checksum, wrong predecessor, altered migration file (0061 and 0064) and rerun.

## Live verification

Nothing signed in to production, and no transaction was created. Browser specs answer from mocked APIs.

| Check | After deployment | After controlled restart |
|---|---|---|
| Live functions against the rehearsed copy | 394 identical | 394 identical |
| Smoke | 19 of 19 | 19 of 19 |
| Browser (16 specs, including money, Safes and all reports) | 121 of 121 | 121 of 121 |
| Eight reports and other APIs, no session | 11 of 11 answer 401 JSON | 11 of 11 |
| Pages, including Loans and Add money | 15 of 15 answer 200 | 15 of 15 |
| Vault | Clean | Clean |

Also checked once:

- **Loan browser spec:** 17 of 17 on the production build.
- **Loan and money APIs with no session:** all five GET routes answer 401 JSON. Valid-shaped `record` and `repay` requests answer 401. A cross-origin POST answers 403.
- **Rerun on production:** refused with `database already records 0061_v1_loan_model_and_lanes`.
- **Controlled restart:** healthy in 6.7 seconds on the deployed SHA. No row changed across the checks and the restart.

An empty POST to `/api/v1/finance/loans` with no session answers 422, because the body is checked before the session. No database call is made. See ED-2 in `docs/00-governance/OPEN_ITEMS.md`.

## Treasury invariants

All 394 live functions are identical to the rehearsed copy, so these rules are live as proved in `fx-treasury-carrying.test.ts` and `loans.test.ts`. No live movement exists yet to observe them on.

- Native Treasury of 0 means base carrying of 0.00.
- A same-currency transfer preserves carrying value and realizes no FX.
- Loan principal never becomes Income or Expense.
- Realized FX is recognized exactly once.

## Required before the first loan

Read from the live database with the application's own status functions. Nothing was configured. This is for an administrator to do explicitly.

| Item | Live state | Needed when |
|---|---|---|
| `finance.loan.read` | Held by no role or user | Before anyone can see a loan |
| `finance.loan.record` | Held by no role or user | Before recording a loan |
| `finance.loan.repay` | Held by no role or user | Before recording a repayment |
| `finance.loan.approve` | Held by no role or user | Only if loan approval is turned on. It is independent of recording |
| Shareholder Loan Payable | `MISSING` | Before a shareholder loan. Liability, control `SHAREHOLDER_LOAN` |
| Other Loan Payable | `MISSING` | Before a loan from anyone else. Liability, control `LOAN_PAYABLE` |
| Realized FX Gain | `MISSING` | When foreign currency settles for more than it carried. Revenue, control `REALIZED_FX_GAIN` |
| Realized FX Loss | `MISSING` | When foreign currency settles for less than it carried. Expense, control `REALIZED_FX_LOSS` |

A USD loan needs neither FX account.

Who can do this today:

- **Permissions:** `admin.roles.manage` is held by CEO, Super Administrator and Test Admin.
- **Accounts:** `finance.ledger-account.manage` is held by CEO and Test Admin. Super Administrator does not hold it.

No loan workflow policy exists yet, so loans post without an approval step until one is set.

## Rollback readiness

- **Code:** repin the runtime to `84922b1`, rebuild and restore the prior startup script. Proved on a copy holding all four migrations.
- **Database:** restore the fresh pre-deployment dump, after stopping only the web app. Proved on a copy. It loses anything entered after the dump, so it needs an owner decision once real transactions exist.

The sealed package is `deployment-0064-20261107-010222`. Its manifest and rollback record were resealed for the fresh dump, and the original seal is kept inside it.
