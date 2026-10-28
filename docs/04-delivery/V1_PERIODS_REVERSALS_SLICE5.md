# Slice 5 — period close / reopen and reversal posting (migration 0050)

Status: IMPLEMENTED and validated on disposable databases only. **Not deployed**: production stays at 0049
until the owner separately authorizes 0050. Design: `docs/03-architecture/PERIODS_AND_REVERSALS.md`.

## 1. Definition of done

| Requirement | Where it is proven |
|---|---|
| Close an OPEN month after a preview: period, status, pending Advanced-control items, warnings, period summary | `periods-and-reversals.test.ts` (close test); `v1-periods.spec.ts` |
| Posting into a CLOSED month is refused; closing changes no journal | close test (receipt and payment refused; original journal row identical) |
| Reopen with permission and a mandatory reason; audit, history and reopen count | Simple reopen test |
| Unauthorized and cross-company reopen denied | Simple reopen test (closing authority alone; another company) |
| Advanced second-person reopen: request, the asker cannot confirm, a reject needs a note | Advanced reopen test; `v1-periods.spec.ts` |
| Direct reversal (Simple Mode, `finance.reversal.direct`) | direct reversal test; `v1-journal-reversals.spec.ts` |
| Approved reversal (Advanced Mode): request, independent approval, the same writer posts | Advanced reversal test |
| Exact inverse lines and exact inverse subledger movements | direct reversal test (line-by-line comparison); kernel validator `validate_reversal_journal` |
| Safe balance restored; shareholder balance restored | direct reversal test (Safe 380 → 500); capital test (shareholder capital 700 → 0, workspace REVERSED) |
| Duplicate reversal denied; replay idempotent; reversal of a reversal denied | direct reversal test |
| Closed original month: the reversal posts on the business day in the current month; no silent reopen | closed-month test |
| Original journal immutable; link immutable | direct reversal test (row identical; link UPDATE refused) |
| Concurrency cannot reverse the same journal twice | concurrency test (two people at once: one reversal, one "already reversed") |
| Audit trail complete | close and reopen events with audit records; reversal audit plus REVERSAL_REASON evidence |
| The 0049 funds guard holds for reversals; Daily Report and expense show reversals; a reversed opening balance can be re-recorded | remaining tests |

## 2. What changed (0050)

- **New permissions:** `finance.period.reopen` and `finance.reversal.direct`.
- **New settings:** `PERIOD_REOPEN` and `JOURNAL_REVERSAL`, Simple Mode default OFF. ON is available because both have an approval path.
- **New tables:**
  - `accounting_period_events`: append-only; every close, reopen and request with actor, time and reason.
  - `accounting_period_reopen_requests`: second person; one open request per month.
- **Registry:** `REVERSAL` is ACTIVE, with validator `validate_reversal_journal` reached by the kernel's static dispatch. Direct shareholder capital is now reversible; temporary funding stays non-reversible.
- **One internal writer, `reversal_post`, does the posting:**
  - locks the original journal, checks the blockers, segregation of duties and the date policy;
  - posts through `posting_kernel_draft` / `posting_kernel_commit`;
  - writes the REVERSAL_REASON evidence, the immutable link, the audit record and the outbox event.
- **Entry points** (operational password session, Finance runtime only):
  - periods: workspace, close preview, close, reopen, reopen request, reopen decision;
  - reversals: workspace, direct, request, decide (approval posts), post an earlier-approved request, withdraw.
- **Read models now aware of reversals:**
  - Daily Report: a reversed expense subtracts on the reversal's date;
  - expense JSON: `reversal` appears only when the expense was reversed;
  - capital workspace: excludes reversed receipts from "contributed" and labels them REVERSED;
  - Safes: the opening balance shown is the latest one that has not been reversed;
  - the opening-balance writer: a reversed opening balance can be recorded again (the one-per-Safe unique constraint is replaced by the writer's check under the Safe lock).
- **Retired:** the 0040 trigger that refused every direct-capital reversal (the validator and link guards now decide), and the synthetic-only E1 reversal screen and routes (`/api/v1/finance/reversals`). `/finance/reversals` now runs the operational lane.
- **Screens:** Financial periods (`/finance/periods`) and Journal reversals (`/finance/reversals`), in English and Dari, phone-width safe.

## 3. Validation (disposable databases only; test PostgreSQL at 1 GB)

| Check | Result |
|---|---|
| Slice 5 suite `periods-and-reversals.test.ts` | 10/10 |
| Updated suites (kernel, kernel equivalence, admin-approval upgrade, money upgrade and corrections, security ownership, bridge schema, temporary funding, workflow policy) with the Slice 5 suite | 73/73 |
| Full integration, fresh database 0001 → 0050 (fresh install) | 310/310, no OOM |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser: full mocked suite (including the new periods 4/4 and reversals 4/4) | 75 passed, 14 database-gated skips |
| Smoke | 12/12. The first run under concurrent integration load had one transient failure that did not repeat. |
| Production-shaped upgrade: the post-deployment production dump (0049), restored and upgraded to 0050 | • only 0050 applied; rerun a no-op;<br>• changed: workflow types +2, permission catalogue +2, the posting registry (REVERSAL ACTIVE, direct capital reversible), the migration registry, two new empty tables;<br>• 91/95 tables identical;<br>• 0 journals, intents and subledger entries;<br>• periods unchanged (12 PENDING); Safe کسه 0;<br>• no runtime table write; no balance column;<br>• SECURITY DEFINER functions 115 → 127 (exactly the 12 new entry points). |

0050 checksum: `6e112c0649aa8a8f7d963c92d121caf2b29f0ef8614eec8d22c58b2cad41de67`.

**Known limitation (informational only).** A reversed direct-capital receipt keeps its allocation rows against an optional capital declaration (`direct_capital_receipt_allocations`).
- The capital workspace's "contributed" and "remaining" already exclude reversed receipts.
- The allocations feed only the frozen legacy request lane; no money, posting or balance depends on them.
- A later slice may exclude reversed receipts there too (`OPEN_ITEMS.md`).

## 4. Before the owner uses it on production

- Deploying 0050 needs separate authorization.
- After deployment, grant the new permissions as needed:
  - `finance.period.manage` to close a month;
  - `finance.period.reopen` to reopen;
  - `finance.reversal.direct` to reverse directly;
  - `finance.reversal.request` / `finance.reversal.approve` for the request path.
- Nothing changes until a month is closed or a reversal is made. No setting needs to be saved: Simple Mode is the default.

## 5. Open owner decisions (recorded in `OPEN_ITEMS.md`)

- Whether Simple Mode may let the person who posted a transaction reverse it themselves. Today, as before, whoever prepared, approved or posted it can neither reverse, request nor decide its reversal.
- Whether the Safe's "Opening balance" figure should net a reversed opening balance. The book balance is already correct.
- Reversal of temporary funding and its settlements (needs its own design).
