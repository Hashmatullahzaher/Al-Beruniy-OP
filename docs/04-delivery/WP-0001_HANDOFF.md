# WP-0001 — Operational Application Foundation Handoff

## Scope and baseline

- Work package: WP-0001 Repository / Application Skeleton
- Base: `origin/main` at `89c24fe`
- Branch: `agent/codex/WP-0001-app-skeleton`
- Acceptance: Stage 0 shell only; no identity, database, finance, posting, workflow or live AI behavior
- Existing `apps/holographic-presentation` remains independent and unchanged

## Implemented foundation

- pnpm 11 workspace on Node 24 LTS with Turborepo task orchestration
- strict TypeScript shared baseline
- Next.js/React operational web application at `apps/web`
- typed company/legal-entity/project context contract in `packages/contracts`
- shared semantic state and surface components in `packages/ui`
- routes for the approved Stage 0 navigation inventory
- accessible application shell, keyboard skip link, mobile navigation and LTR/RTL direction toggle
- explicit empty, loading, error and no-permission states
- health and readiness endpoints with exact Git SHA release metadata
- safe development/staging/production environment examples
- Playwright browser smoke coverage

## Antigravity ownership handoff

Antigravity should implement the screenshot-faithful Stage 0 UI in this same scaffold. Do not create another application.

Primary UI ownership:

- `apps/web/src/app/globals.css` — enterprise visual system and responsive styling
- `apps/web/src/components/AppShell.tsx` — sidebar, top bar, context presentation and global interactions
- `apps/web/src/components/ModuleFoundation.tsx` — shared module-state presentation
- `apps/web/src/app/page.tsx` — command-center visual composition
- `packages/ui/src/index.tsx` — shared visual components and their stable semantic markup

Stable interfaces to preserve or coordinate before changing:

- `packages/contracts/src/context.ts` — company/legal entity/project context types
- `packages/contracts/src/navigation.ts` — route IDs, paths, labels and grouping
- `apps/web/src/lib/env.ts` and `apps/web/src/lib/release.ts` — public environment and release metadata
- `apps/web/src/app/api/health/route.ts` and `apps/web/src/app/api/ready/route.ts` — operational probe contracts
- root workspace, TypeScript, lint and build configuration

The shell deliberately contains no real company, project, user, permission, finance or KPI data. Any visual-review fixtures must remain clearly marked `DEMO DATA` and isolated from operational records.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm lint
pnpm typecheck
pnpm build
pnpm test:smoke
pnpm test:e2e
```

## Verification evidence

Executed locally on 2026-09-20 with Node `v24.16.0` and pnpm `11.8.0`:

- `pnpm install --frozen-lockfile --offline` — PASS; lockfile already up to date
- `pnpm lint` — PASS; zero warnings/errors
- `pnpm typecheck` — PASS; 3/3 workspace packages
- `pnpm build` — PASS; 13 application pages generated, health/readiness routes available
- `pnpm test:smoke` — PASS; 2/2 Chromium smoke tests
- `pnpm test:e2e` — PASS; 5/5 Chromium tests, covering routes, explicit empty states, probes/SHA metadata, keyboard skip navigation, RTL switching and tablet navigation

## Implemented repository tree

```text
apps/web/
  src/app/                  Next.js routes, states and operational probes
  src/components/           shared application shell and module foundation
  src/lib/                  environment and release metadata
  tests/                    Playwright browser acceptance
packages/contracts/         navigation, release and company/project context contracts
packages/ui/                accessible shared shell-state primitives
package.json                workspace commands and pinned toolchain
pnpm-workspace.yaml         workspace boundary and approved dependency builds
pnpm-lock.yaml              reproducible dependency resolution
turbo.json                  task graph
tsconfig.base.json          strict TypeScript baseline
eslint.config.mjs           repository lint baseline
```

## Known gaps and approval status

- Screenshot-faithful enterprise styling is assigned to Antigravity on this scaffold.
- Independent review and client visual approval are pending.
- Stage 0 is not approved until the decision, date and exact approved SHA are recorded.
- WP-0002 through WP-0005, all identity/backend/domain/database work, and all financial behavior remain out of scope.

## Stage boundary

WP-0001 completion does not satisfy the full F0 gate. WP-0002 through WP-0005 remain separate packages. Client UI approval must be recorded before Stage 1 financial behavior is implemented.
