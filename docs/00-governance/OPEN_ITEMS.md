# Open Items
Do not invent these. Resolve with stakeholders/official sources before dependent implementation: approval thresholds; final org/project role matrix; fiscal calendar/base currencies; final CoA/cost centers; IFRS revenue recognition election; inventory valuation; tax/statutory rules; reservation/discount/penalty/waiver/refund/reschedule rules; handover policy; RFQ bid rules; 3-way-match tolerances; contractor retention/advance/DLP rules; payroll/leave/overtime policies; cloud/region/IdP/provider choices; bank/payment/messaging/BIM/biometric integrations; RPO/RTO; AI provider/data-residency constraints.

## Multi-Currency Open Items
Resolve before F2 currency masters, F3 Finance Kernel, or any dependent operational transaction implementation:
- base accounting currency for each company/legal entity
- management/statutory reporting currencies and project-level currency defaults or restrictions
- additional transaction currencies beyond mandatory AFN and USD
- authorized exchange-rate sources by currency pair and transaction type, including bank/sarafi/contract rates
- rate direction, rate types, effective date/time, timezone/cutoff, staleness rules and approval authority
- currency amount, FX rate, base amount and reporting amount precision/rounding rules
- treatment of missing, corrected or retrospectively invalid rates
- realized and unrealized exchange gain/loss accounts and recognition policy
- period-end revaluation scope, frequency, rate and reversal policy
- cross-currency settlement, allocation, fees and cash/bank/sarafi transfer policy
- permitted contract, installment, receipt, supplier invoice, expense, payroll and shareholder transaction currency changes
- shareholder equity versus loan classification, opening balances and migration-rate evidence
- tax/statutory currency and presentation requirements

## Stage 1 E0 Finance Manager Approval Gates

The following items remain `CLIENT_FINANCE_PENDING`. Provisional inputs may be represented as non-operational configuration states for contract testing, but they must not activate accounting. Record the Finance Manager response as a new versioned decision and retain any difference from earlier proposals.

- legal name and identifier of the first operating legal entity, and its approved base accounting currency
- approved Chart of Accounts, account codes and control-account relationships for office cash, paid-in capital, shareholder loans, capital pending registration and corrections
- fiscal calendar, accounting periods, period-close authority and the first permitted accounting-effective date
- evidence requirements for capital agreements, registration, receipt/count and Finance approval
- accounting treatment of funds received before formal capital registration is complete
- opening-balance cutoff, source records, GL counterpart, reconciliation evidence, discrepancy handling and approval chain
- activation criteria for each physical cash-location × currency account, including tolerances or exceptions
- production safes/cash locations, responsible cashiers and approved currency accounts
- final server-side permission matrix, segregation-of-duties conflicts, Finance approver authority, limits, substitutes and step-up requirements
- monetary amount scale, FX-rate precision and rounding rules for storage, validation, posting and display
- exchange-rate source, rate category, effective date/time, timezone, cutoff, staleness and evidence for each future cross-currency transaction
- realized/unrealized exchange-difference accounts and policy, revaluation scope/frequency/rate/reversal policy, and settlement-difference treatment
- Saraf acknowledgement, company confirmation, reconciliation thresholds, exception authority, spread/fee treatment and custody/receivable/payable classification
- reversal versus adjustment authority, reason/evidence requirements, period treatment and reporting presentation
- operational-report scope during phased openings and the exact gate for company-wide financial statements
- retention, numbering, signing and audit requirements for capital, cash, approval and journal evidence

Until these are resolved, E0 must reject or withhold requests requiring the missing policy. No fallback rate, balancing account, assumed opening balance, automatic project attribution or permissive authorization default is allowed.

## AI Core / LLM / Telegram Open Items
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

