# Retire the synthetic lane — migration 0041 and the matching application change (Slice 1 D3)

Status: IMPLEMENTED on branch `claude/d3-retire-e1` (worktree `_worktrees/al-beruniy-d3`), based on
trunk `v1/main` at `0aa651250b2fdec98811195ec103c43f2d5020a1` (the SHA production runs today).
**Not merged, not deployed.** Production deployment of 0041 remains NOT AUTHORIZED until the owner
has reviewed this report. The preserved production database stays at 0040.

Governing instruction: the owner's D3 authorization of 2026-10-27 ("proceed with D3 source
implementation and review only for migration 0041 and the matching application retirement of the E1
product path"), on top of the approved Slice 1 of the Revised Final Architecture Plan.

## 1. What the owner asked for, and where each condition is met

| Owner condition | How it is met | Where to check |
|---|---|---|
| Do not deploy 0041 to the preserved production database | Nothing touched localhost:3200 or port 55432. Every database run used disposable databases in the 15440 test container. | §7 |
| Work from the current trunk | Branch created at `0aa6512`; no other base. | `git log` |
| Preserve all business data | 0041 creates one new table, one view, one trigger and one role, and runs `REVOKE`/`GRANT`. It writes no row of any existing table. The historical-upgrade test proves every pre-existing table byte-for-byte identical after 0039+0040+0041. | §2, `admin-approval-upgrade.test.ts` |
| Revoke runtime EXECUTE only on the explicitly reviewed frozen E1 entry points | Fourteen signatures, spelled out one by one (§3). Nothing else loses a privilege. | `0041_v1_retire_synthetic_lane.sql` §2 |
| Mark only the reviewed synthetic permissions as `RETIRED` | Twelve codes (§4), recorded in `abos.permission_retirements`; the application reports them as `RETIRED`. No other code changes state. | §4 |
| Do not delete E1 tables or functions | No `DROP`. All 108 SECURITY DEFINER functions still exist with the same owners (inventory test unchanged at 108). | `security-ownership.test.ts` |
| Keep password operational sessions intact | `sandbox_sessions`, `operational_bearer_context`, `identity_*` and every operational lane are untouched; the full operational integration suite passes. | §7 |
| Do not rename `packages/sandbox-auth` | Not renamed. `financeHandoffRuntime()` keeps its name too (it now only provides the executor and the token). | — |
| `/shareholders/legacy` must have no control that depends on a retired API | The embedded capital-request panel and its tab are gone; what remains (shareholders, agreements, installments, the 0036 bridge panels) calls operational APIs only. | §5, `v1-retire-synthetic-lane.spec.ts` |
| Remove Treasury / Finance-inbox sandbox screens and token forms | Pages, components, routes, server modules and the token sign-in prompt deleted. | §5 |
| Rebuild the employee dashboard as the minimal operational dashboard | `/dashboard` is now name, roles, the pages the person's permissions open, and the access list. It calls no Finance or Treasury endpoint. | §5 |
| Keep database-level regression coverage for the frozen E1 functions | A holder role `abos_e1_frozen_lane` carries EXECUTE; disposable test logins join it, so every existing E1 flow test still runs. Plain runtime logins are proven locked out. | §3, §6 |
| Full validation on disposable databases only | §7 lists each suite, the database it used and the result. | §7 |
| Formal report, then stop | This document. No merge, no push, no deployment. | — |

## 2. Migration 0041 — what it does and does not do

File: `infrastructure/database/migrations/0041_v1_retire_synthetic_lane.sql`, registered in
`packages/database/src/migrations.ts` with checksum
`e49aa6bd788f7253c29b0a1c6abd3ac10744895ee343d5732a042f6f171dbaa6`.

