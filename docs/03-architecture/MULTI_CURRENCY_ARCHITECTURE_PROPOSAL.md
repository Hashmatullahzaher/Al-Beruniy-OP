# Multi-Currency Architecture Proposal

**Date:** 2026-09-21  
**Status:** `PROPOSED_FOR_OWNER_CLIENT_APPROVAL`  
**Implementation status:** Not implemented. No database schema, exchange rate, base currency or posting policy is authorized by this proposal.

## 1. Decision Boundary

AL-BERUNIY OS must treat multi-currency as a cross-domain foundation. AFN and USD are mandatory transaction currencies. No implementation may select a company/legal-entity base currency, enable another currency, select an exchange-rate source, apply a rate, define precision or rounding, or recognize exchange gains/losses without approved policy.

This proposal expands existing requirements rather than replacing them:

- `docs/01-product/PRODUCT_REQUIREMENTS.md` requires a multi-company/project/currency platform.
- `docs/02-domain/BUSINESS_RULES.md` requires deterministic decimal arithmetic, balanced entries, immutable corrections and traceability.
- `docs/03-architecture/DATA_MODEL.md` already identifies Currency as a core dimension.
- `docs/03-architecture/SYSTEM_ARCHITECTURE.md` makes Finance authoritative for accounting and requires idempotent events and explicit company/project scope.
- Blueprint 04 includes multi-currency, FX, revaluation and gain/loss in the Finance engine.
- `docs/04-delivery/IMPLEMENTATION_PLAN.md` places Currency in F2 master data and multi-currency transaction fields/FX extension points in F3.
- `docs/00-governance/OPEN_ITEMS.md` deliberately leaves base currencies and accounting policy unresolved.

## 2. Currency Scope

### Required transaction currencies

- **AFN — Afghan Afghani**
- **USD — United States Dollar**

AFN and USD are required capabilities, not a decision about which is the accounting base currency.

### Additional currencies

No additional currency is enabled by this proposal. The client must confirm whether currencies such as EUR, AED or PKR are needed for particular contracts, suppliers, banks, sarafi accounts or reporting. Every enabled currency must have an approved business use, display/decimal rules and rate policy.

### Currency contexts

The model must distinguish:

1. **Transaction currency:** currency agreed on the source event or document.
2. **Account currency:** currency in which a cash, bank or sarafi account operates.
3. **Legal-entity base accounting currency:** currency in which the statutory ledger balances.
4. **Reporting currency:** an approved management/statutory presentation currency.
5. **Project default/display currency:** an optional project preference; it cannot override the legal entity's base currency or a document's transaction currency.

Each legal-entity book must have exactly one approved base currency for an effective period. Any change requires a separately designed conversion/migration, reconciliation and audit process. It must never be an ordinary settings edit.

## 3. Proposed Domain Model

| Record/value | Required content and invariant |
|---|---|
| `Currency` | ISO code, localized name/symbol, enabled state, display minor units and effective history. AFN/USD required; other rows approval-gated. |
| `LegalEntityCurrencyPolicy` | Legal entity, base currency, effective period, approved reporting currencies, status, approval/audit references. |
| `ProjectCurrencyPolicy` | Project, permitted/default transaction currencies and optional reporting/display currency; cannot redefine the legal-entity base currency. |
| `Money` value object | Decimal amount plus currency code. Arithmetic is permitted only for compatible currency unless an explicit approved conversion is supplied. |
| `ExchangeRate` | From/to currencies, quoted rate and direction, rate type/source, effective instant/period, obtained instant, timezone, status, approver, precision, version and immutable audit reference. |
| `ExchangeConversionSnapshot` | Original amount/currency, target amount/currency, exchange-rate ID, rate used, rounding result and initiating source event. Immutable once a financial posting depends on it. |
| `FinancialAccountCurrency` | Cash/bank/sarafi account ID, legal entity, project scope where applicable, one explicit operating currency, institution/counterparty reference and effective state. |
| `JournalLineCurrency` | Original currency/amount where applicable, base debit or credit, exchange-rate/conversion reference and source dimensions. Reporting translations must remain traceable to the applicable rate set. |
| `SettlementCurrencyDetail` | Source obligation currency/amount, settlement account currency/amount, allocation, fees, realized difference and references to both source and settlement records. |

