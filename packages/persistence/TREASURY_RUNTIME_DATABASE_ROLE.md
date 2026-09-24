# Restricted Treasury database role

Migration `0008_e1_secure_treasury_boundary` creates `abos_e1_treasury_runtime` as a `NOLOGIN`,
`NOINHERIT`, non-superuser role. Deployment must provision a separate application login and grant
it membership in this role. Migration and runtime credentials must remain separate.

The role has no table, sequence, schema-management, session-token, grant, or sandbox-gate access.
It receives schema `USAGE` plus `EXECUTE` on only:

- `abos.treasury_secure_query(text, uuid, text, uuid)`
- `abos.treasury_secure_command(text, uuid, text, jsonb)`

Both functions derive the actor from the opaque bearer token, recheck the live session, user,
legal entity, synthetic sandbox gate, scope and operation-specific permission, and set the protected
runtime marker inside the transaction. All SQL is static and schema-qualified under a fixed
`pg_catalog` search path. Existing Treasury triggers continue to enforce state transitions,
segregation of duties, evidence, source matching and append-only audit history.

The restricted role is synthetic development/test infrastructure. It is not authorized for real
cash, production posting, real customer records, or production deployment.

The web server must set `ABOS_TREASURY_DATABASE_URL` to an independent login that inherits only
`abos_e1_treasury_runtime`. `ABOS_DATABASE_URL` remains the separate sandbox authentication and
migration credential and must never be reused as the Treasury URL.

## Open hardening blocker

The three `SECURITY DEFINER` entry points are still owned by the migration identity. A proposal to
create a persistent dedicated owner holding the relation privileges required by all Treasury
triggers was rejected by automatic approval review because that role's combined session reads and
financial DML created an excessive privilege blast radius. Do not work around that decision. A
narrower owner architecture or explicit owner approval is required before production use.
