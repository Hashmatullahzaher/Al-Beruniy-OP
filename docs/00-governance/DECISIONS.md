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

