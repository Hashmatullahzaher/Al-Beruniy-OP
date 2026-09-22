# Stage 1 E0 database foundation

This directory contains the additive PostgreSQL foundation for the limited
Stage 1 shareholder cash-capital engineering slice. It is schema only: no real
company, people, account codes, rates, opening balances, currencies, or policy
defaults are seeded.

## Contents

- migrations/0001_e0_finance_foundation.sql creates the abos schema,
  masters, Type A/B/C separation, shareholder/cash-location records, posting
  authority records, audit/idempotency/outbox foundations, and database guards.
- verify/0001_e0_finance_foundation.sql performs read-only catalog and no-seed
  checks after migration.
- tests/0001_e0_finance_invariants.sql runs synthetic PostgreSQL behavior checks
  inside a rolled-back transaction, including SoD, posting, provenance,
  safe/ledger linkage, formal registration and controlled reversal.
- packages/database publishes the driver-neutral migration catalog, executor
  interface, and persistence row types.

## Apply and verify

The application must provide a PostgreSQL adapter implementing SqlExecutor from
@abos/database, load the migration text from the catalog's repository-relative
path, verify its SHA-256 checksum, and call applyMigrations.

For a controlled development database, an operator may instead run:

    psql $env:ABOS_DATABASE_URL --set ON_ERROR_STOP=1 --single-transaction --file infrastructure/database/migrations/0001_e0_finance_foundation.sql
    psql $env:ABOS_DATABASE_URL --set ON_ERROR_STOP=1 --file infrastructure/database/verify/0001_e0_finance_foundation.sql
    psql $env:ABOS_DATABASE_URL --set ON_ERROR_STOP=1 --file infrastructure/database/tests/0001_e0_finance_invariants.sql

The manual path does not populate schema_migrations; production tooling must
use the checked migration adapter. There is deliberately no destructive down
migration. Recovery is forward-only or database restore under an approved
procedure.

## Deliberate boundaries

- PostgreSQL NUMERIC has no declared precision or scale because those
  accounting policies are still awaiting Finance approval.
- The database does not select a base currency. A legal entity cannot move its
  currency policy to APPROVED without a base currency reference.
- Cash locations and their currency accounts are separate. A currency account
  cannot become ACTIVE without reconciliation evidence, an activation actor,
  and timestamp.
- No bank table exists in this slice.
- Posted journals require an open period, independent posting approval, at
  least two lines, exact base-currency balance, and active posting accounts.
- Audit rows and posted journal lines are immutable; corrections use linked
  reversal journals.
- PostgreSQL can abort a posting/detail-mutation deadlock without compromising
  integrity. The future database adapter must translate that transient failure
  to the typed retry contract and apply a bounded retry policy.
- Type A user_accounts, Type B business_parties, and Type C ledger_accounts are
  separate tables and relationships.
- Database constraints are defense in depth. Services must still enforce
  permissions, authorization scope, evidence eligibility, full SoD, state
  transitions, and policy configuration before writes.
