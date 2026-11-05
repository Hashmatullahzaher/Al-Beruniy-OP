# V1 reporting deployment, 2026-11-05

Owner-authorized deployment of `0057 -> 0058 -> 0059` to preserved production, from trunk `a4cefdd7bd3400bc0e1687e0c1330a0f49a00e76`.

## Owner decisions applied

1. Retained earnings stay derived. No closing journal.
2. No `statement_section`. The present class and group presentation stays.
3. A negative ASSET-type Saraf is presented as a liability on the Balance Sheet. 0059 was amended before deployment, and its checksum changed from `eb19c9c9...` to `0c5a6c37...`. Presentation only.

## Result

| Check | Before | After |
|---|---|---|
| Runtime | `5b31159` | `a4cefdd` |
| Latest migration | 0056 | 0059 |
| Migrations | 55 | 58 |
| Journals | 0 | 0 |
| Safe balance | 0 | 0 |
| FY 2026 | Open | Open |
| Definers | 138 | 143 |
| PUBLIC execute on definers | 0 | 0 |
| Runtime table writes | 0 | 0 |
| Table grants | 954 | 954 |

Among the 99 tables only `schema_migrations` changed. All 364 live functions are identical to the rehearsed copy. The vault reconciled clean.

## Validation of the deployed tree

| Check | Result |
|---|---|
| Full integration | 389 of 389 |
| Unit | 176 of 176 |
| Typecheck and lint | Clean |
| Mocked browser, `next dev` | 143 passed, 15 skipped |
| Database-backed browser, `next dev` | 156 passed, 2 skipped on one run; 155 passed, 2 skipped, 1 failed on two others |
| Smoke on `next start` | 20 of 20 |
| Mocked browser on `next start` | 135 passed, 15 skipped |
| First-run and operational E2E on `next start` | 3 of 3, twice |
| Database-backed browser on `next start` | 147 passed, 2 skipped, 1 failed, twice |
| Restart cycles | 5, identical |
| Disconnect recovery | 82 of 82 |
| Report API burst on `next start` | 2,000 requests, slowest 111 ms |

The one failure on `next dev` is the operational E2E stalling on a report response, on a different step each run. The one failure on `next start` is `v1-company-dashboard`, which cannot send a Secure cookie through `page.request`. Neither is a wrong figure.

## Live verification

Live smoke 19 of 19 and live browser 118 of 118, both before and after one controlled restart. These specs answer from mocked APIs and never sign in. Disconnect recovery was 82 of 82 on the live server. All eight report APIs refuse an anonymous reader, and all report pages load.

## 0060

Deployed the same day from `84922b13c5fdfec1a1e0f8f155a069156caf7cce`, under separate owner authorization, through the same guarded process. Production is at 59 migrations, latest 0060. Among the 99 tables only `schema_migrations` changed. Journals, Safe balances and FY 2026 are unchanged, and 143 definers, 0 PUBLIC execute and 0 runtime table writes hold.

The proof ran on a disposable copy of the exact post-deployment state, on the deployed build. Capital, an expense and two reversals were posted on the copy through the real APIs. A report-only reader received identical figures and none of 21 forbidden items across 17 surfaces. Raw responses held no `RV-` reference, source id, route or reason.

## The `next dev` stall

The stall is dev-server memory and compile pressure on this machine. It is not connection-pool contention and it is not report or API behaviour.

One failing run was captured with the server's request log, a database monitor and a resource sampler:

- The stalled request was `POST /api/v1/finance/accounts/<id>/reevaluate`, not a report. It took 16.6 s: 6.0 s in Next.js and 10.7 s in application code. That route normally answers in milliseconds.
- During it, the largest Node process grew from about 1 GB to 3.2 GB. Free memory fell to 26 MB on a 15.7 GB machine, and disk activity spiked, consistent with paging.
- The database showed no lock wait and no slow query in that window, and the server's health route kept answering.
- Memory recovered about ten seconds later and the suite carried on.

Earlier failures had the same shape, on a different step each time, but were not measured. On a production build there is no compilation, and a burst of 2,000 concurrent report requests peaked at 111 ms.

No test timeout was raised and no sleep was added.

## Found after deployment

A comparison of a report-only reader with a full reader, on a disposable company served by the deployed code, found that reversals were not masked. See `V1_REPORTING_0060_REVERSAL_CONFIDENTIALITY.md`. Figures matched on every report, and no source record id, shareholder name, payee or expense detail reached the reader.
