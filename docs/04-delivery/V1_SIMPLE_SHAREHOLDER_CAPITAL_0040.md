# Simple shareholder capital — migration 0040 as built

Status: IMPLEMENTED on branch `claude/v1-simple-capital`. Not merged, not deployed. Migration 0040 is
not applied to the preserved database; localhost:3200 stays on the accepted 0039 runtime.

This supersedes `V1_DIRECT_SHAREHOLDER_CAPITAL_0040_REVIEW.md`, which describes the earlier
two-step shape of the same migration. 0040 was never applied anywhere, so it was reshaped in place
rather than stacked on; its checksum changed and the registry entry was updated with it.

## 1. What the owner asked for

A system one person can run. For shareholder capital that means: add a shareholder and what they are
putting in, in **one save**; no capital request, no eligibility review, no agreement, no installment
schedule, no ownership percentages, no approval; an agreed total only if the owner wants to follow
one; and four ways money or value can arrive. Money goes in before it is spent, and the system says
what an account holds rather than refusing an expense outright.

## 2. One save

`abos.direct_shareholder_add` creates the shareholder, an optional declaration for an agreed total,
and the first contribution in **one transaction**. If the contribution cannot post, the shareholder
is not created either: there are no orphan records. Later money uses
`abos.direct_shareholder_receive` directly, from the **Add money** button on the shareholder's card.

The ordinary `/shareholders` page is this workspace. The previous component stays at
`/shareholders/legacy` and is not in the navigation.

## 3. Four ways in, each with its own exact debit

| What they put in | Journal | Safe moves? |
|---|---|---|
| Cash into a Safe | Dr Safe / Cr shareholder capital | yes |
| Hawala into a Safe (saraf name and reference kept on the record) | Dr Safe / Cr shareholder capital | yes |
| An asset (vehicle, equipment, property, stock) | Dr shareholder contributed assets / Cr shareholder capital | no |
| A company bill they paid directly | Dr the chosen expense account / Cr shareholder capital | no |

`funding_method` is stored on every receipt with a table-level CHECK, so each method carries exactly
its own fields: a Safe for the two cash-bearing methods, a saraf name only for hawala, a description
only for an asset or a paid bill, and an expense account only for a paid bill. The contract schema
refuses the same mismatches in the browser, so the person gets a sentence instead of a database error.

The debit account is resolved, never guessed:

- **Safe**: the existing reviewed Treasury ledger of the chosen Safe, currency-checked.
- **Asset**: exactly one ACTIVE, posting-allowed `ASSET` account with the new control type
  `SHAREHOLDER_CONTRIBUTED_ASSETS`. The Chart of Accounts gains that control type (an asset account
  by definition). Until one exists, only that one method is unavailable, and the form says so.
- **Paid bill**: an ordinary ACTIVE `EXPENSE` account of the company, in the accounting currency,
  with no dimension requirement this lane cannot supply. The person chooses it from the list the
  workspace returns.

The journal validator checks each shape independently: the debit account must satisfy the rule of the
method that chose it, a non-cash method may not carry a Safe, the debit and credit accounts must
differ, and the subledgers must be exactly two for cash or hawala (Treasury + shareholder) and
exactly one otherwise (shareholder). Reversal stays unavailable, as before.

**A bill a shareholder paid directly is capital, not a loan.** Temporary Funding (0037) records the
same act as a liability the company repays. The form states which is which so the same payment
cannot be counted twice. A paid bill appears in the General Ledger and in the chosen expense account,
but not in the operational expense register, which only holds expenses recorded through its own lane.

## 4. An agreed total is optional

With no agreed total, no declaration is created and the shareholder's capital is simply the sum of
what they contributed. With one, the card shows **Capital put in**, **Agreed total** and
**Still to come**; contributing more than agreed shows a negative remainder rather than refusing
money that genuinely arrived.

Declarations are still consumed exactly as the legacy lane consumes them — the same stable row locks,
in the same order — so the two lanes cannot jointly over-allocate one declaration. Anything beyond a
declaration is ordinary unallocated capital. A reserved but unposted legacy receipt is **not**
counted as contributed capital.

`ownership_percentage` is gone. It was never applied to anything, and the owner does not want share
percentages in this workflow.

## 5. Months open themselves

`abos.open_period_for_business_date(entity, actor, date)` returns an existing OPEN period, or opens
the **PENDING** period that already covers the date inside a generated financial year, writing the
same `ACCOUNTING_PERIOD_OPENED` audit record as the manual action. It refuses a SOFT_CLOSED or CLOSED
month, a pending month with no financial year behind it, and a date no period covers. It never
reopens closed books, and never invents a period or a financial year.

The capital lane calls it directly. The expense lane checks for an open period before it writes
anything, so `abos.operational_period_ensure_open` (gated on `finance.expense.create` and an
operational password session) is called by the expense request first, then the expense is recorded.
No existing function was rewritten for this. The expense form no longer blocks on a closed month; it
says what will happen, and a genuinely closed month is refused on save.

The privileges this needs already existed: 0027 granted the operational finance owner
`UPDATE(status, opened_by_user_account_id, opened_at, operational_version)` on `accounting_periods`.

## 6. Money in before money out

The owner asked for accounting logic, not a hard gate. The expense form shows what the chosen account
holds on record for that date, and if the expense is larger it warns with the figure and asks the
person to confirm before saving. The account can then show a real negative balance rather than hiding
one. The figure comes from the existing Daily Report projection, so it respects reporting permission
and live project, department and cost-center scope; without that permission there is no warning
rather than a false one. Foreign-currency expenses are not compared.

## 7. What left the interface

Capital requests, eligibility review, capital agreements, installments, manual custody counts and
verification, Treasury handoff, evidence registration, separate prepare/approve/post buttons and
mapping setup are not part of this workflow and are not in the navigation. Temporary Funding keeps
its route and permissions but is out of ordinary navigation until the owner asks for it.

**Nothing was deleted.** Every legacy table, function, command and record still exists and still
works through its own commands. No posted record was relabelled, and no synthetic custody, approval,
mapping or authorization is fabricated to satisfy an obsolete prerequisite. Approval remains
available as a platform capability; this lane still requires the company capital approval setting to
be OFF and fails closed if it is ON or unconfigured.

## 8. First activation on real data

Before the first contribution the company needs, as before: an approved base currency, exactly one
ACTIVE shareholder-capital EQUITY account, the capital approval setting OFF, and an ACTIVE Safe in
that currency. For asset contributions, one ACTIVE `SHAREHOLDER_CONTRIBUTED_ASSETS` asset account.
For a bill a shareholder paid, at least one ordinary expense account. Missing configuration disables
only the method that needs it, and the page says which.

Cash in the approved accounting currency only. Cross-currency contributions, bank accounts as a
destination, refunds and direct reversal remain deferred.
