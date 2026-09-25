# V1 Phase 1 — work packages and shared contracts

Lead-owned. Every Phase 1 agent reads this first. Base: `v1/integration` after the contract
checkpoint (migration 0013). Scope source of truth: `docs/00-governance/DECISIONS.md` (owner decisions
2026-09-25) and `docs/04-delivery/V1_DELIVERY_BACKLOG.md`. Nothing here extends V1 scope.

## Two-phase allocation (by dependency and effort)

**Phase 1: accounting foundation and connected financial operations**

| WP | Backlog | Owner |
|---|---|---|
| A | #10 Chart of Accounts: user-created accounts, duplicate warnings, Finance Manager review list, lifecycle, audit, protection of referenced accounts | Agent A |
| B | #11 safes and Saraf accounts: create and manage safes, open/count/reconcile/approve/activate currency accounts in the app, Saraf accounts linked to the CoA. Then #16 whole-safe cash count | Agent B |
| C | #12 AFN custody on the USD foundation (per-currency separation) and #13 daily market/Saraf exchange rates with immutable per-transaction snapshots. Then #15 shareholder capital-request creation in the app | Agent C |
| L | #8 company configuration view; integration, reviews, backlog; the full regression | Lead |
| R | Independent security and accounting review of each package before integration | Agent R |

**Phase 2: remaining modules, hardening and acceptance**
- #14 capital **or** loan per transaction (posting-engine change)
- #17 controlled reversals (request → Finance Manager approval)
- #18 Excel opening-balance import (blocked on the owner's layout)
- #19 General Ledger views and financial reports in both calendars
- #20 Finance trace names and exact decimals
- AFN posting to the USD ledger (blocked on the FX policy decisions)
- #6 production identity hardening
- #7 online deployment (needs owner approval)
- Final acceptance

## Hard rules for every agent

1. Work only in your own worktree and branch. Commit there. Do not push, force-push, merge, or touch `main`, `v1/integration` or another agent's branch. The lead integrates.
2. Do not edit migrations 0001–0013. Use only your assigned new migration:
   - A: `0014_v1_chart_of_accounts.sql`
   - B: `0015_v1_safes_saraf.sql`
   - C: `0016_v1_currency_rates.sql`

   Register it in `packages/database/src/migrations.ts` (append one entry; the lead resolves merge order). Your migration must apply cleanly on 0001–0013. Where you depend on another package's schema, state it in your report; do not copy their migration.
3. Privileged database code follows the 0011 model (`docs/04-delivery/V1_SECURITY_DEFINER_OWNERSHIP.md`):
   - new entry points are `SECURITY DEFINER`, owned by `abos_e1_finance_owner` (Finance/CoA/rates) or `abos_e1_treasury_owner` (Treasury/Saraf), with `SET search_path = pg_catalog, pg_temp`;
   - `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE` only to the matching runtime role (`abos_e1_runtime` or `abos_e1_treasury_runtime`);
   - column-level UPDATE and INSERT grants only; no DELETE, TRUNCATE, TRIGGER or REFERENCES;
   - lock-only tables get the primary-key column plus the `abos_<table>_owner_lock_only` trigger pattern;
   - actor and legal entity come only from the token, via `abos.finance_runtime_authorize(token, permission)` or `abos.treasury_runtime_authorize(token, entity, permission)`;
   - runtime roles never receive table privileges;
   - trigger functions pin `search_path`.
4. Permissions: insert your permission rows into `abos.permission_catalogue` in your migration (`catalogue_version = 3`). Category FINANCE or TREASURY: the authorizers accept any ACTIVE catalogue permission of their category (0013). Use only your `sort_order` range: A 200–219, B 220–239, C 240–259. Add plain-language English and Dari copy in `apps/web/src/lib/access-copy.ts`. Mark `independence_enforced = true` where the database enforces an independence rule.
5. Segregation of duties is by participation and is enforced in the database. Examples: the reviewer of an account is not its creator; a safe's approver is not its counter. No role combination may bypass it.
6. Money: exact `numeric`, never float; amounts cross the API as decimal strings. Currencies are never combined into one balance. Do not invent exchange rates, rounding or precision rules, account codes, opening balances or statutory policy. Where a decision is missing, stop that feature, record the exact decision needed, and continue with other work.
7. Synthetic only. Placeholder account classes, safe names and Saraf names must be visibly labelled synthetic or demonstration. Real posting stays disabled; the sandbox gate is untouched.
8. Update the ownership suite's expected function→owner map (`security-ownership.test.ts`) for your new definer functions.
9. The UI follows the existing navy/gold components (`treasury-*`, `module-*`, `admin-*` classes), English and Dari, RTL and phone width. Put new CSS in one appended block headed with your WP letter. Do not redesign existing screens or the organisational presentation.
10. Shared files you may append to, in a clearly marked block: `migrations.ts`, `access-copy.ts`, `AppShell.tsx` (one nav entry in `previewRoutes`), `globals.css`, `security-ownership.test.ts`, the root `package.json` scripts. Everything else outside your ownership list is read-only.

