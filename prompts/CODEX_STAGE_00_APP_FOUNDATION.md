# CODEX — Stage 0 / WP-0001 Operational App Foundation

Work in `Hashmatullahzaher/Al-Beruniy-OP`. Read `docs/04-delivery/PHASE_00_UI_KICKOFF.md` and the governing documents it lists, verify latest `origin/main`, and claim WP-0001 in the work ledger on a dedicated branch. Stage 0 is UI shell **only**; do not auto-run the old WP-0001→WP-1220 build sequence or implement unapproved accounting logic.

Build the actual operational application scaffold, NOT `apps/holographic-presentation`:
- strict TypeScript, Node LTS, pnpm workspace, Next.js/React `apps/web`, shared component/theme package boundary if justified;
- clean reproducible install, dev, lint, typecheck, build, smoke/E2E scripts, documented environment, safe sample configuration and Git-SHA metadata;
- accessible desktop-first application shell foundation and routes for the screen inventory; project/company context contract typed but do not invent real records, role permissions or services;
- resilient empty/error/loading states, typography/RTL readiness, no secrets or fake live KPIs;
- coordinate exact UI files/interfaces with Antigravity: Antigravity will implement the screenshot-faithful styling/components in the *same* `apps/web` scaffold; no parallel Vite/Next app.

Scope WP-0001 to its defined finish condition; any optional additional F0 work must be recorded separately under work-package discipline. Do not claim functional identity, finance, database or posting completion from scaffolding. Preserve 3D app and docs. Run actual checks locally and provide evidence. Commit feature branch and hand off branch/SHA to Antigravity for UI work, with clearly named ownership/paths; seek independent review and do not merge until agreed UI gate.

Deliver: exact SHA; run commands and outputs; repo tree; implementation ownership handoff; known gaps; explicit WP-0001 status and Stage 0 approval status. No claim that agent execution has begun until this prompt is actually run in an authorized Codex coding environment.
