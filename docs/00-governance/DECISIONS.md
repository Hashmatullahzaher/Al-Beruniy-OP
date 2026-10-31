# Decisions
- Repository documentation is the durable source of truth; chat is not.
- Blueprint review precedes authoritative demo/build.
- Project independence and corporate consolidation coexist in one data model.
- Finance is the central posting engine.
- Type A user, Type B party and Type C ledger accounts are distinct.
- One shared workflow engine governs approvals.
- Posted finance is immutable; corrections use reversal/adjustment.
- AI is permission-bounded and tool/domain-service mediated.
- Material transactions support forward and reverse traceability.
- Exact-SHA discipline is required for build/audit handoffs.
- AI Core is a cross-cutting enterprise intelligence control plane built as a foundation and expanded with every domain, not a standalone late-stage chatbot.
- All LLM access goes through a provider-neutral Model Gateway; no domain module calls an LLM provider directly.
- The AI enterprise knowledge plane may index cross-system knowledge under explicit machine identity and security tags, but user retrieval/actions are always permission-trimmed.
- Telegram is an official governed AI/notification channel and must reuse ABOS identity, permissions, workflow, finance and audit rather than implement parallel business logic.
- Multi-currency is a mandatory cross-domain foundation for every relevant business module, not a later Finance add-on. AFN and USD must be supported as transaction currencies; legal-entity base currency, reporting currencies, additional supported currencies, exchange-rate policy, precision, revaluation and gain/loss policy remain explicit approval gates.

## Stage 1 E0 engineering gate — 2026-09-22

- The Stage 1 implementation order coordinated from `agent/coordination/stage-1-finance-contract` at `999a5335521fac5a9ac9b01b9e5d8261c47424d5` opens only the **E0 code-safe foundation** described in that contract. The approved Stage 0 reference remains `agent/codex/WP-0001-command-center-rebuild` at `a4ff484d357d22ba60ab1efd1650022bde9ab43c`.
- E0 is limited to shared typed contracts, development/test database and migration foundations, API/service-boundary foundations, authorization/audit scaffolding, test infrastructure, draft Shareholder/Treasury contracts and a non-operational Finance invariant/test kernel. It does not permit real opening balances, real posting, official statements, production deployment or expansion to later slices.
- USD and AFN are the transaction-currency types required by the E0 contracts. Legal-entity base accounting currency remains an explicit Finance Manager approval gate and must not be activated from a test fixture or implicit default.
- The current slice models physical cash locations/safes and later Saraf boundaries. It has no bank account or bank integration. A Saraf, physical safe, Business Party and Ledger Account remain distinct.
- Finance remains the sole future General Ledger posting authority. Shareholder and Treasury domains may prepare or verify source records but cannot write journals or mutate posted history.
- All policy-dependent operations remain fail-closed until the Finance Manager decisions are recorded. Synthetic fixtures are isolated development/test data, not verified company records.


## Owner decisions — V1 scope and policy — 2026-09-25

Recorded by the builder (Claude Code) on `v1/integration` as instructed by the executive director; approved by the owner.

- **Product direction.** ABOS is built for AL-BERUNIY first; the charter stands. Nothing company-specific is hard-coded: every policy is a per-company setting, so the product can later be offered to similar companies. Multi-customer hosting is a **future** direction only: the data model must stay compatible with it, but it is not built in V1.
- **Hosting.** V1 runs on an online server, accessible from anywhere.
- **Currency.** Base currency is USD; AFN is fully supported. The market/Saraf exchange rate is entered daily by a permitted user, and every transaction keeps an immutable snapshot of the rate it used.
- **Financial year.** Configured per company: solar Hijri (starting 1 Hamal), Gregorian January–December, or a custom year. Reports are viewable in either calendar.
- **Chart of accounts.** No fixed chart of accounts is shipped. A permitted user adds accounts instantly; the system warns on likely duplicates; the Finance Manager receives a review list of newly created accounts. Safes and Saraf accounts are accounts created the same way.
- **Users and roles.** A super admin creates users and custom roles freely from a permission catalogue. Segregation of duties is enforced server-side and cannot be configured away: nobody approves their own transaction.
- **Shareholder money.** Each shareholder transaction is classified as capital **or** loan, chosen per transaction.
- **Cash count.** Both modes are supported and selectable: count only the money received, or count the whole safe.
- **Reversal.** A Finance user requests a reversal and the Finance Manager approves it. Posted history stays immutable.
- **V1 money locations.** Cash safes and Saraf accounts only. No banks in V1.
- **Opening balances.** Imported from Excel; the owner will provide the layout.
- **Pending — use labelled placeholders, never invent values:** legal name and registration number; go-live date; the Excel opening-balance layout.
- **Out of V1:** banks, Sales, Construction, Procurement, HR/Payroll, AI, Telegram.


