# Production deployment record — 0055 + 0056 (2026-11-03)

Owner authorization was given on 2026-11-03 for the approved trunk and checksums below. The deployment used the established procedure:

1. Backup.
2. Test restore.
3. Rehearsal.
4. Guarded apply.
5. Verify.

Private evidence is kept outside the repository in the package `deployment-0055-0056-20261103-151500` (under the AlBeruniyOS backups folder, with an access list).

## Identity

| Item | Value |
|---|---|
| Deployed trunk SHA | `cc929c5f0829ac33989f3491503bbd78cd2ad10e` |
| Previous runtime | `25fa8a74bb27cc8e7b648209c6f074db215162ae` (database at 0054) |
| `0055_v1_report_source_detail` | `2ec859aba850c09747909ed415f8a551c0a7ae7084f4ab39b7715b8f1d1e087f` |
| `0056_v1_transition_time_is_audit_only` | `4fd0f083b7ebd451d88cf4aa2f060b4aa10d4d5dbfc089ac1fa5e99881b9eb5c` |
| Migration registry after | 55, latest `0056_v1_transition_time_is_audit_only` |
| Downtime | Web app stopped 15:19:43, healthy 15:21:23 (+04:30). There was a second clean restart at 15:26 (see the operational finding below). |

## Before the apply

- **Pre-checks.** The trunk is at the approved SHA. Both checksums are recomputed and exact. The catalog holds 55 migrations, sorted and matching the files. The checkouts are clean. No env, dump or key file is tracked.
- **Backup.** The pre-deployment dump has sha256 `5eb5dbbda856705b8cf616b81085f888f174f7f51919250a671b9e04cdbef96b`.
  - `pg_restore --list`: 2,904 entries, 99 of them table data.
  - Roles inventory: no password lines.
  - The vault snapshot is identical to the live vault.
- **Test restore.** 99/99 table fingerprints are identical to live production.
- **Captured state.**
  - Journals 0; journal lines 0.
  - The Safe کسه: opening 0, in 0, out 0, book 0.
  - FY 2026 is open.
  - 137 SECURITY DEFINER functions, 0 executable by PUBLIC.
  - Grants: 10,970. Roles: 18.
  - Vault reconciliation: CLEAN.
- **Guarded helper.** `apply_catalog_0055.mts`, step `RS`, refused each of the following on restored copies:
  - wrong commit;
  - wrong database;
  - wrong predecessor (0054 missing);
  - wrong recorded checksum;
  - altered migration file;
  - rerun.
- **Rehearsal on the restored copy.**
  - It applied exactly `0055` and `0056`.
  - Only `schema_migrations` changed.
  - Safes, business counts, period state and permissions are unchanged.
  - Exactly four function bodies changed, keeping their owners and ACLs, and one function was added (report owner; EXECUTE for `abos_e1_runtime` only).
- **Behaviour on the copy.** Synthetic people and accounts were created on the copy only.
  - **0056.**
    - 100 of 100 approval-OFF expenses posted, each in one transaction.
    - Equal and earlier clock readings are accepted, and the stored time is not moved back.
    - Version, transition, identity, delete and posted-immutability rules still refuse.
  - **0055.**
    - A Finance reader sees "Expense · EXP-001 — Office supplies", with the journal reference kept.
    - A report-only reader sees "Expense" with no detail, and identical balances.
    - General Ledger sources equal the journal detail.
    - The trial balance is balanced.

## After the apply

- **Production versus rehearsal.** Every table except `schema_migrations` is identical to the rehearsal.
- **Financial state.**
  - Journals 0; journal lines 0.
  - The Safe کسه is still at book 0.
  - Expenses 0; temporary funding 0.
  - FY 2026 is still open.
  - Policies and ledger balances are unchanged.
- **Privileges.** 138 SECURITY DEFINER functions, 0 executable by PUBLIC. Grants (10,970) and roles (18) are unchanged.
- **Repin.**
  - The runtime is at `cc929c5`.
  - The startup guard pins `cc929c5` (startup script sha256 `cf4be590…`).
  - Health reports `gitSha` `cc929c5…`.
- **Live checks.**
  - All finance APIs answer JSON 401 without a session.
  - All pages answer 200; `/finance/periods` still redirects.
  - A cross-origin write is refused with 403.
  - Live smoke: 11/11. Live browser: 69/69.
- **Post-deployment dump.** sha256 `bde91b0a5abb028fc028ddae9020a987ea5ab91be75c1787e29ed2ffbad84588`; its test restore is identical to production (99 tables).
- **Vault reconciliation.** CLEAN.

## Rollback readiness

`ROLLBACK_READINESS.txt` is in the package, which is sealed (98 files). The procedure:

1. Stop only the web app.
2. In the database: `DROP SCHEMA abos CASCADE`.
3. Restore the pre-0055 dump.
4. Repin the runtime to `25fa8a7`.
5. Restore the previous startup script.
6. Validate the 99-table fingerprint, then restart.

Rollback is only needed if 0055 or 0056 misbehave. They wrote no rows except the two registry rows.

## Operational finding

After the cold `.next` that a repin requires, the first `next dev` start left several `/api/v1/finance/*` routes resolving to the catch-all "Workspace not found" page:

- safes;
- financial years;
- money;
- trial balance;
- general ledger;
- journal reversals.

Their code was correct. A clean stop, removing `apps/web/.next` and restarting through the scheduled task fixed it, and every API then answered JSON 401.

Production runs `next dev`, so future deployments probe the API routes, expecting JSON 401, after every restart. Moving the preserved localhost to `next build` / `next start` would remove this class of problem; that needs an owner decision.
