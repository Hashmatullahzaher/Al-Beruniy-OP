# V1 Local Review Target

## Owner direction — 2026-09-28

The immediate target is a complete V1 review build that runs on the owner's own computer on localhost. This is **not** a cloud deployment and **not** a seeded demo environment.

## Required operating model

- Start from `v1/integration` checkpoint `d9212bb0f28b4c2e3c60f08d7f2b3ef5e5d6772a`.
- Run the V1 application locally on the owner's computer.
- Run PostgreSQL locally.
- The application database must start clean: no synthetic company, no synthetic users, no synthetic accounts, no synthetic rates, no synthetic opening balances, and no demo/test business records.
- Test fixtures may continue to exist inside automated tests only, where they are isolated and rolled back or destroyed after the test.
- The owner will manually enter the real company data through the application and use that real data to validate the workflows with the client.
- Cloud hosting, public-server deployment, AI and Telegram are not part of this immediate target.

## Completion scope

1. Finish every V1 implementation item that is technically actionable without inventing an unresolved owner, Finance Manager, accounting, security, or legal policy.
2. Keep any policy-dependent operation fail-closed exactly where the repository governance requires a decision; surface the reason clearly in the UI/API instead of inventing defaults.
3. Provide a repeatable localhost bootstrap path that:
   - installs/validates the required Node.js and pnpm versions;
   - starts a supported local PostgreSQL instance;
   - creates only the required database identities/roles;
   - applies the checked migration catalogue in order and records `schema_migrations` correctly;
   - starts the web application against the restricted runtime database identities;
   - performs readiness checks before declaring the app usable.
4. Provide a safe local reset path that destroys only the designated local V1 database and recreates it empty; it must never seed business data.
5. Ensure first-use administration is possible without shipping a permanent default password or a repository secret. Any one-time bootstrap credential must be operator-supplied or generated locally and forced to change where the identity design requires it.
6. Run the complete regression on the combined tree: lint, typecheck, unit, PostgreSQL integration, build, smoke, and full browser suite. No skipped gated browser journey is acceptable for this checkpoint.
7. Verify from a freshly created empty local database that the application can reach the initial configuration/administration state and that real company data can then be entered through supported V1 flows.
8. Update the V1 backlog and handoff documentation only from verified code/tests. Do not mark policy-blocked features complete unless the required stakeholder decision exists in versioned governance documentation.

## Acceptance result

The checkpoint is ready for owner/client review when a fresh clone can be brought to a clean localhost V1 using documented commands, all migrations and regression checks pass, no demo/test business data exists in the runtime database, and the owner can begin entering the company's real data.

This local-review target does not authorize public/online deployment.