## Owner decisions — simple operating system — 2026-10-26 (morning)

Recorded by the builder (Claude Code) from the owner's written instructions; the basis for reshaping
migration 0040 (`claude/v1-simple-capital`, reviewed and merged to `v1/main`).

- **One save.** Adding a shareholder and the money they put in is one screen and one save; later
  money is "Add money" on the shareholder's card. No capital request, eligibility review, agreement,
  installment schedule, custody verification, handoff, prepare/approve/post buttons or ownership
  percentage in the ordinary flow.
- **Four ways in:** cash into a Safe; hawala into a Safe (the saraf's name and reference kept on the
  record); an asset (one "shareholder contributed assets" account); a company bill the shareholder
  paid directly (debits the chosen expense account). Bank transfer is out for now.
- **Agreed total is optional** and blank by default; capital is what was actually contributed.
- **Months open themselves** on the first valid posting into a pending month of the financial year.
- **Overspending warns, never blocks:** an expense larger than the account's recorded balance shows
  the figure and asks the person to confirm.
- **Existing records are kept** (three shareholders, one declared total); nothing is deleted.

## Owner decisions — target architecture — 2026-10-26

Approved with modifications on the Senior Project Architecture Review of 2026-10-26. The revised
plan is `Claude outputs/ABOS_REVISED_ARCHITECTURE_PLAN_AND_SLICE_1.md` (outside the repository);
these decisions are the durable record.

1. Retire E1 synthetic screens from the operational product. Keep legacy tables frozen for
   history/tests; do not destructively delete them.
2. Adopt one canonical Safe model based on `operational_treasury_accounts`.
3. Auto-open periods on first valid posting. Closing requires `finance.period.manage`. Reopening
   must use a separate explicit permission, require a reason and audit, with optional/required
   second-person control in Advanced Mode.
4. Complete reversal posting. If the original period is open, post against that period/date; if
   closed, post in the current open period while linking immutably to the original journal. Simple
   Mode may allow direct reversal only to a specifically authorized Finance user with mandatory
   reason and audit.
5. Adopt a default FX rounding policy, but keep precision/rounding and FX-difference account
   configuration company/currency aware.
6. Opening balances are entered as normal audited transactions in the application. Excel is a
   future bulk-import convenience, not a blocker.
7. Unify shareholder capital and shareholder loan/temporary funding in one Add Money experience with
   a Capital / Loan choice; preserve different accounting underneath.
8. Capital agreements and installments become optional informational planning records only. They
   must never gate normal capital receipt.
9. In Advanced Mode, capital control is reduced to one independent confirmation. Simple Mode posts
   directly on save.
10. Provide an optional starter Chart of Accounts template. Never force a fixed chart.
11. Establish one official trunk immediately and stop deploying from personal branches.
12. Public production hosting waits for identity hardening, automated backups and CI. Controlled
    staging may happen earlier.

Additional architecture requirements:

- One operational lane per business event. One Safe model. One capital/loan entry experience. One
  generalized document vault. One posting kernel plus a source registry.
- Do not create another giant copied validator. Shared invariants belong in the kernel;
  source-specific rules must remain modular and registry-driven.
- Simplify user-visible permissions, but do not weaken backend authorization boundaries.
- Preserve database-enforced least privilege, immutable posted records, exact decimals, legal-entity
  isolation, idempotency, concurrency protection, audit and upgrade fingerprints.
- Simple Operational Mode is the default. Advanced Controls are policy applied to the same
  transaction lanes, never separate implementations.

Slice 1 was approved on 2026-10-27 with two modifications: the `packages/sandbox-auth` rename is
deferred out of Slice 1, and `/shareholders/legacy` must expose no action that depends on a retired
API. The official trunk is `v1/main`, created at the production SHA `817974a9947bdab967f0f1a0f7a1fc4d25bb777b`.

