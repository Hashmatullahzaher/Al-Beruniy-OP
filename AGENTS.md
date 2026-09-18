# Agent Operating Contract

Before code: read README, acceptance contract, implementation plan, functional scope, work packages, traceability matrix, `docs/03-architecture/AI_CORE.md`, `docs/03-architecture/TELEGRAM_INTEGRATION.md`, relevant domain/architecture docs, relevant blueprint(s), and open items.

Do not invent official rates, taxes, penalties, thresholds, legal wording or accounting policies.

Keep Type A User, Type B Party, and Type C Ledger accounts distinct. Authorization is server-side and project-scoped. Posted financial data is immutable; corrections use reversals/adjustments.

AI Core is a foundational cross-cutting control plane. All LLM/model calls use the Model Gateway; every domain publishes typed AI tools/events/read projections; indexed knowledge remains security-tagged and query-time authorized. AI never bypasses RBAC/workflow/Finance and never uses arbitrary LLM-generated SQL.

Telegram is a channel into the same AI Core. It requires ABOS identity binding and cannot bypass permissions, SoD, workflow, step-up controls or audit.

Handoffs identify exact Git SHA.


## Autonomous execution
Read `docs/04-delivery/AGENT_COORDINATION.md`, `WORK_STATUS.md`, `RELEASE_READINESS.md` and `docs/03-architecture/TECHNOLOGY_BASELINE.md`.

Do not wait for per-module prompts. Claim only eligible unclaimed work, update status with evidence, obtain independent review for high-risk work, and continue until WP-1220 or a genuine external blocker.

On a fresh repository, Codex owns initial WP-0001 implementation by default; Claude coordinates/reviews, and Antigravity waits for the first eligible package suited to its role.
