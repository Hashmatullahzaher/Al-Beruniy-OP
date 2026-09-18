# AI Agent Architecture

The agent runtime is one component of the broader AI Core defined in `AI_CORE.md`.

Required execution pattern:

`User / Telegram / System Trigger → AI Core → permission & policy gateway → intent/orchestrator → typed tool → domain service → authorization → validation → workflow/transaction/audit → grounded response`

Never:

`LLM → arbitrary SQL → database`

Key rules:
- AI cannot expand user permissions.
- Model/provider access is centralized in the Model Gateway.
- Enterprise knowledge ingestion is governed and security-tagged.
- Authoritative financial calculations come from deterministic services.
- Proposed actions pass normal workflow and SoD.
- Prompts, retrieved sources, tool calls, permission scope, model/provider/version and material outputs are audited.
- Low-confidence/high-risk cases route to humans.
- Telegram is an input/output channel to this same runtime, never a separate logic path.