## Owner decisions — Slice 4 corrections — 2026-10-28

Slice 4 source (0047/0048) was accepted. Its production deployment is held for these corrections,
implemented in migration 0049 (`docs/03-architecture/MONEY_MOVEMENTS.md` section 5).

1. **Negative balances.**
   - SAFE, CASH_BOX and PETTY_CASH must never go below zero. This is enforced transactionally in PostgreSQL, is concurrency-safe and is based on posted movements; it is not a UI warning.
   - SARAF may go below zero, because a negative net position is an amount owed to the Saraf.
2. **Simple Mode approval defaults.** A missing approval setting for a routine workflow means approval OFF. An explicit ON is never weakened. A switch whose lane has no Advanced pending/confirm path must not be able to make the workflow unusable; it is shown as unavailable until Advanced Controls exist.
3. **Attachments** on receipts and payments are deferred to the generalized document-vault slice.

## Owner decisions — Slice 5 corrections — 2026-10-29

Implemented by amending 0050 before it was deployed. The amendment is the same migration, with a new checksum.

1. **Simple Mode self-correction approved.**
   - A user with `finance.reversal.direct` may reverse a transaction they recorded or approved.
   - Conditions: a mandatory reason; an immutable original; a new exact-inverse journal; an immutable link.
   - The link records `reversal_mode = DIRECT` and `self_reversal = true`, and the audit flags `selfReversal`.
   - Duplicate and concurrent reversal stay impossible.
   - Advanced Mode (independent approval) keeps database-enforced independence: nobody approves their own reversal.
2. **The opening balance shown is the effective accounting amount.** A fully reversed 2,500 opening balance shows 0; the book still derives from posted movements; the original opening balance, its reversal and their links stay visible. The read model changes, not the history.
3. **Capital declaration allocations after a reversal: deferred.** This is legacy capital cleanup debt, to be normalized when the retired capital-request / declaration model is consolidated.

## Owner decisions — Slice 6 FX difference account — 2026-10-31

Implemented by amending 0051 before it was deployed. The amendment is the same migration, with a new checksum.

1. **No FX difference account is required for ordinary foreign-currency postings.**
   - Such a posting uses one immutable rate snapshot for the whole business event and balances exactly in the accounting currency after the configured rounding. No realized or unrealized FX difference arises.
   - It covers the AFN receipt, Safe or Saraf funding, expense, payment and same-currency transfer.
2. **The FX difference account is mandatory only for a source that can produce an FX difference:** AFN ↔ USD exchange, settlement at a rate different from the original recognition rate, revaluation, or any other such source.
   - Such a source refuses with a clear setup error when the account is missing.
   - The account is never created automatically.
3. **Cross-currency Treasury transfers stay refused.** A transfer never becomes an implicit currency exchange. Currency exchange will be its own explicit source through the posting kernel, once its FX-difference accounting is designed.
4. **The corrected `finance.reversal.direct` description stays in 0051.** In Simple Mode an authorized user may reverse their own transaction with a mandatory reason and full audit; Advanced Mode independence stays separate.

## Owner correction — Financial Year Close, not Month Close — 2026-10-31

Implemented by the corrective migration `0052_v1_financial_year_close`. 0050 is applied and is not changed. No row is deleted.

1. **Al-Beruniy has no user-facing monthly close or reopen.**
   - Months remain internal: date grouping, reporting, the trial balance, the fiscal calendar and period selection.
   - Months open themselves when something dated in them is recorded.
   - Nobody operates "Close month" or "Reopen month", and there is no monthly reopen approval.
2. **Financial Year Close.**
   - While a financial year is active, transactions post on valid dates within it.
   - At year end an authorized Finance user (`finance.period.manage`) closes the financial year after a preview.
   - After the close: posting into the year is refused; historical journals stay immutable; reports stay available.
3. **Reopening a closed financial year is not offered.** If ever required, it must be a separate high-risk year-level action with explicit permission, a mandatory reason and full audit. No monthly reopen concept exists.
4. **`finance.period.reopen` is retired** (it existed only for the monthly design), and the `PERIOD_REOPEN` approval setting is withdrawn.
5. **The reversal rule is translated mechanically, not changed.** A reversal posts on the original date while the original's financial year is active, otherwise on the business day in the current financial year. The self-correction, immutable links and opening-balance behaviour of 2026-10-29 are unchanged.
