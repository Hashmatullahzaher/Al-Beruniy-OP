# E1 sandbox database identities

The migration identity owns the `abos` schema, applies migrations, and is never the application
credential. Migration `0004` creates `abos_e1_runtime` as `NOLOGIN`; deployment provisions a
separate restricted login and grants it membership only in that role.

Migration `0007` removes the role's table and sequence access. Its sole financial capability is
`EXECUTE` on `abos.post_synthetic_capital_receipt(text, uuid, uuid)`. The `SECURITY DEFINER`
function has a fixed `pg_catalog` search path, uses schema-qualified objects, accepts no actor,
amount, currency, account, journal-line, policy, or evidence values, and derives them from locked
database records. It authenticates the opaque token against a private digest, then rechecks the
active user, live session, Finance grants, scopes, synthetic-only gate, independent approval and
evidence, segregation of duties, Treasury/source identity, period, ledger mapping, balance,
source uniqueness, and idempotency in one transaction.

The runtime role cannot read token digests or authorization configuration, set its own actor,
write protected tables, disable triggers, replace guard functions, grant permissions, or enable
real posting. The runtime marker remains defense in depth for owner-side fixtures; the controlled
function derives and presents it only after validating the protected gate.

The real PostgreSQL suites use separate migration-owner and restricted runtime identities. They
prove successful synthetic USD posting and denial after revocation, without approval, with a
forged token, or through direct SQL. This is a development/test boundary, not production identity,
Treasury completion, client Chart of Accounts approval, or authorization for real records.
