# V1 Operational Gate Separation — migration 0032

## Checkpoint boundary

- Accepted base: `3bae2bec2f19b0bb337e6b326f5778414ac84990`.
- Implementation branch: `codex/v1-operational-gate-separation`.
- Intended remote checkpoint: `origin/v1/integration` after final review and a lease-protected push.
- Canonical migration checksum: `a3e029227b51fc4fd50ce1235096eb0e79c0140beba6c7410ec29c46a5eee6d1`.
- All database work and validation used disposable PostgreSQL databases on `127.0.0.1:55439`.
- The preserved `abos_v1_local_review` database on port `55432` was not connected to, migrated, reset, or modified.
- No real shareholder or operational business record was created.
- The previous uncommitted draft was preserved outside the repository at `C:\Users\STC\Desktop\Project Mazar Mall\_preserved\2026-09-30-pre0032-draft` before this clean-base implementation began.

This checkpoint separates reviewed operational configuration and read/reporting from the `SYNTHETIC_TEST_ONLY` gate. It does not open a new posting lane. Legacy E1 capital receipt, Treasury custody, Finance handoff/posting, and reversal mutations remain synthetic-only or fail closed.

## Session provenance and operational authorization

Migration 0032 adds immutable `session_provenance` to `abos.sandbox_sessions` with only two values:

- `PASSWORD_OPERATIONAL` — issued atomically by the restricted password-login function and retained by password-session refresh.
- `SYNTHETIC_DEVELOPER` — used by the existing developer/test-token lane and retained by legacy session rotation.

Every pre-0032 session is classified as `SYNTHETIC_DEVELOPER` and revoked during upgrade. A new password login is required after migration. The provenance column is protected by a trigger and cannot be changed after insertion.

`abos.operational_bearer_context` accepts only a live `PASSWORD_OPERATIONAL` session. It rechecks the active user, current credential, legal-entity grant, and requested live RBAC permission. It derives the legal entity from the session and never accepts it from the caller. The function is owned by the existing restricted identity owner and is executable only by the reviewed Finance and Treasury function owners.

The operational Finance allowlist is closed to exactly:

- `finance.calendar.manage`
- `finance.ledger-account.manage`
- `finance.ledger-account.review`
- `finance.exchange-rate.record`
- `finance.report.operational.read`

The operational Treasury allowlist is closed to exactly:

- `treasury.cash-location.manage`
- `treasury.saraf-account.manage`

Adding a permission to the catalogue does not automatically open a privileged operational path.

## Gate mapping

Classification:

1. operational configuration
2. operational read/reporting
3. real money movement/posting
4. legacy E1 synthetic-only

“Operational” below means: authenticated password session → live user/credential checks → active legal-entity grant → exact RBAC permission → reviewed `SECURITY DEFINER` entry point. “Synthetic” additionally requires the live development/test `SYNTHETIC_TEST_ONLY` authorization, scoped entity, runtime marker, and developer-session provenance.

