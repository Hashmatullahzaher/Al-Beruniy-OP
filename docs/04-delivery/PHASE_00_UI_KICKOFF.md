# ABOS Stage 0 — Enterprise UI Foundation / Client Approval Gate

**Date:** 2026-09-20
**Status:** ALL STAGE 0 UX/UI ROUTES VISUALLY APPROVED — operational implementation and Stage 1 remain unauthorized.
**Baseline:** main `b972155cc56da7e81bc5b8c121bfe1fd059501d1`.
**Applies to:** new operational web application; NOT `apps/holographic-presentation/`.

## Decision / scope boundary

The owner has selected a staged, client-reviewed implementation: first reproduce and approve the enterprise UX/UI reference, then implement the smallest complete financial transaction slice (shareholders + actual treasury receipt + balanced journal + reports), then add downstream domains only after each bilateral accounting effect is identified, tested, and approved. This staged delivery gate supersedes any instruction to implement all 205 work packages without interim client approval. The existing blueprint package and architectural/security invariants remain authoritative; unresolved new shareholder and accounting policies must be documented and approved before posting logic is built.

**Reference screenshot:** image shared in the project conversation on 2026-09-20, titled `Al-Beruniy Enterprise Command Center`, with dark navy left navigation, wide real-estate hero, compact financial KPI tiles, charts, project-progress panels, AI insight area, and AL-BERUNIY blue/gold aesthetic. The screenshot is a VISUAL reference, not a factual data source. The owner must attach it to the implementing agent's task; do not claim the reference image is stored in Git unless separately added. Existing architectural photograph under `apps/holographic-presentation/public/assets/` may be considered after confirming it is the approved project image and rights/branding are correct.

## Stage 0 outcome: genuine runnable web shell

Codex owns prerequisite WP-0001 application skeleton and necessary F0 scaffolding; Antigravity owns UI implementation on that shared shell. Do not independently create competing applications. Use approved technology baseline (TypeScript strict, Next.js/React in `apps/web`, shared design components), reproducible local commands, lint/typecheck/build and browser tests.

Visual scope:
- Professional faithful reconstruction of approved screenshot: dark left sidebar, top bar, branding, project-hero area, responsive KPI grid, financial/sales/project-progress/report regions, notifications, role-safe AI entry and corporate navy/cyan/gold visual tokens.
- Navigation routes for Overview, Projects, Sales & CRM, Finance, Construction, Procurement, Human Resources, Reports & Analytics, AI Insights, Documents, Settings. Unbuilt modules show explicit scope/empty states, not fictional working workflows or dead UI.
- Coherent application layout and component system: cards, badges, buttons, inputs, accessible tables, validation/empty/loading/error/no-permission states; desktop-first and sensible tablet behavior; keyboard accessibility and usable RTL/Dari text support.
- Company/legal entity and project context UI shell (data/auth wired when corresponding backend is approved); clear differentiation between visually complete shell and operational functionality.
- Hero photograph/background image has approved rights, branding, stable dimensions, responsive crop; do not place the UX reference screenshot itself as the finished UI.
- No fake KPI values, fake customer data, fake cash numbers, fake alerts or manufactured AI forecasts presented as real. Empty state is preferred; clearly opt-in synthetic fixture only for visual review with persistent `DEMO DATA` indication, isolated from live financial records.
- Preserve the separate holographic 3D presentation app. No migration of its Vite code into the operational Next.js app without approved integration design.

## Stage 0 acceptance gate — ALL required

1. Clean checkout of work branch installs, starts, lint/typechecks/builds and passes the documented browser smoke test.
2. The browser shows a layout faithful to the provided screenshot at 1920×1080; responsive screen and keyboard navigation reviewed.
3. Sidebar/top-nav and clickable interactive controls respond with real route/state changes or explicit not-yet-implemented states; no inert decorative buttons masquerading as functionality.
4. Operational numbers have verified source or clearly marked synthetic DEMO data. None of the screenshot's example names/dates/metrics are silently hard-coded as business records.
5. Screenshot comparison and video/walkthrough available for owner; fix UI deviations before asking for sign-off.
6. Existing blueprints and 3D demo build remain unaffected.
7. Work committed on a dedicated feature branch; independent code/browser review recorded.
8. **Owner + client explicitly approve UI gate** in repository with decision/date/exact SHA before Stage 1 finance business logic proceeds. UI-only skeleton does not constitute finance implementation or production readiness.

## Command Center visual approval record