## File ownership

| WP | Owns (create or modify) |
|---|---|
| A | `0014_*`; `packages/e1-integration/src/chart-of-accounts*.test.ts`; `apps/web/src/server/chart-of-accounts.ts`; `apps/web/src/app/api/v1/finance/accounts/**`; `apps/web/src/app/finance/accounts/**`; `apps/web/src/components/ChartOfAccounts*.tsx`; `apps/web/tests/v1-chart-of-accounts.spec.ts` |
| B | `0015_*`; `packages/e1-integration/src/safes-saraf*.test.ts`; `apps/web/src/server/treasury-safes.ts`; `apps/web/src/app/api/v1/treasury/cash-locations/**`, `.../treasury/saraf-accounts/**`, `.../treasury/safe-counts/**`; `apps/web/src/components/TreasuryWorkspace.tsx` (Safes tab only), `TreasurySafes*.tsx`, `Saraf*.tsx`; `apps/web/tests/v1-safes-saraf.spec.ts`. Also the Treasury domain/persistence files needed for safe commands (`packages/treasury/**`, `packages/persistence/src/restricted-treasury-*.ts`) |
| C | `0016_*`; `packages/e1-integration/src/currency*.test.ts`, `shareholder-request*.test.ts`; `apps/web/src/server/exchange-rates.ts`, `shareholder-requests.ts`; `apps/web/src/app/api/v1/finance/exchange-rates/**`, `.../shareholder/**`; `apps/web/src/app/finance/exchange-rates/**`, `apps/web/src/app/shareholders/**`; `apps/web/src/components/ExchangeRates*.tsx`, `ShareholderRequest*.tsx`; `apps/web/tests/v1-currency.spec.ts` |

## Cross-package contracts

- **Accounts (A ↔ B, C):** `abos.ledger_accounts` stays the one account table. A adds columns and tables around it but does not rename or drop columns.
  - A safe currency account references an existing ledger account with `control_account_type = 'CASH'` in the same currency (the existing composite FK enforces this).
  - A Saraf account references a ledger account with `control_account_type = 'SARAF'` (added in 0013).
  - B never creates ledger accounts in application paths; the user picks them from the CoA. In tests, B may create synthetic ledger accounts with the owner connection.
  - A must refuse destructive changes to an account referenced by a safe, a Saraf account or any journal.
- **Currencies:** `abos.currencies` holds USD and AFN (both enabled). The base currency is USD (decided). C owns rates and snapshots.
  - An AFN amount is never added to a USD amount.
  - Conversion arithmetic and rounding for posting are undecided policy: store rates exactly as entered, snapshot them, and do not convert for posting.
- **Periods:** only PENDING periods are generated (0012); nothing opens periods. Posting still requires an OPEN period.

## Test isolation (run in parallel without interference)

| Agent | Worktree | PostgreSQL test DB (`ABOS_TEST_DATABASE_URL`) | Dev DB (`.env.local`) | `ABOS_E2E_PORT` |
|---|---|---|---|---|
| A | `C:/Users/STC/Desktop/Al-Beruniy-OP-coa` | `abos_e1_sandbox_coa` | `abos_e1_dev_coa` | 3191 |
| B | `C:/Users/STC/Desktop/Al-Beruniy-OP-safes` | `abos_e1_sandbox_safes` | `abos_e1_dev_safes` | 3192 |
| C | `C:/Users/STC/Desktop/Al-Beruniy-OP-currency` | `abos_e1_sandbox_currency` | `abos_e1_dev_currency` | 3193 |
| R | read-only | `abos_e1_sandbox_review` | — | — |

- PostgreSQL: `postgres://abos:abos_sandbox@127.0.0.1:55432/<db>` (disposable, synthetic).
- Each worktree has its own git-ignored `apps/web/.env.local` pointing at its own dev DB. Never use `abos_e1_sandbox` or `abos_e1_dev`: they belong to the lead and the owner's preview.
- Browser tests: `ABOS_E2E_PORT=<port> ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test <your spec> --workers=1`, run from `apps/web`.

## Definition of done for a package

A package is done when:
- database, backend, UI and authorization are complete, with positive, negative and regression tests;
- `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, the package's PostgreSQL tests (and the full `pnpm test:integration` on your DB) and your browser spec pass;
- everything is committed on your branch;
- you have reported the branch, commit, test counts, decisions needed and any dependency on another package.

After that, Agent R reviews it, the lead applies or requests fixes, and the lead integrates in dependency order (0014 → 0015 → 0016).