| Function / route | Class | Previous gate | Gate after 0032 | Money-moving? | Result |
|---|---:|---|---|---|---|
| Chart of Accounts views/checks and `/api/v1/finance/accounts*` reads | 2 | Synthetic + Finance RBAC | Password operational + exact Finance RBAC | No | Operational read enabled without sandbox authorization |
| Chart of Accounts create/update/status/review | 1 | Synthetic + manage/review RBAC | Password operational + unchanged manage/review RBAC | No | Existing account rules, independent review, audit, and entity scope retained |
| Exchange-rate view/record/correction and `/api/v1/finance/exchange-rates*` | 1/2 | Synthetic + `finance.exchange-rate.record` | Password operational + same permission | No | Append-only history, exact decimals, approval provenance, and correction linkage retained |
| Financial-calendar view/configure/generate and `/api/v1/finance/calendar*` | 1/2 | Synthetic + `finance.calendar.manage` | Password operational + same permission | No | Existing overlap/date protections retained; no posting authority added |
| General Ledger page/activity and `/api/v1/finance/general-ledger*` | 2 | Synthetic + `finance.report.operational.read` | Password operational + same permission | No | Posted-only, entity-scoped, exact-decimal reporting; currencies remain separate |
| Reversal request list | 2 | Synthetic + operational-report permission | Password operational read | No | Journal visibility remains entity-scoped |
| Reversal create/decide/withdraw/post routes | 4 | Synthetic mutation gate or fail closed | Unchanged | Would affect workflow/posting | Reversal posting remains fail closed; no mutation was operationalized |
| `treasury_secure_context` and Treasury shell identity | 2/4 | Synthetic context only | Password operational context, with a synthetic-context fallback only for explicitly enabled legacy developer sessions | No | Context alone grants no operation; every query/command performs its own gate |
| `treasury_secure_query`: `LOCATIONS`, `ACCOUNTS`, `ASSIGNMENTS`, `CASH_LEDGER`, `USERS` | 2 | Synthetic + `treasury.read` | Password operational + `treasury.cash-location.manage`; synthetic `treasury.read` fallback only while the sandbox gate exists | No | Configuration projections work operationally; generic `treasury.read` is not an operational permission |
| `treasury_secure_query`: `OPENINGS`, `COUNTS`, `SOURCES`, `RECEIPTS`, `HANDOFFS`, `FINANCE_PROGRESS`, `EVIDENCE`, `EVENTS` | 4 | Synthetic + `treasury.read` | Explicit synthetic authorizer | No direct posting | Custody, evidence, receipt, capital, event, and handoff data remain sandbox-gated |
| `treasury_secure_command`: create/status cash location, open draft currency account, assign/revoke cashier | 1 | Synthetic + `treasury.cash-location.manage` | Password operational + same permission | No | Narrow configuration-only writes; trigger guards enforce reviewed shapes |
| `treasury_secure_command`: opening/count/reconcile/approve/activate/block account | 4 | Synthetic + custody permissions | Explicit synthetic authorizer | Custody state | Unchanged synthetic custody lane |
| `treasury_secure_command`: receipt record/count/submit/verify/void/handoff | 4 | Synthetic + operation-specific RBAC | Explicit synthetic authorizer | Legacy E1 capital effects | Unchanged sandbox gate; void is gated by operation despite using `treasury.read` |
| `treasury_safes_saraf_query`: Saraf choices/parties/accounts | 2 | Synthetic + `treasury.read` | Password operational + `treasury.saraf-account.manage`; synthetic fallback only for legacy sandbox use | No | Saraf configuration reads require the explicit management permission |
| `treasury_safes_saraf_query`: cash-ledger choices | 2 | Synthetic + `treasury.read` | Password operational + `treasury.cash-location.manage`; synthetic fallback only for legacy sandbox use | No | Cash-location configuration read only |
| `treasury_safes_saraf_query`: safe counts/count evidence | 4 | Synthetic + `treasury.read` | Explicit synthetic authorizer | Custody data | Whole-safe counts and evidence remain synthetic-only |
| Saraf create/status configuration commands | 1 | Synthetic + `treasury.saraf-account.manage` | Password operational + same permission | No | Existing party/ledger/lifecycle rules retained; no balance or journal created |
| Finance handoff workspace/trace | 4 | Synthetic + operational-report permission | Explicit synthetic Finance read authorizer | No | Capital receipt/handoff details cannot leak through the operational report permission |
| Finance prepare/approve/post capital receipt | 4 | Synthetic Finance gate, SoD, reconciliation, idempotency | Unchanged | Yes, synthetic only | `post_synthetic_capital_receipt` remains sandbox-gated |
| Shareholder capital request path | 4 | Synthetic + shareholder RBAC | Unchanged | Creates synthetic capital intent | Missing sandbox authorization fails before intent creation |
| Operational Finance setup and expense lane from 0027–0029 | 1/2/3 | Existing password-operational owner path | Behavior preserved; session dependency now uses explicit provenance | Expense posting only in the already approved lane | No redesign or widening of its owner/runtime grants |
| Password login/current-user/password refresh | Identity prerequisite | Password path still depended on synthetic session behavior in places | Dedicated password-session issue/refresh functions preserve `PASSWORD_OPERATIONAL` | No | Server proof, token hashing, active user, current credential, entity grant, and mandatory-password policy retained |
| Developer-token issue/rotate and `/api/v1/treasury/session` POST | 4 | Explicit local-development synthetic lane | Still `SYNTHETIC_DEVELOPER`; cannot upgrade to operational; route remains 404 unless explicitly enabled | No | Missing sandbox authorization rejects the token even when the route is enabled |

