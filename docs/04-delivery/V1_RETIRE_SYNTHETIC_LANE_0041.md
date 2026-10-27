# Retire the synthetic lane — migration 0041 and the matching application change (Slice 1 D3)

Status: IMPLEMENTED on branch `claude/d3-retire-e1`, based on trunk `v1/main` at
`0aa651250b2fdec98811195ec103c43f2d5020a1` (the SHA production runs today), validated green and
merged to `v1/main` (merge commit recorded in `V1_MAX_DELIVERY_SESSION_2026-10-27.md`).
**Not deployed.** Production deployment of 0041 remains NOT AUTHORIZED until the owner
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

Every database run used the disposable PostgreSQL 17 container on 127.0.0.1:15440
(`abos_d3_retire_check` for the integration suite, `abos_d3_preview_check` for the browser suite,
`abos_d3_upgrade_copy` for the upgraded copy). Port 55432 / `abos_v1_local_review` was read only once,
for the dump in §7.4, and never written.

### 7.1 Browser suite — first full serial run and what each failure was

67 specs: 56 passed, 2 skipped (fixture-gated `direct-shareholder-capital-operational`, unchanged),
9 failed. Each failure was reproduced and classified before anything was changed:

| Spec | Cause | Classification | Fix |
|---|---|---|---|
| `v1-chart-of-accounts` | the new dashboard lists the same pages as the navigation, so an unscoped `getByRole("link")` matched twice; then the success message expected "waits in the review list", a 0039-era text that no longer exists | D3 (locator) + pre-existing since 0039 | navigation-scoped locator; assert the 0039 message |
| `v1-company` | the preview Cashier role I had given `company.dashboard.read` added a "Company dashboard" link next to "Company" | D3 (seed role choice) | Cashier role now `finance.temporary-funding.read` |
| `v1-currency` | role creation ticked the retired label "Open capital requests from installments"; the second half tested the retired capital-request screen | D3 | retired half removed; the spec now covers rates, Dari, phone and refusals |
| `v1-operational-finance` (2) | the 0040 overspend warning disables "Record expense" until its checkbox is ticked; the spec predates 0040 | pre-existing since 0040 | tick the warning |
| `v1-retire-synthetic-lane` (new) | removed routes answer the streamed not-found page with status 200, as every unknown path does (`app/loading.tsx` + `[...segments]`); the Dari tab list has a Dari name | pre-existing streaming behaviour; spec | assert "not an API answer" + not-found content; Dari locator |
| `v1-reversals` | its fixture needs the retired E1 Treasury codes on two seeded people; the seed's role sync had revoked those direct grants | D3 (seed roles) | fixture revives the grants directly |
| `v1-shareholder-contributions` | asserted status 404 for the removed route (see above) | spec | `expectGone` helper |
| `v1-shareholder-setup` | navigation link renamed to "Shareholders" in 0040; `receipt-not-operational` element gone since 0040 | pre-existing since 0040 | updated |

Also found and fixed on the way: the `View Finance inbox and journals` permission label (renamed to
"View Finance reports and journals"), and the dead `developerTokens` flag of
`/api/v1/auth/methods` (now always false; the helper is gone).

### 7.2 Browser suite — reruns and the final serial run

After the fixes of §7.1, the affected specs were rerun twice (11 then 4 specs, all passed), then the
whole suite once more from the final tree, serially, after the integration suites had released the
shared test logins: **67 specs, 64 passed, 2 skipped (fixture-gated, unchanged), 1 failed** —
`v1-shareholder-contributions` counted four contribution rows where it expects three. That spec had
passed in both earlier reruns on the same tree; see §7.2.1 for the reproduction and outcome.

Explicit reruns after the full integration run (serial, same fresh database): identity hardening,
migration upgrade, security ownership, restricted role, operational-finance configuration (session
provenance), direct shareholder capital, operational expense posting, temporary funding, General
Ledger activity, financial calendar, Chart of Accounts, currency rates — **11 suites, 104 tests, 104
passed**.

Smoke (`@smoke`, serial, against the dev server): **8 passed**. Production build (`pnpm build`, after
the browser runs so the build output cannot pollute `next dev`): **11/11 tasks successful**, the web
app compiled and generated all 12 static pages.