- **Decision date:** 2026-09-20
- **Decision:** The product owner reviewed the rebuilt AL-BERUNIY Command Center locally and confirmed that its UX/UI matches the supplied reference. The Command Center design, layout, proportions, colors, typography, and approved Mazar Mall image are visually approved and must be preserved.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `5d94876a93a8f14a8dfa61c8eafe6d330dc21418`
- **Validation:** lint passed; strict TypeScript passed; production build passed; smoke tests passed (2/2); browser tests passed (7/7), including 1920×1080 desktop layout, tablet navigation, keyboard skip navigation, accessible control names, responsive overflow, notification/search states, and English/Dari RTL switching.
- **Scope of approval:** the main Command Center only. Remaining routes may adopt this design system only after the owner approves the follow-on implementation plan.
- **Gate:** do not merge into `main` and do not begin Stage 1 until explicitly authorized.

## Projects and Sales & CRM visual approval record

- **Decision date:** 2026-09-20
- **Decision:** The product owner reviewed the Projects and Sales & CRM pages locally and visually approved both pages. Their approved layouts, proportions, colors, typography, interaction patterns, and use of the Command Center design system must be preserved together with the already approved Command Center and original Mazar Mall image.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `9f60ad8e198dd3df3d8356992671199c49a2c6c6`
- **Validation:** lint passed; strict TypeScript passed (3/3 packages); production build passed; smoke tests passed (2/2); full Chromium browser suite passed (10/10), including desktop layout, tablet navigation, keyboard access, responsive overflow, Projects filtering/search/selection, Sales & CRM tab/search/selection behavior, and English/Dari RTL coverage.
- **Scope of approval:** the Command Center, Projects, and Sales & CRM interfaces only. Synthetic records remain persistently labeled as demonstration data, and protected customer, contract, collection, receipt, posting, and balance operations remain unavailable in Stage 0.
- **Gate:** remaining Stage 0 routes are not visually approved by this record. Do not merge into `main`, mark the entire Stage 0 approved, or begin Stage 1 business logic until explicitly authorized.

## Finance and Construction visual approval record

- **Decision date:** 2026-09-21
- **Decision:** The product owner reviewed the Finance and Construction pages locally and visually approved both interfaces. Their approved layouts, proportions, colors, typography, interaction patterns, and Stage 0 boundary language must be preserved with the previously approved Command Center, Projects, Sales & CRM, and original Mazar Mall image.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `461d9911acd0345001c6c6e488293e0e54145400`
- **Validation:** lint passed; strict TypeScript passed (3/3 packages); production build passed; smoke tests passed (2/2); full Chromium browser suite passed on the clean rerun (13/13), including the five approved interfaces, desktop and tablet layouts, keyboard access, responsive overflow, Finance safeguards, Construction preview interactions, and English/Dari RTL coverage.
- **Scope of approval:** the Command Center, Projects, Sales & CRM, Finance, and Construction interfaces only. Finance remains an interface preview without real balances, capital receipts, vouchers, journals, posting, treasury actions, or accounting effects. Construction fixtures remain synthetic and have no certified quantities, costs, approvals, or financial posting.
- **Gate:** remaining Stage 0 routes are not visually approved by this record. Do not merge into `main`, mark the entire Stage 0 approved, or begin Stage 1 business logic until explicitly authorized.

## Procurement and Human Resources visual approval record

- **Decision date:** 2026-09-21
- **Decision:** The product owner reviewed the Procurement and Human Resources pages locally and visually approved both interfaces. Their approved layouts, proportions, colors, typography, interaction patterns, synthetic-data labeling, and Stage 0 safeguards must be preserved with all previously approved interfaces and the original Mazar Mall image.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `18a2db2726fdc8a76fad631684e85623496e18b1`
- **Validation:** lint passed; strict TypeScript passed (3/3 packages); production build passed; smoke tests passed (2/2); the full Chromium browser suite passed serially (16/16), including all approved interfaces, desktop and tablet layouts, keyboard access, responsive overflow, Procurement safeguards, Human Resources privacy/payroll safeguards, and English/Dari RTL coverage.
- **Scope of approval:** the Command Center, Projects, Sales & CRM, Finance, Construction, Procurement, and Human Resources interfaces only. Procurement cannot create purchases, supplier liabilities, inventory valuation, payments, accounting entries, or inter-project transfers. Human Resources contains no real identities, payroll, salary calculations, employee financial records, or accounting entries.
- **Gate:** remaining Stage 0 routes are not visually approved by this record. Do not merge into `main`, mark the entire Stage 0 approved, or begin Stage 1 business logic until explicitly authorized.

## Reports & Analytics and AI Insights visual approval record

