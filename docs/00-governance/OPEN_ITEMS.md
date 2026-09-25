# Open Items

## Status after the owner decisions of 2026-09-25

The owner decisions recorded in `DECISIONS.md` (section *Owner decisions — V1 scope and policy — 2026-09-25*) resolve or narrow some items below. Each affected line is tagged **[Resolved 2026-09-25]**, **[Partly resolved 2026-09-25]** (with what is still open) or **[Out of V1]** (deferred, still open for a later release). Every untagged item remains open. Still pending from the owner, to be shown as labelled placeholders and never invented: legal name and registration number, go-live date, and the Excel opening-balance layout.

Do not invent these. Resolve with stakeholders/official sources before dependent implementation: approval thresholds; final org/project role matrix; fiscal calendar/base currencies (**[Partly resolved 2026-09-25]** base currency USD; financial year is a per-company setting — solar Hijri from 1 Hamal, Gregorian Jan–Dec or custom; period-close authority still open); final CoA/cost centers (**[Partly resolved 2026-09-25]** no fixed CoA is shipped — permitted users add accounts with duplicate warnings and Finance Manager review; cost centers still open); IFRS revenue recognition election; inventory valuation; tax/statutory rules; reservation/discount/penalty/waiver/refund/reschedule rules; handover policy; RFQ bid rules; 3-way-match tolerances; contractor retention/advance/DLP rules; payroll/leave/overtime policies; cloud/region/IdP/provider choices (**[Partly resolved 2026-09-25]** V1 runs on an online server reachable from anywhere; provider, region and IdP still open); bank/payment/messaging/BIM/biometric integrations (**[Out of V1]** banks and Telegram messaging); RPO/RTO; AI provider/data-residency constraints (**[Out of V1]** AI).

## V1 blockers

- ~~SECURITY DEFINER function ownership review~~ **Resolved 2026-09-25** by migration 0011 (least-privilege owners, independently reviewed); see `docs/04-delivery/V1_SECURITY_DEFINER_OWNERSHIP.md`. Still blocking real posting: tables owned by the superuser migration identity, the synthetic-only sandbox gate, and operational controls (backups, audit logging, alerts).
- **Decision needed (Finance Manager): accounting-period authority.** Who may open, soft-close, close and reopen a period, and whether closing needs a second approver. Until decided, generated fiscal-year periods stay PENDING and no period can be opened in the application.
- **Decision needed (Finance Manager): existing ad-hoc periods.** Whether a fiscal year may absorb a period created before the calendar (today it is refused as an overlap).

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