| Change | Detail | Existing rows touched |
|---|---|---|
| Role `abos_e1_frozen_lane` | NOLOGIN, NOINHERIT, no members. `COMMENT` states it is never granted to a production login. | none |
| `REVOKE EXECUTE … FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime` | On the fourteen entry points of §3, each by full signature. | none |
| `GRANT EXECUTE … TO abos_e1_frozen_lane` | The same fourteen. | none |
| Table `abos.permission_retirements` | `permission_code` (FK to the catalogue), `retired_in_migration`, `retired_at`, `reason`; lock-only trigger (`prevent_audit_mutation`, the catalogue's own); 12 rows inserted (§4). `SELECT` to the identity owner and the identity runtime only. | none |
| Trigger `access_role_permissions_refuse_retired` | `BEFORE INSERT`: a retired code cannot be added to a role, whoever writes the row. Rows that already exist are left alone. | none |
| View `abos.frozen_lanes` | The fourteen entry points with `function_exists` and the live EXECUTE state of each runtime and of the holder. `SELECT` to the runtimes and the holder. | none |

Not done, deliberately: no table or function dropped or rewritten; the catalogue rows are not
updated (see §4 for why); `sandbox_sessions` is not renamed; `treasury_secure_context`'s
developer-token fallback is not edited (its body is frozen with the rest; no runtime can reach it).

## 3. The frozen entry points (14)

| Lane | Entry point | Defined in | Runtime that held EXECUTE |
|---|---|---|---|
| Treasury synthetic | `treasury_secure_context(text)` | 0008, 0032 | treasury |
| Treasury synthetic | `treasury_secure_query(text,uuid,text,uuid)` | 0008, 0009, 0032 | treasury |
| Treasury synthetic | `treasury_secure_command(text,uuid,text,jsonb)` | 0008, 0009, 0032 | treasury |
| Treasury synthetic | `treasury_synthetic_signin_context(text)` | 0032 | treasury |
| Treasury synthetic | `treasury_revoke_own_session(text)` | 0008 | treasury |
| Treasury synthetic | `treasury_safes_saraf_query(text,uuid,text,uuid)` | 0015, 0032 | treasury |
| Treasury synthetic | `treasury_safes_saraf_command(text,uuid,text,jsonb)` | 0015 | treasury |
| Finance handoff | `finance_handoff_workspace(text)` | 0009, 0032 | finance |
| Finance handoff | `finance_handoff_trace(text,uuid)` | 0009, 0019, 0032 | finance |
| Finance handoff | `finance_prepare_capital_posting(text,uuid,uuid,text)` | 0009 | finance |
| Finance handoff | `finance_approve_capital_posting(text,uuid)` | 0009 | finance |
| Finance handoff | `post_synthetic_capital_receipt(text,uuid,uuid)` | 0007 | finance |
| Shareholder request | `shareholder_capital_workspace(text)` | 0016, 0031, 0033 | finance |
| Shareholder request | `shareholder_create_capital_request(text,uuid,uuid,text,date,uuid,text)` | 0016, 0031, 0033 | finance |

Review notes that decided the list:

- `treasury_secure_context` was checked for operational use before freezing: the only application
  caller was `currentTreasury()` in `apps/web/src/server/treasury.ts`, used solely by the E1 routes
  (removed). Password sessions resolve through `operational_bearer_context` and the identity
  service; no operational route or database function calls `treasury_secure_context`.
- The 0036/0038 bridge functions (`record/verify/prepare/decide/post_shareholder_capital_receipt`,
  `shareholder_capital_capability/configuration/trace`, `register_shareholder_capital_evidence`) are
  operational, call no frozen function internally, and keep their grants.
- No operational function calls a frozen one internally; the one internal call that exists
  (`treasury_secure_context` → `treasury_synthetic_signin_context`) is frozen-to-frozen.

## 4. The retired permissions (12) and the design choice behind `RETIRED`

`treasury.read`, `treasury.cash-receipt.record`, `treasury.cash-count.record`,
`treasury.cash-receipt.verify`, `treasury.handoff.create`, `treasury.cash-account.reconcile`,
`treasury.cash-account.approve`, `shareholder.capital-request.create`,
`shareholder.capital-intent.create`, `finance.posting-intent.create`,
`finance.posting-intent.approve`, `finance.journal.post`.

Each was checked against every migration and every application `can(...)`: all references are
inside the frozen functions, the removed screens, or display copy. No operational function and no
remaining page gates on any of them.

**Deviation from the Slice 1 plan text, for the owner's decision.** The plan sketched `RETIRED` as a
new value of `permission_catalogue.availability`. Implementing it that way turned out to contradict
two other conditions, so 0041 records retirements in a separate append-only register instead:

1. The frozen functions' own authorizers (0013 `treasury_runtime_authorize`,
   `finance_runtime_authorize`, 0016 `shareholder_runtime_authorize`, 0032
   `treasury_synthetic_authorize`) accept a code only while its catalogue row is `ACTIVE`. Setting
   the rows to `RETIRED` would make every frozen function refuse every call, which ends the
   database-level regression coverage the owner asked to keep.
