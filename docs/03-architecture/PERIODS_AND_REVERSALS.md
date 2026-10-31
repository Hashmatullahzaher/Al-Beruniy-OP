# Financial year close and reversal posting (Slice 5, corrected by 0052)

Status: design for Slice 5, written from trunk `bb1811a` (production runs 0049). Implemented in migration
0050. **Corrected by migration 0052 (owner correction of 2026-10-31):** Al-Beruniy closes a financial year, never a
month. The monthly close / reopen of 0050 was a misread requirement. It is retired from the product (section 2);
the reversal posting of 0050 is unchanged (section 3).

Binding owner decisions:
- `DECISIONS.md`, target architecture #3 (period authority) and #4 (reversal posting);
- the Slice 5 instruction of 2026-10-28.

Also binding: one posting kernel and registry, and Simple Operational Mode as the default.

## 1. Facts this design starts from

| Fact | Where |
|---|---|
| Months are PENDING until the first valid posting opens them; a CLOSED month is never auto-opened | 0040 `open_period_for_business_date` |
| Every operational journal posts through the kernel trigger, which requires an OPEN period | 0043/0049 `posting_kernel_validate` |
| `REVERSAL` is a PLANNED registry source; each source carries a `reversible` flag | 0043 |
| A reversal is a REVERSAL intent whose source is the original journal, posted with an immutable `journal_reversal_links` row in the same transaction:<br>• the link guard checks the exact inversion of lines and subledger entries;<br>• the original can be linked once (primary key);<br>• the original poster can neither post nor approve its reversal | 0001/0023/0045 |
| Reversal requests (REQUESTED → APPROVED/REJECTED/WITHDRAWN): whoever prepared, approved or posted the journal can neither request nor decide its reversal. Their entry points authorize only synthetic sandbox sessions, so they never worked on real data | 0023 |
| Direct capital reversal and temporary-funding reversal are refused by triggers | 0040, 0037 |
| Safe and shareholder balances are sums of posted subledger entries; the Daily Report sums posted expense rows; the capital workspace sums capital receipt rows | 0045, 0029, 0040 |

## 2. Financial year close (0052)

**Model.**
- While a financial year is ACTIVE, transactions may be posted on any valid date inside it.
- Months exist only internally, for date grouping, reporting, the trial balance, the fiscal calendar and period selection.
  - Nobody opens, closes or reopens a month.
  - A month opens itself when something dated in it is recorded. Every posting lane does this, including the expense lane and temporary funding (0052).
  - The kernel still needs an OPEN month for each journal; that is an internal mechanism, not a user step.
- At year end an authorized Finance user closes the financial year: **Financial year → Close financial year → Confirm**, with permission `finance.period.manage` ("Close the financial year").
- **The close is stored on the financial year itself:** `fiscal_years.closed_at`, `closed_by_user_account_id` and `close_correlation_id` (all three or none).
  - The year row stays append-only except for that one transition, open → closed (trigger `fiscal_years_append_only_except_close`).
  - A closed year can never be changed, reopened or deleted.
- Month rows are not touched by the close. They keep whatever internal state they had (PENDING or OPEN). No user step and no accounting rule depends on a month being closed.

**Confirmation.** It shows:
- the year's posted journal count with total debits and credits;
- items still waiting: expenses awaiting approval, open reversal requests, temporary funding awaiting a decision;
- warnings: the year has not ended yet; an earlier year is still active.

**Effect of the close.**
- Only a genuine integrity problem refuses the close: a journal in the year that is not posted.
- The close locks the year row, checks integrity, sets `closed_at`, `closed_by_user_account_id` and `close_correlation_id`, and writes one audit record, `FINANCIAL_YEAR_CLOSED`.
- It changes no journal and no month row.
- A repeated close replays.
- **Posting guard** (`journals_financial_year_guard`, on every journal insert and every status or date change):
  - it refuses a journal whose effective date falls in a closed financial year of its company: "the financial year covering … is closed; nothing can be posted into it";
  - every lane's month auto-open refuses a date in a closed year first, with the same message, before any month is touched;
  - the guard locks the year row FOR SHARE, and the close UPDATEs it. Under READ COMMITTED a posting that meets a close in progress waits, then sees the closed year; under REPEATABLE READ or SERIALIZABLE it fails with a serialization error. Nothing is posted into a year whose close committed.
- After the close:
  - every posting dated in the year is refused;
  - historical journals stay immutable;
  - every report stays available.

**Reopening a closed financial year is not offered.** If the owner later wants it, it must be a separate, high-risk, year-level action with its own permission, a mandatory reason and a full audit (`OPEN_ITEMS.md`). There is no monthly reopen.

**Retired by 0052** (functions and rows kept for history; the runtime can no longer call them):
- close month, close-month preview, reopen month, reopen request and decision;
- the months workspace;
- the manual "open period" of 0027.

The permission `finance.period.reopen` is retired (`permission_retirements`; it can no longer be granted), and the `PERIOD_REOPEN` approval setting is withdrawn.

