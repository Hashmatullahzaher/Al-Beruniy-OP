# Period close / reopen and reversal posting (Slice 5)

Status: design for Slice 5, written from trunk `bb1811a` (production runs 0049). Implemented in migration
0050.

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

## 2. Period close and reopen

Close: **Financial periods → Close month → Confirm**, with permission `finance.period.manage`.
- The confirmation shows:
  - the month and its status;
  - the posted journal count with total debits and credits (the period summary);
  - the pending Advanced-control items (expenses waiting for approval, open reversal requests, temporary funding waiting for a decision);
  - warnings: an earlier month still open, the month containing today, no posting yet.
- Only a genuine integrity problem refuses the close: a journal in the month that is not posted.
- Closing changes no journal. It stamps who closed the month and when, and records a `CLOSED` event.
- From then on every posting into the month is refused by the kernel, and the auto-open refuses it too.

Reopen: permission `finance.period.reopen`; a reason of 5–500 characters is mandatory.
- **Simple Mode** (the `PERIOD_REOPEN` setting missing or OFF): the permitted user reopens directly.
- **Advanced Mode** (`PERIOD_REOPEN` ON): direct reopen is refused.
  - A permitted user requests the reopen with the reason.
  - A different permitted user confirms it (the month reopens) or rejects it (a note is required).
  - The requester may withdraw.
- Every step is recorded in `accounting_period_events` (append-only): the actor, the time, the reason and the request. The reopen count is the number of `REOPENED` events.
- An audit record keeps the before/after state.
- Reopening never changes a journal.

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

**Date policy.**
- If the original month is OPEN, the reversal posts on the original effective date in that month.
- Otherwise it posts on the Kabul business day, in its month (a PENDING month opens itself; a CLOSED one is refused, never reopened silently).
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

## 4. Permissions and settings (0050)

- New permission codes (catalogue v13): `finance.period.reopen` and `finance.reversal.direct`.
- Existing codes used: `finance.period.manage`, `finance.reversal.request` and `finance.reversal.approve`.
- New workflow types `PERIOD_REOPEN` and `JOURNAL_REVERSAL`: Simple Mode default OFF; ON is available because both have an approval path.

## 5. Screens

**Financial periods** (`/finance/periods`):
- months with status, who opened or closed them and the reopen count;
- Close with the preview and Confirm;
- Reopen with the reason, or Request reopen in Advanced Mode;
- pending reopen requests to confirm, reject or withdraw;
- recent history.

**Journal reversals** (`/finance/reversals`, now the operational lane):
- recent reversible journals, each with its lines and why it can or cannot be reversed;
- Reverse (Simple) or Request reversal (Advanced);
- requests to approve and post, reject or withdraw;
- posted reversals with their links.
