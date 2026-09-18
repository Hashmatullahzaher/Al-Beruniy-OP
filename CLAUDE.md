# Claude Instructions — AL-BERUNIY OS

This repository is documentation-first. Read the repository contract before proposing UI or code.

Preserve:
- multi-project isolation + corporate consolidation
- role/project/department/field permissions
- approval authority
- end-to-end traceability
- Finance as the posting engine
- segregation of duties
- immutable audit trails
- AI/Telegram permission boundaries

Treat the **AI Core / Enterprise Intelligence Control Plane** as a foundational platform capability, not a late chatbot feature. Read:
- `docs/03-architecture/AI_CORE.md`
- `docs/03-architecture/TELEGRAM_INTEGRATION.md`

All LLM connectivity must use the provider-neutral Model Gateway. Every major module must expose typed tools/events/read projections to the AI Core. The Enterprise Knowledge Plane can index cross-system knowledge, but retrieval/actions remain re-authorized for the current user.

Telegram must route through ABOS identity binding → permission context → AI Core → typed tools/domain services → workflow/audit.

Unknown requirements go to `docs/00-governance/OPEN_ITEMS.md` instead of being invented.


## Master execution prompt
Read and follow `prompts/CLAUDE_MASTER_PROMPT.md` plus `docs/04-delivery/AGENT_COORDINATION.md`.

On a fresh build, act first as coordinator/reviewer and allow Codex to claim WP-0001 unless Codex is unavailable. Do not duplicate claimed work.