2. `role_derived_permissions` / `sync_role_grants` (0010) derive grants only from `ACTIVE` codes, so
   the next time an administrator saved any role or user, every existing grant of a retired code
   would be revoked. The owner asked for existing grants to be preserved.
3. The catalogue is lock-only (`permission_catalogue_no_update_or_delete`); changing rows would
   require the migration to disable that trigger.

With the register: the catalogue rows and every grant stay exactly as they are; a retired code can
no longer be added to a role (database trigger and identity service); the roles editor shows a
retired code only where a role still holds it, labelled "Retired", and never offers it; the
dashboard's access list hides retired codes; `RETIRED_PERMISSION_CODES` in `@abos/contracts` mirrors
the register and the integration suite asserts the two are equal. If the owner prefers the
availability value after all, the cost is the two points above, and it should be a separate
decision.

## 5. Application changes

Removed (deleted files):

- Pages `/finance/treasury`, `/finance/handoffs`.
- Components `TreasuryWorkspace`, `TreasurySafes`, `FinanceHandoffWorkspace`,
  `ShareholderRequestWorkspace`, `SignInPrompt` (the token sign-in form).
- API routes `/api/v1/treasury/{session, overview, receipts/**, cash-locations/**, safe-counts/**,
  saraf-accounts/**}`, `/api/v1/finance/handoffs/**`, `/api/v1/shareholder/capital-requests`.
- Server modules `treasury-view.ts`, `treasury-safes.ts`, `shareholder-requests.ts`; types
  `treasury-types.ts`, `finance-handoff-types.ts`.
- Browser specs `treasury`, `finance-handoffs`, `finance-handoffs-real`, `e1-owner-demo`,
  `v1-safes-saraf`, `v1-client-preview` (retired with the screens, not skipped).

Kept on purpose: the 0036 bridge routes including
`/api/v1/treasury/shareholder-capital-receipts/[receiptId]/verify` (operational custody
verification, password sessions); `server/treasury.ts` trimmed to the Treasury database login and
the shared response helpers (the E1 session context, `currentTreasury`, `displayNames` and the
E1 repository are gone); `server/finance-handoff.ts` trimmed to the Finance executor and token.

Changed:

- Navigation (`lib/operational-routes.ts`, shared by the shell and the dashboard): Treasury and
  Finance inbox entries removed.
- `/dashboard` (`DashboardWorkspace`): name, username, job title, role names, company; the pages the
  person's permissions open, grouped like the navigation; the access list without retired codes.
  The "synthetic preview" banner is gone. The identity service's `currentUser` now returns `roles`.
- `/shareholders/legacy`: the Capital Requests tab and panel removed; "Advanced" opens on
  Shareholders; the page description no longer mentions capital requests.
- Shareholders workspace: "Safes & accounts" now links to Finance setup.
- Stage 0 Finance shell: the Treasury and Accounting tabs are ordinary empty states again.
- General Ledger: the "Open Finance inbox" link removed.
- Roles editor: retired codes handled as described in §4; the identity service refuses adding one
  with a specific message.
