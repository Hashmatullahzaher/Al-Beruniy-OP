# Shareholder setup on the Kabul business day — migration 0042

Status: IMPLEMENTED on branch `claude/0042-shareholder-business-day` (base `v1/main` at
`769941c512cd732969e3e1d66152c2052f0238f2`, the SHA production runs since the 0041 deployment).
Validated on disposable databases only. **Not deployed**; production deployment needs separate owner
authorization.

## 1. The defect (finding D3-F1)

PostgreSQL's `current_date` is the calendar date of the session's time zone. The production database
runs its sessions in UTC. The direct capital lane (0040) judges "today" on the Kabul business day,
`abos.business_today()`; the shareholder setup lane still judged it on `current_date`. Kabul is
UTC+4:30, so between 00:00 and 04:30 Kabul time the two calendars differ by a day:

- adding a shareholder dated "today" was refused as "in the future", while the money arriving that
  day was accepted;
- the setup and contribution forms were offered yesterday's date as "today" and as their ceiling;
- an attachment holder agreement was dated yesterday.

The D3 upgrade-copy check hit exactly this window (03:51 Kabul time).

## 2. What 0042 restates, and why each one

Eight functions, each restated from its latest definition, verbatim except that `current_date`
becomes `abos.business_today()`:

| Function | Latest in | What `current_date` did |
|---|---|---|
| `shareholder_setup_create_shareholder` | 0031 | refused a shareholder-since date after the UTC day; called by `direct_shareholder_add`, so the owner's one-save flow was refused nightly |
| `shareholder_setup_record_agreement_evidence` | 0031 | refused a document date after the UTC day (legacy evidence path; no runtime grant since 0034; restated for consistency) |
| `shareholder_agreement_document_finalize` | 0034 | refused an agreement document dated after the UTC day |
| `shareholder_contribution_fields` | 0035 | bounded a contribution's date at the UTC day + 3650 (commitments may be dated up to ten years ahead) |
| `shareholder_setup_workspace` | 0038 | returned `today` as the UTC day |
| `shareholder_contributions_workspace` | 0038 | returned `today` as the UTC day |
| `direct_shareholder_document_holder` | 0040 | dated the attachment holder agreement on the UTC day |
| `validate_shareholder_profile_role` | 0001 | trigger `shareholder_profiles_role_guard`: required a SHAREHOLDER role effective on the UTC day |

**The eighth function was not in the approved list of seven.** It was found while implementing:
the trigger runs on every insert and update of a shareholder profile and requires a role whose
`effective_from <= current_date`. The restated creation function writes that role dated the Kabul
day, so without the trigger the approved acceptance test ("`business_today()` is accepted") fails
in the window with "shareholder profile requires a current SHAREHOLDER business-party role". It is
on the shareholder setup path and affected by exactly this defect, so it is in scope; existing roles
(all effective in the past) behave identically.

Not restated: the frozen E1 functions (`shareholder_capital_workspace`,
`shareholder_create_capital_request`, `treasury_safes_saraf_query`).

## 3. Privileges

One grant: `EXECUTE ON abos.business_today()` to `abos_v1_shareholder_setup_owner`. The seven
SECURITY DEFINER / helper functions run as that owner, and the trigger runs as the role that writes
the profile — only that owner can (the Finance owner's `UPDATE(id)` is lock-only and refused by an
earlier trigger). `CREATE OR REPLACE` keeps every owner, signature, security setting, `search_path`
and existing privilege; the upgrade test proves it function by function. No runtime gains anything.

## 4. Contributions are not "not in the future"

`shareholder_contribution_fields` allows a commitment dated up to ten years ahead. 0042 keeps that
rule and anchors it to the business day: `business_today() + 3650` is accepted,
`business_today() + 3651` is refused. `business_today() + 1` is therefore correctly accepted for a
contribution; the "next day is refused" rule applies to shareholder-since and document dates.

## 5. Tests

`packages/e1-integration/src/shareholder-business-day.test.ts`, written first and run red against
the catalogue without 0042 (the setup workspace reported 2026-10-26 while Kabul was on 2026-10-27).
The boundary is reproduced deterministically by giving the restricted runtime login a session time
zone whose date differs from Kabul's (UTC−12 is a day behind until 16:30 Kabul time, the production
direction; UTC+14 a day ahead from 14:30); the suite asserts it really exercised a differing date.

1. In both time zones: both workspaces report the business day; a shareholder dated the business
   day is accepted and the next day refused; the owner's one-save `direct_shareholder_add` succeeds
   on the business day; contributions accept the business day and +3650 and refuse +3651; the
   attachment holder is dated the business day; a document dated the business day is accepted and
   the next day refused.
2. No restated function reads `current_date`; the setup owner may read the business day; no runtime
   or the frozen lane gains it.
3. Upgrade from a populated 0041 database: exactly 0042 is applied; every table byte-for-byte
   unchanged; 0001–0041 registry rows unchanged; no function added or removed; every function keeps
   owner, security, `search_path` and privileges (only `business_today()` gains the one grant);
   exactly the eight functions change, and only by the date expression; rerun is a no-op.

`admin-approval-upgrade` now applies 0039–0042 on a populated 0038 database.

## 6. Out of scope — follow-up finding D3-F2

Six other operational functions read `current_date` and have the same class of defect on other
lanes. They are deliberately not in 0042 and are recorded in `OPEN_ITEMS.md`:

| Function | Lane | Effect in the 00:00–04:30 Kabul window |
|---|---|---|
| `finance_exchange_rates_view` | exchange rates | `today` and the default range end on the UTC day; Saraf role filter on the UTC day |
| `finance_record_exchange_rate` | exchange rates | accepts up to UTC day + 1, so the Kabul day is still accepted (tolerant) |
| `finance_generate_fiscal_year` | financial calendar | current-year detection on the UTC day (matters only around the new year) |
| `guard_operational_treasury_account`, `guard_saraf_account` | Safe / Saraf setup | counterparty role must be effective on the UTC day |
| `operational_finance_configuration_workspace` | Finance setup | Saraf counterparty list filtered on the UTC day |
| `temporary_funding_workspace` | temporary funding | provider kind (shareholder/employee) judged on the UTC day |

Recommended: one small migration after the posting kernel, same technique and same tests.
