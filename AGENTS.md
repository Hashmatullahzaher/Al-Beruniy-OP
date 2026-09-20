# Agent Operating Contract

Before code: read README, acceptance contract, implementation plan, functional scope, work packages, traceability matrix, `docs/03-architecture/AI_CORE.md`, `docs/03-architecture/TELEGRAM_INTEGRATION.md`, relevant domain/architecture docs, relevant blueprint(s), and open items.

Do not invent official rates, taxes, penalties, thresholds, legal wording or accounting policies.

Keep Type A User, Type B Party, and Type C Ledger accounts distinct. Authorization is server-side and project-scoped. Posted financial data is immutable; corrections use reversals/adjustments.

AI Core is a foundational cross-cutting control plane. All LLM/model calls use the Model Gateway; every domain publishes typed AI tools/events/read projections; indexed knowledge remains security-tagged and query-time authorized. AI never bypasses RBAC/workflow/Finance and never uses arbitrary LLM-generated SQL.

Telegram is a channel into the same AI Core. It requires ABOS identity binding and cannot bypass permissions, SoD, workflow, step-up controls or audit.

Handoffs identify exact Git SHA.


## Current staged execution gate — operational OS (2026-09-20)

The owner has explicitly changed the operational-app build from unattended end-to-end execution to **one client-reviewed slice at a time**. Read `docs/04-delivery/PHASE_00_UI_KICKOFF.md` and issue #1 before claiming new operational implementation work. The *current authorized scope* is WP-0001 application foundation and a screenshot-faithful enterprise UX/UI shell in `apps/web`, with visual client sign-off required before Stage 1 shareholder/cash/GL business logic. The existing `apps/holographic-presentation` remains separate.

**For the operational build, do not autonomously advance beyond the current approved gate.** Existing autonomous-run instructions below apply only when a subsequent owner/client decision explicitly authorizes that scope; the mandatory documentation, security, finance, and quality invariants remain in force. Codex and Antigravity coordinate on one shared operational app, not two separate frontends. In every later financial slice identify and approve counterpart Debit/Credit accounts, test reconciliation, and obtain client sign-off before the next slice.

## Autonomous execution
Read `docs/04-delivery/AGENT_COORDINATION.md`, `WORK_STATUS.md`, `RELEASE_READINESS.md` and `docs/03-architecture/TECHNOLOGY_BASELINE.md`.

Do not wait for per-module prompts. Claim only eligible unclaimed work, update status with evidence, obtain independent review for high-risk work, and continue until WP-1220 or a genuine external blocker.

On a fresh repository, Codex owns initial WP-0001 implementation by default; Claude coordinates/reviews, and Antigravity waits for the first eligible package suited to its role.
