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

Run:

```bash
pnpm v1:local:setup
```

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
7. bootstraps the first Super Administrator with a random temporary password shown once;
8. writes the restricted runtime configuration to the git-ignored `apps/web/.env.local`.

No shareholder, safe, Chart of Accounts entry, exchange rate, opening balance or transaction is seeded.

## Start V1

```bash
pnpm v1:local:start
```

Open:

```text
http://127.0.0.1:3200/login
```

Sign in with the Super Administrator username and the one-time password printed by setup. The first sign-in requires a password change.

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
