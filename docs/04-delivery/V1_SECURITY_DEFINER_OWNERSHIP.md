# V1 security checkpoint — SECURITY DEFINER ownership (release blocker)

Status: **resolved in `v1/integration` at `1bb0e2a`** (migration 0011), independently reviewed.
Production posting remains disabled for other reasons (see "Before real posting" below).

## What was wrong

All 12 SECURITY DEFINER functions from migrations 0007–0009 were owned by the migration identity `abos`. That role is a superuser with BYPASSRLS and CREATEROLE, so any logic flaw in a Treasury or Finance entry point ran with unlimited database authority. That included the ability to disable the immutability, posting and segregation-of-duties triggers.

The other items were confirmed not to be vulnerable:
- Runtime roles hold **no** table privileges. They can only execute their entry points.
- Actors are derived from the opaque session token.
- Legal-entity and participation-based segregation-of-duties checks are enforced in the database.
- No function body uses dynamic SQL.
- No role can create objects in `abos` or `public`.

## What changed (migration 0011)

| Control | Implementation |
|---|---|
| Least-privilege owners | `abos_e1_treasury_owner` owns the 5 Treasury entry points and `abos_e1_finance_owner` owns the 7 Finance ones. Both are NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOINHERIT. The migration refuses to run if either has a membership. |
| No table ownership | The owners own no table. They cannot ALTER or DROP a table, or disable triggers. |
| Minimal privileges | The owners have SELECT where their functions read. INSERT and UPDATE are granted **by column**, only for what the functions and the triggers they fire change. There is no DELETE, TRUNCATE, TRIGGER or REFERENCES. Treasury cannot write any ledger table; Finance cannot write any custody table; neither can read identity tables. |
| Lock-only tables | Row locks (`FOR SHARE/UPDATE`) need UPDATE privilege, so only the primary-key column is granted. `abos.forbid_owner_update` then refuses any change by an owner, which gives two layers of protection. |
| Search path | Every definer runs with `search_path = pg_catalog, pg_temp`. TEMPORARY is revoked from PUBLIC, so no temporary object can shadow anything. |
| Helpers | The six internal helpers are no longer executable by PUBLIC. By default, functions created later by the migration identity are not PUBLIC-executable either. |

Migration 0012 (financial calendar) follows the same model: its 3 new entry points are owned by the Finance owner.

## Tests

`packages/e1-integration/src/security-ownership.test.ts` covers:
- the catalogue model: owners, attributes, pinned search path, no PUBLIC execute, the exact function-to-owner map;
- that owners own no tables and hold no destructive privileges;
- each owner's remit: Treasury ↛ ledger, Finance ↛ custody, neither ↛ identity;
- the lock-only guard at both layers, checked by SQLSTATE and message;
- `ON CONFLICT DO UPDATE`, trigger disabling, DELETE, and temporary tables;
- direct runtime calls to internal authorizers and all six helpers;
- `SET ROLE` to an owner, and direct table writes;
- that posting still works, a duplicate posting returns the same journal, and posted journals cannot be changed even by the Finance owner;
- a session used in another legal entity.

The existing suites keep covering self-approval, cross-entity access, duplicates and posted-record immutability.

## Independent review

A separate read-only reviewer found no blocking issues and concluded that 0011 resolves the blocker and is acceptable to integrate. Its recommended hardening (M1–M3, L1–L5, I1) was applied before integration.

Open from the review:
- **I2:** owners can read contact columns of `user_accounts`. This is informational; column-level SELECT is optional.
- **I3:** the actor and sandbox marker travel in session settings. This is documented as an invariant: every entry point sets them only after authenticating the token, and no entry point writes before authorizing.

## Before real posting could be enabled (unchanged blockers)

1. Tables are still owned by the superuser migration identity. A non-superuser table-owner role and a migration role distinct from any runtime are required, with no superuser on the application path.
2. The Treasury and Finance functions deliberately refuse to run unless the synthetic sandbox gate holds (`SYNTHETIC_TEST_ONLY`, `real_posting_enabled = false`). Real posting needs a new, reviewed gate design and Finance Manager policy approvals, not a flag change.
3. Operations: backups with tested restore and point-in-time recovery, audit logging of role and privilege changes, and alerts on DDL, role changes and trigger changes.
4. The identity hardening items in `OPEN_ITEMS.md`.
