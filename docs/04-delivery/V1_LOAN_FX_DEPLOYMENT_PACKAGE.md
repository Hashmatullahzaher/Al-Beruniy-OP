# V1 loan and FX deployment package: 0061 to 0064

Prepared 2026-11-07. Not deployed. Production stays at 0060 until the owner authorizes this.

| Item | Value |
|---|---|
| Deploys | Trunk `176ae30522788e2211c51a8642b468991875e01b` |
| Validated tree | `a6e23a17a36df9081a4c1737c45334f3806540c8`, identical to that trunk |
| From | Code `84922b13c5fdfec1a1e0f8f155a069156caf7cce`, database at 0060 |

The package stays private and outside the repository, with the earlier packages. It holds the migration files, pins, guarded apply helper, read-only capture, backup, vault copy, deploy and verify scripts, rollback record and proofs.

## Rehearsed on disposable restores of a fresh production dump

| Check | Result |
|---|---|
| Migrations applied | Exactly four. A second runner applies none |
| Journals, lines, subledger entries created | 0 |
| Tables with changed rows | `finance_workflow_types`, `permission_catalogue`, `posting_sources`, `schema_migrations`, and the two new empty loan tables |
| Definers | 143 to 150, none executable by PUBLIC |
| Runtime table writes | 0 |
| Refusals | Wrong database, commit, predecessor, pinned checksum, recorded checksum, altered file, rerun |
| Code rollback | The previous code ran on the upgraded copy, every route and browser check clean |
| Database rollback | Restored the 99-table fingerprint and every function exactly |

The deploy script refuses to run without an explicit owner-authorization flag.

Later trunk commits do not change this package. It pins its own commit, and the helper refuses any other.