Database/API types must use exact decimals. Binary floating point is prohibited for money, exchange rates, quantities used to calculate money and journal totals. Exact decimal scales, rate precision and rounding modes remain approval items.

## 4. Account and Treasury Model

- Every cash, petty-cash, bank and sarafi account has one explicit currency.
- A legal entity/project may have multiple accounts in the same currency and separate accounts in different currencies.
- A journal line posting to a monetary account must respect that account's currency policy.
- A transfer between accounts in different currencies is an explicit cross-currency conversion with two monetary legs, an approved rate snapshot, separately identified fees and any approved difference posting.
- Sarafi transactions require the same evidence, approval, reconciliation, audit and counterparty controls as bank/cash activity; “sarafi rate” is a rate source/type, never an unrecorded manual override.
- Reconciliation compares account-currency statements/records first, then traces their posted base amounts. It must not compare or net unlike currencies silently.

## 5. Cross-Domain Monetary Events

Every applicable source record carries original currency and amount. When it creates accounting intent or a posting, it also carries the legal entity, project/cost-center dimensions and approved conversion reference.

### Shareholders

- Contributions, loans, commitments and opening balances retain their original currencies.
- Equity contribution and shareholder loan remain distinct legal/accounting classifications.
- An actually received approved equity contribution may produce `Dr Cash/Bank; Cr Paid-in Share Capital`; a shareholder loan credits an approved shareholder payable instead.
- Cross-currency receipt, share-capital denomination, legal evidence, opening-rate treatment and settlement differences require explicit policy.

### Customers and Sales

- Quotations, price lists, reservations, contracts, amendments, installments, receivables, collections, refunds and statements retain their original currencies.
- Contract currency and permitted amendment rules must be controlled and versioned.
- A receipt in another currency requires an explicit conversion/allocation; the system must show both the obligation currency and settlement-account currency.

### Procurement, Suppliers and Expenses

- RFQs, supplier quotations, POs, commitments, GRNs where valued, invoices, AP, payments, expenses, advances and refunds retain original currency.
- PO/invoice/settlement currency mismatches require a governed exception or conversion path.
- Inventory, WIP, fixed assets, prepaid/accrued amounts and project costs post in approved base amounts while retaining source currency lineage.

### Contractors and Employees

- Contractor contracts, IPCs, advances, retentions, recoveries and payments retain original currency.
- Payroll, salary, employee loans/advances and reimbursements must declare currency; payroll/statutory currency rules require approval before implementation.

## 6. Exchange-Rate Lifecycle

The approved policy must define:

1. Authoritative source by currency pair and transaction class: official/central-bank, commercial-bank, sarafi, contractually fixed, negotiated or approved manual source.
2. Direct or inverse quote convention and supported rate types: spot, contractual, transaction, settlement, period-end or average.
3. Applicable date/time: contract date, recognition/posting date, receipt/payment date, settlement date or period-end date as appropriate.
4. Effective timezone, business-day cutoff, holidays and stale/missing-rate behavior.
5. Rate precision, amount precision and rounding method.
6. Approval roles, separation of duties and thresholds for manual/exception rates.

A rate record becomes immutable when referenced by an approved/posted event. A later correction creates a new version and an explicit adjustment/reversal workflow; it never overwrites historical postings. The system records source, operator, approver, timestamps, reason and affected transactions.

## 7. Posting, Settlement and Revaluation

- Finance remains the only posting engine.
- Every posted journal balances in the legal entity's approved base currency: `Σ debit = Σ credit` exactly under the approved precision policy.
- A posting preserves original-currency amount, base-currency amount and the exact rate/conversion snapshot. No service recomputes historical base amounts from the latest rate.
- Missing, stale, unapproved or incompatible rates reject the posting; they never default silently.
- Cross-currency settlement produces an explicit realized exchange difference under approved accounts and policy.
- Period-end revaluation, if approved, operates only on approved monetary balances using an approved closing-rate set. It creates traceable unrealized gain/loss journals and follows an approved reversal/carry-forward policy.
- Reversals link to the original posting and preserve its historical currency/rate/base amounts. A separate current-period adjustment handles any policy-approved difference.
- Subledgers reconcile by original currency and in base currency to their GL controls.
- Idempotency keys prevent duplicate posting/conversion/settlement side effects.

The CoA accounts for realized/unrealized gains, losses, rounding, fees and revaluation are not selected by this proposal.

