# ABOS V1 localhost review runbook

This runbook starts the current V1 on the owner's own computer with a persistent local PostgreSQL 17 database. It does **not** seed demo users, demo accounts, demo rates, balances, shareholders or transactions.

The owner supplies the initial company/legal-entity identity and first Super Administrator. After that, real review data is entered through the V1 application.

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js 24
- pnpm 11
- the repository checked out at the approved local-review branch/checkpoint

Install dependencies once:

```bash
pnpm install --frozen-lockfile
```

## First setup

Set `ABOS_SEED_CREDENTIALS_FILE` to a private file outside the repository, then run:

```bash
pnpm v1:local:setup
```

The first administrator's temporary password is written to that file and never to the console. Delete the file after the first sign-in.

The setup asks for:

- company code and company name
- legal-entity code and name
- first Super Administrator username and display name

Those are operator-supplied values. Nothing is invented by the setup script.

The command:

1. generates local-only secrets in `.env.local-review.local` when they do not already exist;
2. starts PostgreSQL 17 in Docker on `127.0.0.1:55432`;
3. applies the checked migration catalogue and records every migration in `abos.schema_migrations`;
4. creates three database logins, each inheriting only its restricted Treasury, Finance or Identity runtime role;
5. inserts only USD/AFN currency masters plus the company/legal-entity shell supplied by the owner;
6. creates one non-login bootstrap system actor;
7. bootstraps the first Super Administrator with a random temporary password, written only to `ABOS_SEED_CREDENTIALS_FILE`;
8. writes the restricted runtime configuration to the git-ignored `apps/web/.env.local`.

No shareholder, safe, Chart of Accounts entry, exchange rate, opening balance or transaction is seeded.

## Start V1

For development on a review checkout:

```bash
pnpm v1:local:start
```

`v1:local:start` is `next dev`. Never use it on preserved production: a cold `next dev` compiles routes on demand and has left API routes answering "not found" until a restart.

## Production runtime

Preserved production uses the standard Next.js lifecycle. A deployment builds once, from an empty `apps/web/.next`, and every start serves that build:

```bash
pnpm v1:local:build
```

```bash
pnpm v1:local:serve
```

- Set `NEXT_PUBLIC_APP_ENV=production` in the private `apps/web/.env.local` before building. `NEXT_PUBLIC_*` values are fixed at build time, so changing one needs a new build.
- A start never builds. It must refuse a missing build or a build of any commit other than the pinned one.
- `ABOS_ENVIRONMENT=development` is a separate database runtime gate and stays as it is.
- The session cookie is `Secure` under `next start`; browsers accept it on `http://127.0.0.1`.
- Prove every deployment on one start, with no warm-up and no second restart.

Open:

```text
http://127.0.0.1:3200/login
```

Sign in with the Super Administrator username and the one-time password from the private file named at setup. The first sign-in requires a password change.

From that point, create the actual employees, custom roles, accounts, safes, Saraf accounts, shareholders and other review data through the V1 screens.

## Status check

```bash
pnpm v1:local:status
```

The status command reports migration/company/entity/user counts and fails if demo/synthetic user rows are found.

## Empty reset

Reset is intentionally hard to invoke:

```bash
pnpm --filter @abos/e1-integration local:reset -- --confirm=RESET-LOCAL-V1
```

It drops only the `abos` schema in the designated `abos_v1_local_review` database and reapplies the migration catalogue. It does not seed any business data.

After a reset, run `pnpm v1:local:setup` again.

## Local files and secrets

The following files stay only on the owner's computer and are already covered by the repository's env-file ignore rules:

- `.env.local-review.local`
- `apps/web/.env.local`

Do not commit, send or screenshot their contents.

The web process receives only the restricted Treasury, Finance and Identity database credentials. The PostgreSQL operator credential is used by setup/reset tooling and is not written to `apps/web/.env.local`.

## Safety boundary

This is a **localhost review/UAT environment**, not an online deployment. The existing fail-closed sandbox authorization remains as an internal engineering safety gate, but the setup does not create synthetic business data.

Features that still require an explicit Finance Manager/owner policy decision remain blocked exactly as recorded in `docs/00-governance/OPEN_ITEMS.md`; the local runbook does not invent those policies.
