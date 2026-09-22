# @abos/database

Driver-neutral types and migration orchestration for the Stage 1 E0 PostgreSQL
foundation.

The package deliberately does not select or install a PostgreSQL client. The
integration layer must adapt its approved client to SqlExecutor, load every SQL
file listed by migrationCatalog, and retain monetary NUMERIC values as decimal
strings. applyMigrations validates the catalog and canonical SHA-256 content
before applying a migration and recording it atomically.

No repository business fixture, account code, exchange rate, base-currency
choice, or opening balance belongs in this package.