## 3. Reversal posting

`REVERSAL` becomes an ACTIVE registry source:
- any account type on either side, matching the original's lines;
- OPERATIONAL_TREASURY and SHAREHOLDER_CAPITAL subledger movements allowed on either side;
- two lines, like every active source.

Its validator `validate_reversal_journal` proves:
- the original is a posted operational journal of a reversible ACTIVE source, in the same company and currency, and not itself a reversal;
- the reversal intent has the same amounts and currencies;
- every line is inverted exactly: same account, party, dimensions and amount, debit and credit swapped;
- every subledger movement is inverted exactly: same type, Treasury account and party, negated amount;
- the date policy below holds.

One internal writer posts every reversal through `posting_kernel_draft` / `posting_kernel_commit`:
- it writes a `REVERSAL_REASON` evidence row (the written reason is the evidence: SHA-256 of the reason);
- it writes the immutable link, an audit record and an outbox event.

The original journal never changes. The original journal row is locked, so a concurrent second reversal waits and then sees the link; the link's primary key is the backstop. The 0049 funds guard applies: reversing a receipt cannot take a Safe below zero.

**Date policy** (0050 rule, read at year level by 0052: `reversal_post` and `validate_reversal_journal` ask whether the original's financial year is closed).
- While the original's financial year is active, the reversal posts on the original effective date.
- Once that year is closed, it posts on the Kabul business day, in the current financial year. If that year is closed or missing too, the reversal is refused; nothing is reopened silently.
- Either way the original journal, its date, the reason and the link are preserved.

**Simple Mode** (the `JOURNAL_REVERSAL` setting missing or OFF): a user with `finance.reversal.direct` chooses the transaction, writes the reason and saves; the reversal posts.

**Advanced Mode** (`JOURNAL_REVERSAL` ON): direct reversal is refused.
- A user with `finance.reversal.request` asks.
- An independent user with `finance.reversal.approve` approves, and the same writer posts in that transaction.
- Rejecting needs a note; the requester may withdraw.
- A request approved earlier (before 0050) can be posted by an approver.

**Segregation of duties (owner decision of 2026-10-29).**
- **Simple Mode (DIRECT).** The user holding `finance.reversal.direct` may correct a transaction they recorded or approved.
  - The link records `reversal_mode = DIRECT` and `self_reversal = true`, and the audit carries `selfReversal`.
  - The restated link trigger accepts a DIRECT link only while the JOURNAL_REVERSAL setting does not require approval, only when it is posted by its authoriser, and only with a truthful self flag.
- **Advanced Mode and approved requests.** Whoever prepared, approved or posted the original can neither request, approve nor post its reversal. This is enforced by the request guard, the writer and the link trigger.

**Reversible sources.**

| Source | Reversible |
|---|---|
| Expense | yes |
| Cash receipt | yes |
| Transfer | yes |
| Payment | yes |
| Opening balance | yes |
| Direct shareholder capital | yes, enabled by 0050 |
| Temporary funding and its settlement | no: their payable lineage needs its own design |
| Frozen bridge | no |
| Legacy E1 | no |

**Effects on source records** (no source row is edited):
- Safe and shareholder balances follow the posted reversal movements automatically.
- The Daily Report subtracts a reversed expense on the reversal's own date. When the reversal shares the original date, that day nets to zero; a closed day is never rewritten.
- An expense shows its reversal.
- The capital workspace no longer counts a reversed receipt as contributed and labels it REVERSED.
- A reversed opening balance can be recorded again: the one-per-Safe rule now counts only opening balances that have not been reversed.
- The Safe's opening figure is the effective amount: the 0045 read model counts the reversal of an opening balance inside the opening figure, so a fully reversed 2,500 shows 0. The card and the movement history keep the original, its reversal, the date and the reason.

## 4. Permissions and settings

- 0050 added the permission codes `finance.period.reopen` and `finance.reversal.direct` (catalogue v13).
  - 0052 retires `finance.period.reopen`.
  - `finance.period.manage` now means "Close the financial year".
- Codes still used: `finance.reversal.request` and `finance.reversal.approve`.
- 0050 added the workflow types `PERIOD_REOPEN` and `JOURNAL_REVERSAL`, both with Simple Mode default OFF.
  - `PERIOD_REOPEN` is withdrawn by 0052: it is hidden and never available.
  - `JOURNAL_REVERSAL` stays.

## 5. Screens

**Financial year** (`/finance/financial-year`; the old `/finance/periods` redirects there):
- the company's financial years, each Active or Closed, with who closed it and when;
- Close financial year, with the preview and Confirm;
- no month close and no reopen.

**Finance setup** lists the months of the financial year read-only: Active, or "Closed with its financial year". There is no "Open period" button any more.

**Journal reversals** (`/finance/reversals`, now the operational lane):
- recent reversible journals, each with its lines and why it can or cannot be reversed;
- Reverse (Simple) or Request reversal (Advanced);
- requests to approve and post, reject or withdraw;
- posted reversals with their links.
