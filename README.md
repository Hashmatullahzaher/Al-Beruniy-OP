# AL-BERUNIY Operating System

Documentation-first source of truth for the AL-BERUNIY Operating System: a multi-project real-estate development, construction, finance, sales, procurement, warehouse, HR/payroll, document, analytics and AI platform.

## Current phase
**Build-ready / multi-agent execution.** Documentation, blueprints, implementation sequencing, technology baseline, AI Core/Telegram architecture, work-package ledger and agent master prompts are present. Production implementation starts at WP-0001 and proceeds through WP-1220.

## Source-of-truth order
1. `docs/04-delivery/ACCEPTANCE_CONTRACT.md`
2. `docs/02-domain/BUSINESS_RULES.md`
3. `docs/01-product/PRODUCT_REQUIREMENTS.md`
4. `docs/06-blueprints/` visual blueprint package
5. `docs/03-architecture/SYSTEM_ARCHITECTURE.md`
6. `docs/04-delivery/IMPLEMENTATION_PLAN.md`
7. `docs/03-architecture/TECHNOLOGY_BASELINE.md`
8. `docs/04-delivery/AGENT_COORDINATION.md`

Conflicts are recorded in `docs/00-governance/OPEN_ITEMS.md` and resolved explicitly before dependent build work.

## Repository map
- `docs/00-governance/` charter, decisions, glossary, open items
- `docs/01-product/` requirements, roles, journeys, screen inventory
- `docs/02-domain/` business rules and module contracts
- `docs/03-architecture/` architecture, security, data, AI, integration, traceability
- `docs/04-delivery/` acceptance, blueprint gate, roadmap, tests
- `docs/05-operations/` deployment/UAT/security readiness
- `docs/06-blueprints/` A3 visual blueprints 00–26 plus Master Network Workflow
- `prompts/` builder/auditor prompts
- `skills/` documentation-first build method

## Governing workflow
**Discover → Document → Blueprint → Review → Acceptance Contract → Build → Self-Audit → Independent Audit → Remediate → UAT → Release**

## AI Core & Telegram

The AI layer is a first-class **AI Core / Enterprise Intelligence Control Plane**, not a late chatbot feature. It spans every domain, maintains a governed enterprise knowledge plane, connects to one or more LLM providers through a provider-neutral Model Gateway, uses typed tools/domain services, and is permission-trimmed at retrieval and action time.

Telegram is a first-class conversational channel into the same AI Core:

**Telegram → Identity Binding → Permission Context → AI Core → Typed Tool → Domain Service → Workflow/Finance/Audit**

Architecture:
- `docs/03-architecture/AI_CORE.md`
- `docs/03-architecture/TELEGRAM_INTEGRATION.md`

LLM providers may connect through approved API keys, service credentials, OAuth/provider sign-in, or private model endpoints. Provider credentials are managed secrets and never live in source code.



## Zero-to-100 Agent Build

The repository is prepared for one-time master prompting of three connected coding agents:

- Claude: `prompts/CLAUDE_MASTER_PROMPT.md`
- Codex: `prompts/CODEX_MASTER_PROMPT.md`
- Antigravity: `prompts/ANTIGRAVITY_MASTER_PROMPT.md`

Shared execution state:
- `docs/04-delivery/WORK_STATUS.md`
- `docs/04-delivery/AGENT_COORDINATION.md`
- `docs/04-delivery/RELEASE_READINESS.md`
- `docs/04-delivery/FINAL_COMPLETION_REPORT.md`

### Initial boot sequence
1. Claude reads the repository and acts as coordinator/reviewer; on a fresh repo it should not race Codex for WP-0001.
2. Codex claims and implements WP-0001.
3. Antigravity reads the status ledger and waits for/claims the first eligible UI/full-stack/integration package.
4. All three continue from repository state without needing module-by-module human prompts.

Release 1 is complete only at WP-1220 after F0–F12 and J1–J6 gates pass.