- **Decision date:** 2026-09-21
- **Decision:** The product owner reviewed the Reports & Analytics and AI Insights pages locally and visually approved both interfaces. Their approved layouts, proportions, colors, typography, interaction patterns, synthetic-data labeling, source-context presentation, and Stage 0 safeguards must be preserved with all previously approved interfaces and the original Mazar Mall image.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `9ddfc526b0500ecfaa06486b9ed3995b3f38ec82`
- **Validation:** lint passed; strict TypeScript passed (3/3 packages); production build passed; smoke tests passed (2/2); the full Chromium browser suite passed serially (19/19), including all approved interfaces, desktop and tablet layouts, keyboard access, responsive overflow, report-preview safeguards, illustrative AI/source-context behavior, and English/Dari RTL coverage.
- **Scope of approval:** the Command Center, Projects, Sales & CRM, Finance, Construction, Procurement, Human Resources, Reports & Analytics, and AI Insights interfaces only. Reports cannot export, certify, reconcile, post, or represent synthetic figures as official statements. AI Insights has no live model, verified findings, permission bypass, executable actions, or operational workflow integration.
- **Gate:** Documents and Settings remain unapproved. Do not merge into `main`, mark the entire Stage 0 approved, or begin Stage 1 business logic until explicitly authorized.

## Documents and Settings visual approval record

- **Decision date:** 2026-09-21
- **Decision:** The product owner reviewed the Documents and Settings pages locally and visually approved both interfaces. This completes the visual review of the Stage 0 UX/UI. Their approved layouts, proportions, colors, typography, interaction patterns, local-preference behavior, synthetic-data labeling, and Stage 0 safeguards must be preserved with all previously approved interfaces and the original Mazar Mall image.
- **Approved branch:** `agent/codex/WP-0001-command-center-rebuild`
- **Approved implementation SHA:** `7aa56d7af86998e17247dc1d3de5e38c072888be`
- **Validation:** lint passed; strict TypeScript passed (3/3 packages); production build passed; smoke tests passed (2/2); the full Chromium browser suite passed serially (22/22), including every Stage 0 route, desktop and tablet layouts, keyboard access, responsive overflow, Documents discovery/preview safeguards, Settings local-only preferences, and English/Dari RTL coverage.
- **Scope of approval:** all Stage 0 UX/UI routes: Command Center, Projects, Sales & CRM, Finance, Construction, Procurement, Human Resources, Reports & Analytics, AI Insights, Documents, and Settings. This approval covers interface design and non-operational preview behavior only. It does not approve production data, authentication, permissions, storage, workflows, accounting, financial posting, integrations, or Stage 1 implementation.
- **Gate:** do not merge into `main` or begin Stage 1 automatically. Multi-currency architecture and the first operational finance slice require separate owner/client approval before database or posting implementation.

## Stage 1 next gate (NOT authorized for posting implementation by this Stage 0 decision)

Before building shareholder investment/cash intake, update BP-04, finance domain model, chart of accounts and acceptance tests to distinguish share capital vs shareholder loan vs unreceived capital commitments and pre-existing opening balances; define company/legal entity/project attribution, share classes/ownership evidence, cash/bank/sarafi accounts, currencies/FX, receipts, approval, reversal, reconciliation and trial balance. First test: approved genuine cash contribution `Dr Cash/Bank ; Cr Paid-in Share Capital` *only when the contribution is legally/economically equity and actually received*. A shareholder loan posts to shareholder payable instead. Every future business module must enumerate the counterpart Debit/Credit accounts and non-posting exceptions BEFORE build, obtain client policy approval, and preserve `ΣDr = ΣCr`, immutable journal and source→ledger→report trace.

## Out-of-scope / no invention

Do not invent inter-project material transfers from the client's Excel photos; the user explicitly denied that interpretation. Material-in-exchange-for-property is a distinct, later client-verified flow. Do not silently infer legal share capital terms, opening balances, IFRS elections, taxes, approval limits or real-world transaction amounts from empty Excel templates.

## Handoff

Codex: `prompts/CODEX_STAGE_00_APP_FOUNDATION.md`.
Antigravity: `prompts/ANTIGRAVITY_STAGE_00_ENTERPRISE_UI.md`.
Both read `README.md`, `AGENTS.md`, BP-01/02/03/04/18/19/20/23, `docs/01-product/SCREEN_INVENTORY.md`, `docs/04-delivery/FUNCTIONAL_SCOPE.md`, `docs/03-architecture/TECHNOLOGY_BASELINE.md`, `docs/04-delivery/BUILD_WORK_PACKAGES.md`, and `docs/00-governance/OPEN_ITEMS.md`. Check current main/WORK_STATUS and coordinate exclusive ownership before edits.
