# Open Items

## Status after the owner decisions of 2026-09-25

The owner decisions recorded in `DECISIONS.md` (section *Owner decisions — V1 scope and policy — 2026-09-25*) resolve or narrow some items below. Each affected line is tagged **[Resolved 2026-09-25]**, **[Partly resolved 2026-09-25]** (with what is still open) or **[Out of V1]** (deferred, still open for a later release). Every untagged item remains open. Still pending from the owner, to be shown as labelled placeholders and never invented: legal name and registration number, go-live date, and the Excel opening-balance layout.

Do not invent these. Resolve with stakeholders/official sources before dependent implementation: approval thresholds; final org/project role matrix; fiscal calendar/base currencies (**[Partly resolved 2026-09-25]** base currency USD; financial year is a per-company setting — solar Hijri from 1 Hamal, Gregorian Jan–Dec or custom; period-close authority still open); final CoA/cost centers (**[Partly resolved 2026-09-25]** no fixed CoA is shipped — permitted users add accounts with duplicate warnings and Finance Manager review; cost centers still open); IFRS revenue recognition election; inventory valuation; tax/statutory rules; reservation/discount/penalty/waiver/refund/reschedule rules; handover policy; RFQ bid rules; 3-way-match tolerances; contractor retention/advance/DLP rules; payroll/leave/overtime policies; cloud/region/IdP/provider choices (**[Partly resolved 2026-09-25]** V1 runs on an online server reachable from anywhere; provider, region and IdP still open); bank/payment/messaging/BIM/biometric integrations (**[Out of V1]** banks and Telegram messaging); RPO/RTO; AI provider/data-residency constraints (**[Out of V1]** AI).

## V1 blockers

