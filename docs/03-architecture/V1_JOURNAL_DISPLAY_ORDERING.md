# V1 journal display ordering

Engineering record, opened 2026-11-07. Not scheduled. It does not block 0061 to 0064, and owner direction is that it stays separate from them.

## The problem

Journals are put in order by wall-clock stamps, and the wall clock here does not always move forward.

| Stamp | Set by | Used for |
|---|---|---|
| `journals.created_at` | `DEFAULT clock_timestamp()` at insert | Some lists, and test queries |
| `journals.posted_at` | `clock_timestamp()` when posting | Within-day order in statements, the General Ledger and reversal lists |

Both are read from the PostgreSQL host. Production runs in a Docker VM on the owner's machine.

## What was observed

- The VM clock is set from Docker's `GET /time` reply. One measured forward jump of 3.55 s ended on the exact value of a reply.
- A slow reply leaves the VM behind by the delay. 3.4 s behind was measured, for about 18 s.
- Docker's reply slows when the host runs out of memory. Replies of 10 to 18 s are in Docker's logs.
- Windows Time is not running on the host.
- Once, in a `next dev` test run, a capital journal sorted after the expense and reversal that followed it.

That one event is deduced, not observed. No path sets `created_at`, and the money guard forces capital to commit first, so the clock reading must have gone backward. A later test took 94,790 readings across three backends and found no inversion.

## Effect

| Area | Affected? |
|---|---|
| Journal amounts, lines and balances | No. Sums do not depend on order |
| Treasury carrying value | No. Positions are sums by accounting date |
| Closing balances on statements and reports | No |
| Order of lines within one accounting date | Yes, if the clock stepped between them |
| Running balance shown on those lines | Yes. The window orders by `accounting_effective_date, posted_at`, so an interim figure can differ. The closing figure does not |
| "Most recent" lists | Yes, within seconds |

## Rules for the fix

- Do not change posted accounting amounts or historical journals.
- Do not rewrite `created_at` or `posted_at`. They stay as evidence of what the clock said.
- Ordering must follow the order journals were really written, not the clock.

## Proposed direction

Add a database-assigned, ever-increasing order value to `journals`, such as an identity column, and use it wherever order is shown, after `accounting_effective_date`.

To settle before building:

- Identity order is insert order, which can differ from commit order under concurrency. Decide whether that is acceptable for display.
- `journals` is guarded against change, so an existing row needs a one-time, reviewed backfill. Production has 0 journals today, so doing this before the first journal means no backfill at all.
- Which reads change: the statement windows, the General Ledger page, the reversal lists and `journalLines()` in `v1-operational-finance.spec.ts`.

## Separate mitigation

Host memory drives the slow replies, so keeping heavy development tools off the production machine lowers the risk. This reduces the cause. It does not replace the fix.