## 8. Reporting and User Experience Rules

- Every monetary amount displays an ISO currency code; a symbol alone is insufficient where ambiguity is possible.
- Reports expose currency filters and clearly label transaction, base and reporting-currency columns.
- Totals group by currency. “All currencies” may show separate subtotals; it must never sum AFN and USD directly.
- Consolidated/project dashboards either show single-currency values translated under an identified approved rate set or present separate currency totals.
- Drill-down exposes the original amount, base amount, rate, rate source/type, effective date, approval and related posting.
- Export/API/AI responses carry currency codes and rate context. AI must not compare or aggregate different currencies without an authorized conversion tool and cited rate set.

## 9. Security, Workflow and Audit

- Currency master, legal-entity policy, account currency and exchange-rate maintenance require server-side permission checks, project/legal-entity scope, separation of duties and approval.
- Rate creator and approver must be distinct where policy requires it.
- Audit records capture before/after state, source evidence, actor, approver, effective dates and every dependent posting.
- Closed periods block postings and policy/rate changes that would alter closed financial history.
- External/imported rates are authenticated, idempotent and retained with source payload evidence or verifiable source reference.

## 10. Required Validation

Before the first operational finance slice can pass:

- exact-decimal and currency-compatibility unit tests
- rate direction/precision/rounding boundary tests
- rejection of missing, stale, unapproved and mismatched rates
- AFN and USD same-currency and cross-currency posting tests
- balanced base-currency journal and reversal tests
- partial/multiple settlement and realized-difference tests
- approved revaluation/unrealized-difference tests if revaluation is in scope
- per-currency subledger-to-GL and cash/bank/sarafi reconciliation
- idempotency, closed-period, SoD, authorization, project isolation and audit-lineage tests
- report tests proving that unlike currencies are never silently aggregated

## 11. Stage 0 Interface Assessment

The approved Stage 0 interfaces do not need immediate code changes. They contain no operational monetary input, conversion or totals and must remain visually locked.

Small non-operational indicators may be considered in a separately approved UI patch:

- a compact project-context badge such as `Currency policy pending` or `Planned transaction currencies: AFN · USD`
- explicit currency-code columns beside every future demonstration amount
- a currency filter in Finance/Reports that groups synthetic rows without converting them
- locked Settings cards for legal-entity base currency, reporting currencies and rate sources, all marked `Not configured · approval required`
- tooltips stating that no conversion is being performed in Stage 0

These indicators must use the existing components, spacing and typography; contain no rate, converted value or selected base currency; and require visual approval before changing the locked design.

## 12. Approval Questionnaire

The owner/client must answer these before dependent schema or posting work:

1. What is the base accounting currency for each company/legal entity?
2. Which statutory and management reporting currencies are required?
3. What currency defaults or restrictions apply to each project?
4. Beyond AFN and USD, which transaction currencies are required now?
5. Which exchange-rate sources are authoritative for each currency pair and transaction type?
6. Are bank, sarafi, contractual and approved manual rates allowed, and under what evidence/approval rules?
7. What quote direction, effective timezone, daily cutoff, holiday and stale-rate rules apply?
8. Which date determines the rate for contracts, invoices, receipts, payments, expenses, shareholder receipts and period-end reporting?
9. What decimal scales and rounding modes apply to money, unit prices, quantities, rates and base/reporting amounts?
10. Who may create, approve, correct and activate rates? What separation-of-duties or thresholds apply?
11. Can a contract, installment schedule, PO, supplier invoice, payroll item or shareholder agreement change currency after approval? If so, through which amendment workflow?
12. How should cross-currency collections/payments be allocated, including partial settlement, fees and over/underpayments?
13. Which accounts and recognition rules apply to realized exchange differences?
14. Which balances are revalued, how often, using which rate, and how are unrealized differences and reversals handled?
15. What cash, bank and sarafi accounts exist, and what is the currency/project/legal-entity scope of each?
16. How are shareholder contributions, shareholder loans, commitments and opening balances denominated and evidenced?
17. What migration/opening rate and reconciliation evidence are required for pre-existing foreign-currency balances?
18. What tax, statutory statement, customer/supplier statement and currency-presentation rules apply?

Approval must identify the approver, decision date, effective scope and accepted exceptions. Until then, this proposal is a design contract only and Stage 1 database/posting implementation remains blocked by policy decisions.
