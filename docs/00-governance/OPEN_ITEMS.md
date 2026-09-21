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