#### 7.2.1 The one failure of the final run — reproduced, explained, fixed

`v1-shareholder-contributions` expected three rows in a new shareholder's table and found four. It
reproduced three times out of three in its full-run neighbourhood and, once the spec checked the
stored count after each save, every time on its own. The fourth row is the 0038 live-workflow row
(`capital-operation-row`): `ContributionRow` rendered it for every declared cash contribution, and
its panel returned nothing when the capital bridge is not operational, leaving an empty table row.
The spec's expectation of three had only ever passed by timing: the count was polled while the
success message was already shown but the view had not yet reloaded with the third contribution
(two contribution rows plus the empty row), which is also why it passed in the earlier reruns.
Pre-existing since 0038; not introduced by 0041.

Fix: the row renders only when the operations panel has something to show
(`capitalOperationsAvailable`, the panel's own condition), so the legacy page carries no empty row;
the spec now checks the stored contribution count after each save, which removes the timing window.
Result: the spec passed twice in its neighbourhood, and the whole browser suite was rerun from the
final tree: **67 specs, 65 passed, 2 skipped (fixture-gated), 0 failed.**

### 7.3 Integration suite (PostgreSQL, serial, fresh disposable database `abos_d3_final_check`)

30 suites, **260 tests, 260 passed, 0 failed, 0 skipped** from the final tree. Every suite starts by
dropping the schema and applying 0001 → 0041 through the repository runner, so this is also the
fresh-install proof (30 fresh installs). The historical upgrade test applies 0039+0040+0041 on a
populated 0038 database and proves every pre-existing table byte-for-byte unchanged.

An earlier full run had four failures, each explained: the upgrade test needed to learn 0041 (done);
two `identity-hardening` failures were "Migration content checksum mismatch for 0041" because the
migration file was edited while that run was in progress (reran clean); and one
`secure-treasury-boundary` cross-lane assertion expected "permission denied" where the frozen-lane
holder now reaches the function's own authorizer (assertion widened; the plain-runtime refusal is
asserted in `security-ownership`).

Unit (every package): 169 tests, 169 passed. Typecheck: 12/12 packages. Lint: clean, zero warnings.

### 7.4 Upgrade of a real-shaped copy from 0040 to 0041

Read-only `pg_dump` of the preserved database (17 MB, 39 migrations, latest 0040) into the private
backups folder, restored into `abos_d3_upgrade_copy`; the guarded helper `apply_catalog_0041.mts`
(derived from the reviewed 0040 helper; refuses unless the checkout is at the expected commit, the
catalogue ends with 0040 `b46806fc…` then 0041 `e49aa6bd…`, and the database is exactly at 0040)
dry-ran, then applied exactly `0041_v1_retire_synthetic_lane`.

Table fingerprints (`t|count|md5` over every row of every table) before and after differ in exactly
two lines: `permission_retirements` (new, 12 rows) and `schema_migrations` (39 → 40). All 88
pre-existing tables are identical, including `user_permission_grants` (22 existing grants on the
retired codes are untouched). `frozen_lanes`: 14 rows, every runtime column false, holder true.
Business counts after upgrade: 3 shareholders, 4 contributions, 0 journals, 12 PENDING periods.

Operational flows on that copy (through a dev server pointed at the copy, the copy's identity proof
re-keyed to the synthetic secret and its Super Administrator credential replaced — copy only):
password sign-in; current user with role names; role and user creation through the administration
API; temporary-password change; eleven pages rendering with no Treasury, Finance-inbox, token-form or
capital-request text; direct capital — a new shareholder with 100 USD cash into the real Safe in one
save (journal 1, the month auto-opened, identical replay idempotent); Chart of Accounts list and
account creation; Finance setup (expense type, configuration); Workflow approvals (expense approval
OFF, the production company had never configured it); an expense of 10 USD from the Safe (journal 2);
the daily report showing 90.00 on the Safe; General Ledger read (4 lines); calendar, exchange rates
and temporary-funding reads; the legacy page's setup and contributions data (the owner's records
readable); and every frozen entry point refused for the Finance runtime login with SQLSTATE 42501
(14/14). Evidence: `operational-checks.txt`, `fingerprint-*.txt`, `post-0041-checks.txt` in the
private copy folder.

