# Financial Year Close replaces the monthly close / reopen (migration 0052)

Status: IMPLEMENTED and validated on disposable databases only. **Not deployed**: production stays at 0051 until the owner authorizes 0052.
Owner correction of 2026-10-31: Al-Beruniy closes a financial year, never a month (`DECISIONS.md`). Design: `docs/03-architecture/PERIODS_AND_REVERSALS.md` §2.

## 1. Inspection findings (before the change)

| Question | Finding |
|---|---|
| What Financial Year Close existed? | None. `fiscal_years` (0012) has no status and is immutable. Only months had a status. |
| What 0050 added for months | Close-month preview and close; reopen (Simple); reopen request and decision (Advanced); the months workspace. Also the `accounting_period_events` and `accounting_period_reopen_requests` tables, the permission `finance.period.reopen`, the workflow `PERIOD_REOPEN` and the page `/finance/periods`. |
| Other month-only user features | Manual "Open period" on Finance setup (0027 `finance_open_accounting_period`). |
| Accounting invariants that depend on a month's status | The posting kernel needs the journal's month to be OPEN. The Treasury lanes, capital and reversals open a PENDING month themselves. **Before 0052, the expense lane (record and post) and temporary funding needed a month someone had opened by hand.** No invariant needs a month to be CLOSED. |
| Production state (post-0051 copy) | One financial year (2026-01-01 – 2026-12-31) with 12 months, all PENDING. No close events, no reopen requests, and no role holds `finance.period.reopen`. No data repair is needed. |

## 2. What changed (0052)

0050 is applied and unchanged. No table is added and no row is deleted.

1. **Retired from the product:**
   - The runtime's EXECUTE is revoked on: close month, close-month preview, reopen, reopen request, reopen decision, the months workspace, and the 0027 manual open. The functions stay for history.
   - `finance.period.reopen` is entered in `permission_retirements`, so it can no longer be granted (0041 guard).
   - `PERIOD_REOPEN` is no longer available and is hidden from Workflow approvals.
2. **Months open themselves in every lane.** The expense record and post, the expense entry options and temporary funding now use the same auto-open as the Treasury lanes. A CLOSED month is never reopened automatically: "the financial year covering … is closed".
3. **Year-close state is stored on the year.** `fiscal_years` gains `closed_at`, `closed_by_user_account_id` and `close_correlation_id` (all or none). The year stays append-only except for that one transition, open → closed; a closed year is never changed, reopened or deleted. Month rows are not touched.
4. **Posting guard** `journals_financial_year_guard` (BEFORE INSERT OR UPDATE on `journals`, SECURITY DEFINER owned by the operational Finance owner):
   - it refuses any journal whose effective date falls in a closed financial year of its company, whatever lane or month it came through;
   - the lanes' month auto-open refuses the same dates first, before any month is touched;
   - it locks the year row FOR SHARE, which serialises with the close's UPDATE.
5. **Financial Year Close** (`finance.period.manage`, now labelled "Close the financial year"):
   - `finance_financial_years_workspace` lists the company's years (ACTIVE or CLOSED). Readers with Finance report permission may view it; only `finance.period.manage` may close.
   - `finance_financial_year_close_preview` shows posted journals, debit and credit totals, waiting items, and the warnings "year not ended" and "earlier year still active".
   - `finance_financial_year_close`:
     - locks the year row;
     - refuses only when the year has a journal that is not posted;
     - sets the year's close fields and writes one `FINANCIAL_YEAR_CLOSED` audit record;
     - replays when repeated;
     - changes no journal and no month row.
6. **Reversals: same rule, read at year level.** The 0050 rule (the original date while the original's month is OPEN, otherwise the business day) is restated in `reversal_post` and `validate_reversal_journal` to ask whether the original's financial year is closed. The reversal screen reports a closed year:
   - while the original's financial year is active, the reversal keeps the original date;
   - once that year is closed, the reversal posts on the business day in the current year.

   Self-correction, immutable links and the opening-balance behaviour are untouched. This is a mechanical translation of the owner's earlier decision, not a new policy.

**Reopening a closed financial year is not offered.** If wanted, it is a separate owner decision (`OPEN_ITEMS.md`).

**Concurrency** (proven in `financial-year-close.test.ts`). The close UPDATEs the year row, and the guard locks it FOR SHARE:
- if a posting started first, the close waits and the journal is posted before the year closes;
- if the close started first, the posting waits, then reads the closed year and is refused (READ COMMITTED);
- under REPEATABLE READ, a posting whose snapshot predates the close fails with a serialization error.

## 3. Client-facing behaviour

- **Navigation:** "Financial periods" is gone. "Financial year" is shown to `finance.period.manage` and to Finance report readers. The old `/finance/periods` redirects to `/finance/financial-year`.
- **Financial year page:**
  - each year shows Active or Closed, its postings, and who closed it and when;
  - one action: **Close financial year** → preview → **Confirm financial year close**;
  - there is no month close and no reopen anywhere;
  - English and Dari, right-to-left, phone width.
- **Finance setup:**
  - the "Open period" button and the "Closing periods is not available yet" note are removed;
  - months are listed read-only as Active, or "Closed with its financial year";
  - the readiness check reads "a financial year is active".
- **Recording** an expense, receipt, payment, transfer, capital or temporary funding on any date inside an active year works with no preparation. A date in a closed year is refused with "The financial year of this date is closed. Choose a date in an active financial year." (English and Dari).
- **Journal reversals:** when the original's year is closed, the form says "Its financial year is closed: the reversal posts today … in the current financial year".
- **Roles:** `finance.period.reopen` shows as retired ("Reopen a closed month (retired)") and cannot be granted.
- **Workflow approvals:** the "Period reopen" setting is no longer listed.

## 4. Validation

| Check | Result |
|---|---|
| New PostgreSQL suite `financial-year-close.test.ts` | 6/6: retirement; auto-open in the expense lane; preview, close stored on the year (month rows unchanged), replay, refusal, audit, no reopen path, company isolation; the journal guard under READ COMMITTED (waits for a close in progress, then refuses) and REPEATABLE READ (serialization failure); every writer (receipt, payment, transfer, expense, opening balance, capital, reversal) posts in an active year and, with the lanes' own year check switched off, is refused by the journal guard alone, with no journal changed; reversal before and after the close |
| Corrected older suites, rerun serially | direct-shareholder-capital 30/30; posting-kernel-equivalence 2/2 (compared through 0051, because 0052 deliberately changes the expense lane) |
| Affected suites | 47/47 (with financial-calendar) |
| Full integration on a fresh install | 320/320 tests, 41 suites, 0 failures (before the per-writer proof was added; that suite was then rerun alone, 6/6) |
| Production-shaped upgrade (post-0051 production dump → 0052, repository runner) | Applied `0052_v1_financial_year_close` only; the rerun applied nothing. 99 tables before and after; 96 byte-identical; `permission_retirements` 12→13, `schema_migrations` 50→51, and `fiscal_years` changed only by the three new NULL close columns (original columns byte-identical; the year is ACTIVE); 0 journals; 12 months PENDING. On the copy, the runtime cannot execute any retired function or internal helper and can execute the three new entry points. |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser (mocked) | New `v1-financial-year.spec.ts` 4/4. Reversal, money and setup specs updated. Full suite at 4 workers: 82 passed, 14 skipped (database-backed, opt-in), 0 failed |
