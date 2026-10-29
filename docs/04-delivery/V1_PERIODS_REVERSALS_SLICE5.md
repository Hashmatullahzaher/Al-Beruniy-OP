# Slice 5 — period close / reopen and reversal posting (migration 0050)

Status: **DEPLOYED to production on 2026-10-29** at trunk `39cca7e` (final 0050, checksum `07cde8b9…`, owner
authorization of 2026-10-29; record in `V1_MAX_DELIVERY_SESSION_2026-10-27.md`). Design:
`docs/03-architecture/PERIODS_AND_REVERSALS.md`.

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

## 3. Validation of the final amended 0050 (disposable databases only; test PostgreSQL at 1 GB)

| Check | Result |
|---|---|
| Slice 5 suite `periods-and-reversals.test.ts`<br>(includes self-correction, Advanced Mode independence, concurrency, the opening balance 2,500 → reversed → effective 0 regression) | 12/12 |
| Full integration, fresh database 0001 → 0050 (fresh install) | 312/312, no OOM |
| Unit / typecheck / lint / production build | 169/169; 12/12; clean; 11/11 |
| Browser: full mocked suite (periods, reversals with self-correction and the Advanced participant, Safes with a reversed opening balance) | 76 passed, 14 database-gated skips;<br>1 first-compile timeout in `shell.spec.ts`, which passed on rerun (9/9) and in smoke |
| Smoke | 12/12 |
| Production-shaped upgrade: the post-0049 production dump (sha256 `b67dbe78…`), restored and upgraded to the final 0050 | • only 0050 applied; rerun a no-op;<br>• changed: workflow types +2, permission catalogue +2, the posting registry (REVERSAL ACTIVE, direct capital reversible), the migration registry, two new empty tables, and two new link columns on the empty `journal_reversal_links`;<br>• 91/95 tables byte-identical (zero backfill);<br>• 0 journals, intents, subledger entries and reversal links (no migration-created journal);<br>• periods unchanged (12 PENDING); settings unchanged; Safe کسه opening 0, book 0;<br>• no runtime table write; no balance column;<br>• SECURITY DEFINER functions 115 → 127 (exactly the 12 new entry points). |

Final 0050 checksum: `07cde8b9572f24f2546406b7278818442f718f03bccf9cf38867411258fc870d` (replaces `6e112c06…`, which was never deployed).

**Deferred by owner decision: legacy capital cleanup debt.** A reversed direct-capital receipt keeps its allocation rows against an optional capital declaration (`direct_capital_receipt_allocations`).
- The capital workspace's "contributed" and "remaining" already exclude reversed receipts.
- The allocations feed only the frozen legacy request lane; no money, posting or balance depends on them.

## 4. Before the owner uses it on production

- Deployment of the final reviewed 0050 was authorized by the owner on 2026-10-29 (guarded backup → restore → rehearsal → apply → verify; no real transaction for verification).
- After deployment, grant the new permissions as needed:
  - `finance.period.manage` to close a month;
  - `finance.period.reopen` to reopen;
  - `finance.reversal.direct` to reverse directly;
  - `finance.reversal.request` / `finance.reversal.approve` for the request path.
- Nothing changes until a month is closed or a reversal is made. No setting needs to be saved: Simple Mode is the default.

## 5. Owner decisions of 2026-10-29 (0050 amended before deployment)

**Self-correction (Simple Mode).**
- A user with `finance.reversal.direct` may reverse their own recorded or approved transaction.
- The reason stays mandatory, and the original stays immutable.
- The reversal is a new exact-inverse journal with an immutable link carrying `reversal_mode = DIRECT` and `self_reversal = true`. The audit carries `selfReversal`, the actor, the date, the reason and both journals.
- Duplicate and concurrent reversal stay impossible: the journal lock plus the link's primary key.

**Advanced Mode** keeps database-enforced independence:
- direct reversal is refused;
- a participant can neither request, approve nor post;
- a DIRECT link is refused by the trigger while approval is required.

**Effective opening balance.** A fully reversed 2,500 shows an effective opening balance of 0 and a book of 0, and counts as neither money in nor money out. The card shows the original opening balance with its reversal (date, reference, reason). The movement history keeps both lines, and the original record is neither deleted nor changed.

**Deferred:** capital declaration allocations after a reversal (legacy capital cleanup debt).

## 6. Remaining known debt (`OPEN_ITEMS.md`)

- Legacy capital cleanup debt (declaration allocations of reversed capital receipts).
- Reversal of temporary funding and its settlements (needs its own design).
