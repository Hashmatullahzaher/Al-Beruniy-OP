# V1 Phase 1 / Phase 2 checkpoint — independent takeover review

Reviewer and integrator: Claude Code. Date: 2026-09-28.
Subject: `feat/v1-phase2-codex` at `751e9d6750b69f5bdbfd1e8b687867720b02423a` (Codex checkpoint), 15 commits ahead of
and 0 behind `v1/integration` at `a421ac54fbabfe4f9ca8ce91733159aedc91555c`.

The repository was treated as authoritative. Every statement below was checked against code, the catalogue and a live
PostgreSQL 17 database, not taken from the Codex report.

## 1. Handoff verification

- `origin/feat/v1-phase2-codex` = `751e9d6…` and `origin/v1/integration` = `a421ac5…`, both as stated.
- The 15 commits are: company configuration (#8, 0017); schema-reset serialization; daily rates and snapshots (#13,
  0016); AFN custody and shareholder requests (#12, #15); Chart of Accounts (#10, 0014); safes, Saraf accounts and
  whole-safe counts (#11, #16, 0015); their UI/API/browser tests; four branch merges; and the security/finance commit
  (0019, 0020, 0021, General Ledger preview, identity hardening).
- Every migration file's SHA-256 matches its catalogue entry; 0001–0013 are unchanged.

## 2. Identity privilege boundary (0021) — findings

Verified on a live database after the full suite:

| Check | Result |
|---|---|
| Identity runtime has no INSERT/UPDATE/DELETE on any identity table | Pass — SELECT only (18 tables); no column-level write grants |
| Owners (`abos_v1_identity_owner`, Finance, Treasury, Shareholder) are NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT | Pass |
| No role is a member of any owner (no `SET ROLE` path) | Pass — only runtime→test-login memberships exist; migration also refuses to apply if one exists |
| Every `abos` SECURITY DEFINER function pins `search_path = pg_catalog, pg_temp` | Pass (0 exceptions) |
| No SECURITY DEFINER function is executable by PUBLIC | Pass (0 exceptions) |
| Command mechanism allows arbitrary SQL | No — a fixed `CASE` over 20 operations, no dynamic SQL, unknown operations raise `42501` |
| Proof bypass (NULL, short, wrong) | Refused with `42501` for all four entry points (tested) |
| Identity runtime can read the proof digest | No — no privilege on `identity_runtime_configuration` |
| Session rotation atomic | Pass — old row locked `FOR UPDATE`, new session inserted and old revoked in one function; replay returns `affected 0` |
| Password change | Compare-and-set on the verified hash; every session revoked in the same transaction; session issue re-checks the hash `FOR SHARE` |
| Suspension, role/permission revocation | Sessions revoked in the same transaction; each request re-reads live status and grants |
| Identity owner has Finance/Treasury privileges | No — its table set is identity, audit (entity-type restricted), sandbox gate reads only |

**Finding IDN-1 (Medium) — fixed in this review.** The database proof was the raw `ABOS_SANDBOX_SIGNING_SECRET`,
which also signs posting gates and peppers session-token digests. It was sent as a bind parameter on every identity
call, so any database-side capture of parameters (`log_statement`, extensions, a proxy) would expose the master key.
Fix: the application now sends `HMAC-SHA256(secret, "abos-identity-database-proof-v1")`; the provisioned digest is
the SHA-256 of that derivative (`identityDatabaseProofDigest`). The raw key never leaves the process. No migration
change was needed. New test: the raw secret is refused, the derivative is accepted, and the stored digest is not the
digest of the raw secret.
Operator impact: a database provisioned before this change holds the old digest, so identity calls fail closed
until it is re-provisioned; `preview:seed` and `sandbox:seed` do this.

**Residual (not blocking the synthetic preview; tracked under #6):**
- The identity runtime can read `user_credentials.password_hash` (scrypt) because verification runs in the
  application. A leaked runtime credential therefore exposes hashes to offline guessing.
- `ISSUE_SESSION` trusts the caller after `identity_issue_session_context`; a holder of the proof plus the runtime
  credential can mint sessions. This is the documented trust boundary (proof = the application).
- Secret rotation has no procedure yet; rotating it requires re-provisioning the digest with an owner connection.

## 3. General Ledger and Finance trace (0019, 0020) — findings

| Check | Result |
|---|---|
| Exact decimals | Every numeric column in the traced tables (5) is emitted as text; GL lines and totals are text; the web layer has no `Number`/`parseFloat` on money |
| Legal-entity isolation | Entity from the token only; account filter outside the entity raises `42501`; another entity's session is refused |
| Project / department / cost-center scope | Conjunctive, live, immediate on revocation (tested for all three) |
| Treasury / Identity runtimes | Cannot execute `finance_general_ledger` (tested) |
| Invalid token | Refused (tested); API maps to 401/403 without detail |
| >100 rows | `pageLimit`, `returnedLineCount`, `hasMore` returned; UI shows an explicit note (browser test) |
| Actor names | Only for actors recorded on the traced rows of the caller's entity; display name only |
| Read-only | The function only reads; posted journals and lines remain immutable even to their owner (tested) |

No defect found. Limitation: there is no offset paging yet; the UI tells the user to narrow the range.

## 4. Migration 0018

Conclusion: **0018 does not exist and never did.** No branch on the remote (21 branches), no commit in any history
(`git log --all -- '*0018*'`, `-S0018_`), and no document references a migration 0018. The Phase 1 contract assigned
only 0014–0016 to packages; the lead took 0017; the checkpoint continued at 0019.

The gap is harmless: the runner orders by catalogue position and keys by id; nothing requires contiguous numbers.
Decision: **0018 is permanently retired.** It must not be created later, because a future 0018 placed before 0019 in
the catalogue would run after 0019–0021 on existing databases but before them on new ones. The next migration is
0022. No migration was renumbered or rewritten.

## 5. Defects found by running the gated browser journeys

Codex's browser run skipped 12 gated tests. Running every gated journey against a freshly seeded dev database
found two defects introduced by the checkpoint; both are fixed here.

**IDN-2 (Medium, functional) — credential-less sessions stopped resolving.** 0021's `identity_actor_context`
inner-joined `user_credentials`, so an operator-seeded persona without a password could no longer resolve through
the identity service (`/api/v1/auth/me` → 401), unlike before 0021. Fix: migration **0022** replaces the function
with a separate `FOR SHARE` credential read and `mustChangePassword = false` when there is no credential (the
pre-0021 behaviour). Owner, `search_path`, PUBLIC revoke and the single runtime grant are re-asserted. Session
rotation still requires a credential and is unchanged. 0021 itself was not edited. Regression test added
(`identity-hardening-v1.test.ts`: the persona resolves and cannot rotate).

**FIN-1 (Low, UI) — the signed-in person lost "You" in the Finance trace.** With #20 the trace returns names, so the
labeller no longer saw ids and showed the preparer's own name where the owner demo expects "You". Fix: the trace
view carries each recorded actor's id next to the name; the signed-in person is matched by id. Other people show
their recorded names.

## 6. Validation

Codex-reported (not independently re-derived): lint pass; typecheck 12/12; unit 133/133; migration 6/6; PostgreSQL
122/122; identity hardening 7/7; identity administration 13/13; GL 7/7; build 11/11; smoke 5/5; browser 29 passed,
12 skipped.

Claude-run, on PostgreSQL 17 (Docker `postgres:17-alpine`), Node 22, Chromium from the container:

| Suite | Before fixes (`751e9d6` as handed off) | After fixes (integrated head) |
|---|---|---|
| Lint | pass | pass |
| Typecheck | 12/12 | 12/12 |
| Unit | 133/133 | 133/133 |
| Migration (`@abos/database`, part of unit) | 6/6 | 6/6 |
| PostgreSQL integration (all files) | 123/123 | 124/124 |
| Identity hardening + administration | included in the 123 | 21/21 after the IDN-1 fix; the 124 run includes the IDN-2 case |
| Build | 11/11 | 11/11 |
| Smoke | 5/5 once the dev database was seeded | 5/5 |
| Browser, including all gated DB journeys | 35 passed, 3 failed, 3 did not run (IDN-2, FIN-1, and one spec run without `ABOS_FINANCE_DATABASE_URL` exported) | **41 passed, 0 skipped, 0 failed** |

The counts differ from Codex's because the per-file counts group subtests differently; no test was removed.
Environment note: Playwright 1.63 expects a newer headless shell than the container has, so the browser runs used a
local, uncommitted config wrapper that points `launchOptions.executablePath` at the installed Chromium.
