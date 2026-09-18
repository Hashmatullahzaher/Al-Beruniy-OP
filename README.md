# AL-BERUNIY Operating System

Documentation-first source of truth for the AL-BERUNIY Operating System: a multi-project real-estate development, construction, finance, sales, procurement, warehouse, HR/payroll, document, analytics and AI platform.

## Current phase
Documentation and blueprint definition. No production implementation should redefine the approved operating model.

## Source-of-truth order
1. `docs/04-delivery/ACCEPTANCE_CONTRACT.md`
2. `docs/02-domain/BUSINESS_RULES.md`
3. `docs/01-product/PRODUCT_REQUIREMENTS.md`
4. `docs/06-blueprints/` visual blueprint package
5. `docs/03-architecture/SYSTEM_ARCHITECTURE.md`
6. `docs/04-delivery/IMPLEMENTATION_PLAN.md`

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