## Narrow trigger architecture

Migration 0032 replaces the four existing Treasury configuration trigger functions with dual-path guards; it does not remove protection:

- `cash_locations`: operational path permits new `DRAFT` locations and guarded configuration updates only.
- `cash_location_cashier_assignments`: operational path permits assignment and revocation only.
- `cash_location_currency_accounts`: operational path permits new `DRAFT` accounts without evidence, reconciliation, activation, or custody state.
- `saraf_accounts`: operational path permits reviewed Saraf configuration while the existing lifecycle guard remains active.

The operational trigger context can only be set by the reviewed Treasury owner path. Runtime credentials cannot set it to obtain table access and have no direct table-write grants. Physical counts, cash-account openings, safe counts, receipts, handoffs, Treasury events, posting intents, approvals, journals, journal lines, and audit records retain their existing controls.

## Database ownership and privilege evidence

The real PostgreSQL suite verifies:

- every restricted `SECURITY DEFINER` entry point is accounted for (67 functions);
- function owners are non-login, non-superuser, non-`BYPASSRLS` roles;
- identity, Treasury, and Finance runtime logins cannot `SET ROLE` to an owner;
- runtime logins have no direct protected-table write path and cannot create a temporary shadow table;
- developer tokens cannot call the operational allowlists;
- password sessions cannot call legacy capital, receipt, handoff, synthetic posting, or reversal mutations without the synthetic gate;
- operational configuration/reporting works after sandbox authorization is removed;
- entity scope and live permission revocation are enforced on every call;
- existing operational expense posting remains balanced, immutable, precise, scoped, and idempotent;
- existing legacy Treasury and Finance workflow still works when the synthetic gate is present.

The populated-upgrade test constructs a 0031 database state, snapshots every business table, applies 0032 inside a transaction, and proves:

- all business rows are identical after upgrade;
- all old sessions are revoked and classified `SYNTHETIC_DEVELOPER`;
- runtime roles receive no new direct table-write privileges;
- the migration catalogue and canonical checksum match.

## Final validation

All accepted validation runs used the clean implementation worktree and disposable databases only.

| Validation | Passed | Failed | Skipped | Blocked | Result |
|---|---:|---:|---:|---:|---|
| PostgreSQL security/integration suite | 173 | 0 | 0 | 0 | 24 suites passed on disposable PostgreSQL |
| Package unit and migration tests | 133 | 0 | 0 | 0 | Nine packages passed |
| Strict workspace typecheck | 12 tasks | 0 | 0 | 0 | Passed |
| ESLint | 1 command | 0 | 0 | 0 | Passed with zero warnings |
| Production build | 11 tasks | 0 | 0 | 0 | Passed |
| Smoke browser suite | 7 | 0 | 0 | 0 | Passed |
| Full serial browser suite, database modes disabled | 34 | 0 | 18 | 0 | Expected gated database tests skipped |
| Password-session PostgreSQL browser journeys | 12 | 0 | 0 | 0 | CoA, company, currency, calendar, expense, reversal, safe/Saraf, shareholder, workflow policy, and client-preview journeys passed |
| Explicit developer-token Treasury browser suite | 6 | 0 | 0 | 0 | Synthetic Treasury custody, receipt, handoff, session-revocation, and RTL regression passed |

Two preliminary browser attempts stopped on test-environment setup before product assertions: the password run initially lacked the ignored `apps/web/.env.local` file, and the first legacy run correctly refused a database name without `dev`/`sandbox` and then encountered an unseeded schema before its suite seed. The environment was corrected without changing product code, and the complete accepted reruns above passed. No validation item remains blocked.

## Remaining boundaries

- This checkpoint does not authorize deployment, merge to `main`, real financial posting, or real shareholder creation.
- It does not remove `SYNTHETIC_TEST_ONLY` from the preserved local-review database.
- Legacy E1 capital and Treasury custody workflows still require the synthetic authorization by design.
- Reversal posting remains fail closed pending a separately approved operational accounting policy.
- Operational Treasury configuration permits structure only; it does not create opening balances, activate custody, receive cash, or post journals.
- The existing Operational V1 expense lane is preserved and was regression-tested; it was not broadened by 0032.