- `@abos/contracts`: `RETIRED_PERMISSION_CODES`.

## 6. Tests

Integration (`packages/e1-integration`), all on disposable databases:

- `security-ownership`: two new frozen-lane logins; the E1 flow calls moved to them (22 call
  sites); new test proving each frozen entry point is refused for the plain runtimes with
  SQLSTATE 42501, reaches its own authorizer for the holder, that the holder has only
  `*_test_login` members and is NOLOGIN/NOINHERIT, that the register equals the contract constant,
  and that the register is lock-only. The definer inventory stays at 108.
- `restricted-role`: the runtime no longer holds `post_synthetic_capital_receipt`; the inventory
  view is checked from the runtime's own connection.
- `admin-approval-upgrade` (historical upgrade from 0038): now applies 0039+0040+0041 and proves
  every pre-existing table byte-for-byte unchanged, the register seeded with 12 rows, no runtime
  write access to any new table, and the frozen lane closed.
- `identity-admin`, `company-profile`, `workflow-policy`: sample permissions that happened to be
  retired codes swapped for live ones; the E1 segregation-of-duties regression grants the retired
  codes directly (as the operator would) and still runs; a retired code is refused by the service
  (`VALIDATION_FAILED`) and by the database trigger.
- Every suite that exercises a frozen function grants `abos_e1_frozen_lane` to its own disposable
  login (`secure-posting-e2e`, `secure-treasury-boundary`, `treasury-finance-qa`, `safes-saraf`,
  `shareholder-request`, `shareholder-setup`, `shareholder-loan-v1`, `chart-of-accounts`,
  `shareholder-finance-bridge-schema-gated`, `currency-fixtures`).

Browser (`apps/web/tests`): the six retired specs deleted; `stage-zero-routes`, `v1-currency`,
`v1-gl-reporting`, `v1-shareholder-contributions`, `v1-shareholder-setup` updated to the new
surface; new `v1-retire-synthetic-lane.spec.ts` covering the Slice 1 acceptance criterion
("signed in as the owner: no Treasury, Finance inbox or token form anywhere; the two routes 404;
the dashboard renders without an E1 call") plus the roles editor and the legacy page. The preview
seed (`preview:seed`) now gives its synthetic people live roles instead of retired codes.

## 7. Validation (disposable databases only)

(pending — filled from the final runs)

## 8. Known limitations and follow-ups

- The `X-ABOS-Data: synthetic-sandbox` response header set by the shared `json()` helper predates
  this slice and is left as is; it is invisible to users and belongs to the authenticator rename.
- `/api/v1/auth/methods` still reports `developerTokens` (always false unless
  `ABOS_ALLOW_DEV_TOKEN_SIGNIN` is set); nothing consumes it any more. Left for the rename slice.
- The identity service and the roles editor label retired codes; the database keeps them `ACTIVE`
  in the catalogue by design (§4). A later role re-synchronisation therefore preserves them.
- `packages/sandbox-auth` and `packages/persistence` still contain the E1 gateways; they are test
  infrastructure now and leave with the deferred rename.
- The `abos_e1_frozen_lane` role exists in production after deployment with no members; the
  security-ownership test would fail if any non-test login ever joined it.

## 9. When deployment is authorized

Same discipline as 0037/0039/0040: private backup package (dump, restore list, roles without
passwords, vault snapshot, `SHA256SUMS`), identical test restore, dry run through a guarded
`apply_catalog_0041.mts` (clone of the 0040 helper with the 0040 checksum `b46806fc…` as the
accepted predecessor and the 0041 checksum above), apply exactly `0041_v1_retire_synthetic_lane`,
zero-backfill proof (expected: `permission_retirements` new with 12 rows; every other table
fingerprint identical; `frozen_lanes` shows all runtime columns false), runtime repin to the
reviewed trunk SHA, health, routes (`/finance/treasury` and `/finance/handoffs` → 404), smoke,
vault, report.