- ~~SECURITY DEFINER function ownership review~~ **Resolved 2026-09-25** by migration 0011 (least-privilege owners, independently reviewed); see `docs/04-delivery/V1_SECURITY_DEFINER_OWNERSHIP.md`. Still blocking real posting: tables owned by the superuser migration identity, the synthetic-only sandbox gate, and operational controls (backups, audit logging, alerts).
- ~~Accounting-period authority~~ **Resolved 2026-10-26** (`DECISIONS.md`, target architecture #3): months open themselves on the first valid posting; closing needs `finance.period.manage`; reopening needs a separate permission, a reason and an audit record, with a second person optional or required in Advanced Mode. Built so far: auto-open for capital (0040) and for expenses recorded through `operational_expense_record` (0040); manual open on Finance setup (0027). Built in Slice 5 (0050): close (`finance.period.manage`), reopen (`finance.period.reopen`, reason, history, Advanced second person).
- **Decision needed (Finance Manager): existing ad-hoc periods.** Whether a fiscal year may absorb a period created before the calendar (today it is refused as an overlap).
- **Decision needed (Finance Manager): shareholder loan posting (#14).** The liability ledger account class to credit for loan principal, the evidence a loan receipt requires, and whether loan agreements follow the same funding-decision and commitment rules as capital. Until decided, a loan agreement is visible but cannot enter the request or posting pipeline, even through privileged SQL (`shareholder-loan-v1.test.ts`).
- ~~Reversal posting (#17)~~ **Resolved 2026-10-26** (`DECISIONS.md`, target architecture #4): post against the original period and date when that period is open, otherwise in the current open period with an immutable link to the original; the written reason is the evidence; Simple Mode allows direct reversal only to a specifically authorized Finance user with a mandatory reason and audit. Built in Slice 5 (0050): the REVERSAL source posts directly (Simple Mode, `finance.reversal.direct`) or on approval (Advanced Mode).
- ~~FX posting policy (#12)~~ **Resolved 2026-10-26** (`DECISIONS.md`, target architecture #5): a default rounding policy applies, with precision/rounding and the FX-difference account configurable per company and currency. Still to build (planned Slice 6); until then AFN is custodied and snapshotted but never posted to the USD ledger.
- ~~Opening-balance Excel layout (#18)~~ **Resolved 2026-10-26** (`DECISIONS.md`, target architecture #6): opening balances are entered as normal audited transactions in the application; Excel is a future bulk-import convenience. Still to build (planned Slice 3).
- **Decision needed (owner):** legal name and registration number (#8), go-live date (#21), and hosting/deployment authorization (#7) — public hosting waits for identity hardening, automated backups and CI (target architecture #12).
- **Decision needed (owner/security): identity production controls (#6).** MFA method for administrators and approvers, the out-of-band channel for temporary passwords and self-service reset, `login_attempts` and audit retention periods, the signing-secret rotation procedure, and edge rate limiting at the chosen host. The database privilege boundary, atomic session rotation and session revocation on password change are done (0021, 0022).
- ~~May a Safe or Saraf account go below zero? (Slice 4)~~ **Resolved 2026-10-28** (owner decision 1): a Safe, cash box or petty-cash account can never go below zero; a Saraf account may (a negative position is an amount owed to the Saraf). Enforced in PostgreSQL by 0049 for every lane that takes money out, under a row lock on the Treasury account, from posted movements only.
- **Known limitation until Slice 6 (FX / AFN): AFN Safes cannot receive ordinary operational inflows yet.**
  - The money lanes (receipts, opening balances, capital) are base-currency (USD) only.
  - An AFN Safe, cash box or petty cash therefore holds no book funds, so AFN payments or expenses from it are refused.
  - This is not a defect in the 0049 non-negative guard, which correctly sees no money. It is the missing Slice 6 capability, and 0049 deliberately does not address it.
  - Production has only the USD Safe کسه.
- **Decided 2026-10-28 for Slice 4: BANK and OTHER Treasury accounts stay unlimited.** BANK is outside the current V1 operational scope and will later need an explicit overdraft / credit-limit policy; OTHER stays unchanged until its business meaning is defined.
- **Partly resolved 2026-10-28 (owner decision 2): approval for receipts, transfers and payables.** Simple Mode is the default: a workflow without a saved setting records in one save (0049). Approval ON cannot be saved for other income, transfers, supplier and salary payments or customer receipts until Advanced Controls add their pending/confirm path; an explicit ON saved earlier is still honoured (the movement is refused with a clear message). Still open: the Advanced Controls approval path for these lanes, and who approves.
- ~~Attachments on money movements (Slice 4)~~ **Deferred 2026-10-28** (owner decision 3) to the generalized document-vault slice; no separate document store is built for Slice 4.
- **Decision needed (owner): segregation of duties for reversals in Simple Mode (Slice 5, 0050).** The existing conservative rule stays: whoever prepared, approved or posted a journal can neither reverse it directly, request its reversal, nor approve it. In a one-person company nobody could then correct that person's postings. Decide whether Simple Mode may let the poster reverse their own posting (with reason and audit), or keep the rule.
- **Known presentation point (Slice 5): a reversed opening balance.** The Safe's book balance is correct after an opening balance is reversed and re-entered. The "Opening balance" figure on the Safe card still sums every OPENING_BALANCE movement, while the reversal shows under "Money out". Decide whether reversals of opening balances should net inside the opening figure.
- **Known limitation (Slice 5): capital declaration allocations after a reversal.** A reversed direct-capital receipt keeps its allocation against an optional capital declaration. Capital balances and the workspace figures are correct; only the frozen legacy request lane reads allocations. Exclude reversed receipts there in a later slice.
- **Not in Slice 5: reversing temporary funding and its settlements.** Their payable lineage (remaining amount, settlement status) needs its own design; their reversal stays refused.
- **Migration numbering.** 0018 was never created and is permanently retired; see `docs/04-delivery/V1_PHASE2_TAKEOVER_REVIEW.md` §4.

- V1 identity (client preview, `feat/v1-identity-admin`): production hardening before real users. Out-of-band credential delivery and dual control for sensitive password resets (review C-02); multi-factor authentication for administrators and approvers; password reset flow; session refresh; retention for `login_attempts`; trusted-proxy configuration and edge rate limiting for sign-in. See `docs/04-delivery/v1-client-preview/README.md` §I and `docs/04-delivery/V1_DELIVERY_BACKLOG.md`.

## Multi-Currency Open Items
Resolve before F2 currency masters, F3 Finance Kernel, or any dependent operational transaction implementation:
- base accounting currency for each company/legal entity — **[Resolved 2026-09-25]** USD
- management/statutory reporting currencies and project-level currency defaults or restrictions
- additional transaction currencies beyond mandatory AFN and USD
- authorized exchange-rate sources by currency pair and transaction type, including bank/sarafi/contract rates — **[Partly resolved 2026-09-25]** market/Saraf rate entered daily by a permitted user, with an immutable rate snapshot on each transaction; contract rates and per-transaction-type rules still open
- rate direction, rate types, effective date/time, timezone/cutoff, staleness rules and approval authority
- currency amount, FX rate, base amount and reporting amount precision/rounding rules
- treatment of missing, corrected or retrospectively invalid rates
- realized and unrealized exchange gain/loss accounts and recognition policy
- period-end revaluation scope, frequency, rate and reversal policy
- cross-currency settlement, allocation, fees and cash/bank/sarafi transfer policy
- permitted contract, installment, receipt, supplier invoice, expense, payroll and shareholder transaction currency changes
- shareholder equity versus loan classification, opening balances and migration-rate evidence — **[Partly resolved 2026-09-25]** capital or loan is chosen per transaction; opening balances come from an Excel import (layout pending from the owner); migration-rate evidence still open
- tax/statutory currency and presentation requirements

## Stage 1 E0 Finance Manager Approval Gates

The following items remain `CLIENT_FINANCE_PENDING`. Provisional inputs may be represented as non-operational configuration states for contract testing, but they must not activate accounting. Record the Finance Manager response as a new versioned decision and retain any difference from earlier proposals.

- legal name and identifier of the first operating legal entity, and its approved base accounting currency — **[Partly resolved 2026-09-25]** base currency USD; legal name and registration number still pending (placeholder)
- approved Chart of Accounts, account codes and control-account relationships for office cash, paid-in capital, shareholder loans, capital pending registration and corrections — **[Partly resolved 2026-09-25]** no fixed CoA is shipped; permitted users create accounts (including safes and Saraf accounts) with duplicate warnings and a Finance Manager review list; the specific control-account relationships still open
- fiscal calendar, accounting periods, period-close authority and the first permitted accounting-effective date — **[Partly resolved 2026-09-25]** financial year is a per-company choice (solar Hijri from 1 Hamal, Gregorian or custom; reports in either calendar); period-close authority and first effective date (go-live date pending) still open
- evidence requirements for capital agreements, registration, receipt/count and Finance approval
- accounting treatment of funds received before formal capital registration is complete
- opening-balance cutoff, source records, GL counterpart, reconciliation evidence, discrepancy handling and approval chain — **[Partly resolved 2026-09-25]** source is an Excel import (layout pending from the owner); the rest still open
- activation criteria for each physical cash-location × currency account, including tolerances or exceptions — **[Partly resolved 2026-09-25]** cash count supports both modes (money received only, or the whole safe), selectable; tolerances and exceptions still open
- production safes/cash locations, responsible cashiers and approved currency accounts
- final server-side permission matrix, segregation-of-duties conflicts, Finance approver authority, limits, substitutes and step-up requirements — **[Partly resolved 2026-09-25]** a super admin creates users and custom roles from a permission catalogue; server-side SoD cannot be configured away and nobody approves their own transaction; limits, substitutes and step-up still open
- monetary amount scale, FX-rate precision and rounding rules for storage, validation, posting and display
- exchange-rate source, rate category, effective date/time, timezone, cutoff, staleness and evidence for each future cross-currency transaction
- realized/unrealized exchange-difference accounts and policy, revaluation scope/frequency/rate/reversal policy, and settlement-difference treatment
- **[Partly resolved 2026-09-25]** Saraf accounts are V1 money locations, created like any other account; the following remain open: Saraf acknowledgement, company confirmation, reconciliation thresholds, exception authority, spread/fee treatment and custody/receivable/payable classification
- reversal versus adjustment authority, reason/evidence requirements, period treatment and reporting presentation — **[Partly resolved 2026-09-25]** a Finance user requests a reversal and the Finance Manager approves; posted history stays immutable; reason/evidence, period treatment and presentation still open
- operational-report scope during phased openings and the exact gate for company-wide financial statements
- retention, numbering, signing and audit requirements for capital, cash, approval and journal evidence

Until these are resolved, E0 must reject or withhold requests requiring the missing policy. No fallback rate, balancing account, assumed opening balance, automatic project attribution or permissive authorization default is allowed.

## AI Core / LLM / Telegram Open Items

**[Out of V1]** AI and Telegram are out of V1 (owner decision 2026-09-25). These items stay open for a later release.
Resolve before dependent production configuration:
- approved LLM provider(s), model families and regions
- provider authentication mode per provider: API key, service account, OAuth/provider sign-in or private endpoint
- provider data retention/training terms and allowed data classifications
- model routing/fallback/cost quotas
- AI prompt/output retention and redaction policy
- enterprise knowledge-index retention/rebuild policy
- machine-identity permissions for background AI monitoring
- Telegram bot ownership and production bot token
- Telegram webhook domain/secret and environment separation
- Telegram allowed actions, step-up authentication policy and group-chat policy
- Telegram notification categories and recipient rules
- **Known defect D3-F2 (scheduled, no decision needed): UTC day outside the shareholder lane.** Six operational functions still judge "today" on PostgreSQL's `current_date` (UTC on production) instead of the Kabul business day (`abos.business_today()`): exchange-rate view and recording, fiscal-year generation, the Safe and Saraf account guards, the Finance-setup workspace and the temporary-funding workspace. Effects are limited to 00:00-04:30 Kabul time; details and the fix plan are in `docs/04-delivery/V1_SHAREHOLDER_BUSINESS_DAY_0042.md` section 6. The shareholder setup lane itself is fixed by 0042.
  - Slice 3 review (2026-10-27): not folded into the Safe migrations. Exact functions and severity: `finance_exchange_rates_view` (low: `today` and default range end a day early in the window); `finance_record_exchange_rate` (none in practice: it accepts up to the UTC day + 1); `finance_generate_fiscal_year` (low: only around the new year); `guard_operational_treasury_account` and `guard_saraf_account` (low: a Saraf counterparty role starting on the Kabul day is not yet effective, so creating that Saraf account waits until 04:30; 0046 restates the Treasury guard for the CLOSED lifecycle and deliberately keeps its `CURRENT_DATE` unchanged); `operational_finance_configuration_workspace` (low: the Saraf counterparty list uses the UTC day); `temporary_funding_workspace` (low: provider kind judged on the UTC day). None affects a Safe balance, an opening balance (which uses `abos.business_today()`), or any posting. Recommended: one small dedicated migration in the next slice.
- **Test-harness debt TH-1 (not financial-product debt): browser fixtures write disposable credentials into the source tree.** `packages/e1-integration/scripts/direct-capital-preview.ts` writes its disposable preview configuration and demo credentials to `test-results/direct-capital/` inside the checkout, which on this machine is the protected Desktop worktree. Move fixture configuration and credentials to a private location outside the source tree (for example a path passed by environment variable under `%LOCALAPPDATA%\AlBeruniyOS`) before the real-database browser posting spec is run again. Accepted by the owner on 2026-10-27 as not blocking 0043/0044, whose posting semantics are covered by the accounting-equivalence suite.
  - Progress (2026-10-27): the Slice 3 real-database browser check (`AlBeruniyOS/config/tools/slice3_safes_browser.mts`) keeps every disposable credential and setting in the private AlBeruniyOS directory and passes them to the dev server through its environment, never through the source tree or a command line. The older `direct-capital-preview.ts` still writes to `test-results/` and remains to be moved.
- **Engineering debt ED-1 (found deploying 0045/0046): three older production constraints differ in text from a fresh install.** `financial_calendar_settings_reporting_calendars_check`, `journal_reversal_requests_reason_check` and `journal_reversal_requests_decision_note_check` contain carriage-return characters on production (migrations applied from a Windows checkout), so their definitions differ from a fresh install by those characters. Present before Slice 3, unchanged by it. Review whether the stored expressions behave identically and, if not, restate them in a small migration.
- **Engineering debt ED-2: some POST routes validate input before checking the session.** `/api/v1/finance/safes` and `/api/v1/finance/operations/expenses` answer 422 (not 401) to an unauthenticated malformed request; no database call is made and nothing is written. Prefer authenticating first for a uniform answer.
