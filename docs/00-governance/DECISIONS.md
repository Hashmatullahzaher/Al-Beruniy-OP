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