**Finding D3-F1 (pre-existing, not introduced by 0041):** `shareholder_setup_create_shareholder`
(0031) and the other shareholder setup functions judge "not in the future" on `current_date` (UTC),
while 0040 judges receipts on the Kabul day (`abos.business_today()`). Between 00:00 and 04:30 Kabul
time, adding a shareholder dated "today" is refused with "This date cannot be in the future" while the
receipt itself would be accepted. The copy check hit this window (host 23:21 UTC = 03:51 Kabul).
Fix planned as its own small migration (0042) right after D3: the affected checks and the `today`
values those workspaces return move to `abos.business_today()`.

### 7.5 Repository sweep and legacy-page audit

Sweep over `apps/web/src` and the packages the application imports (tests excluded): no reference to
`/finance/treasury`, `/finance/handoffs`, the removed components, the removed API routes, the token
form, or any frozen function. The persistence E1 gateways still exist (test infrastructure) and have
no importer in product code. `/shareholders/legacy` calls only: `shareholder/setup`,
`shareholder/setup/documents`, `shareholder/contributions`, and the 0036 bridge routes
(`capital-bridge/capability`, `capital-evidence`, `capital-receipts`,
`finance/shareholder-capital-{configuration,mapping,receipts,postings,trace}`,
`treasury/shareholder-capital-receipts/[id]/verify`); every one exists and reaches operational
functions only. The owner's real records remain readable (§7.4).

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

## 10. Summary for authorization

| Item | Value |
|---|---|
| Branch | `claude/d3-retire-e1` → merged into `v1/main` (SHA in the session record) |
| Base | `0aa651250b2fdec98811195ec103c43f2d5020a1` (production today) |
| Migration | `0041_v1_retire_synthetic_lane`, checksum `e49aa6bd788f7253c29b0a1c6abd3ac10744895ee343d5732a042f6f171dbaa6` |
| Retired entry points | the 14 of §3 (runtime EXECUTE revoked; holder `abos_e1_frozen_lane`) |
| Retired permissions | the 12 of §4 (`abos.permission_retirements`; catalogue rows and grants untouched) |
| Removed | pages, components, routes, server modules, types and specs of §5 |
| Legacy page | capital-request tab/panel removed; the empty live-workflow row no longer renders; every remaining control reaches an operational API (§7.5) |
| Integration | 30 suites, 260/260 on a fresh database (30 fresh installs 0001→0041); explicit reruns 104/104 |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 tasks, 12 pages |
| Browser | 67 specs: 65 passed, 2 skipped, 0 failed (final run); smoke 8/8 |
| Skipped | `direct-shareholder-capital-operational` (2): gated on a private fixture file from the 0040 cycle; unchanged by D3 |
| Fresh install | proven by every integration suite's schema reset (0001→0041) |
| Upgrade 0040→0041 | real-shaped copy of production: applied through the guarded helper; 88/88 pre-existing tables fingerprint-identical; only `permission_retirements` (+12 rows) and `schema_migrations` (39→40) differ |
| Zero business-data change | fingerprint diff above; 22 existing grants on retired codes untouched; 3 shareholders / 4 contributions / 0 journals / 12 PENDING periods after upgrade |
| Residual E1 references (intentional) | frozen functions, tables and records; persistence E1 gateways and `packages/sandbox-auth` (test infrastructure, deferred rename); `treasury_secure_context` developer-token fallback (unreachable); `X-ABOS-Data` header name; `abos_e1_frozen_lane` (no members in production) |
| Found on the way | D3-F1 (UTC day in shareholder setup, pre-existing) → migration 0042; the 0038 empty live-workflow row (fixed here); stale specs since 0039/0040 (fixed) |

Deployment risk assessment: **low**. 0041 is additive and reversible by the standard pre-0041 dump
restore; it writes no existing row; it changes no operational function; the only behavioural change
for a signed-in person is the disappearance of screens that did not work on company data (synthetic
gate absent). The one operational dependency checked explicitly is that no product path calls a
frozen function (§7.5, and the runtime-privilege assertions in two suites). Residual risk: a role
that still holds a retired code keeps it (by design) and a later role edit will drop it only if an
administrator removes it; the roles editor shows it as "Retired".

Production deployment of 0041 remains NOT AUTHORIZED until the owner approves this report.
