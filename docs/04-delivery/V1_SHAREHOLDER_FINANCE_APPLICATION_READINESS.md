# V1 Shareholders → Finance application-layer readiness

Status: **application contracts ready; operational capability unavailable**

Source coordination baseline: `1758f037a0cf06757f2866dc27ab026f4cbe9ea4`

This checkpoint adds no SQL, migration entry, database adapter, deployment, credentials, runtime configuration, Temporary Funding object, or production financial activation. The schema remains the proposal in `V1_SHAREHOLDER_FINANCE_MIGRATION_READINESS_MANIFEST.md` pending P2 coordination.

## API and service boundaries

Reserved endpoints:

| Operation | Endpoint | Required future permission |
|---|---|---|
| Capability | `GET /api/v1/shareholder/capital-bridge/capability` | public capability metadata only |
| Record receipt | `POST /api/v1/shareholder/capital-receipts` | `shareholder.capital-receipt.record` |
| Verify custody | `POST /api/v1/treasury/shareholder-capital-receipts/{receiptId}/verify` | `treasury.capital-receipt.verify` |
| Prepare posting | `POST /api/v1/finance/shareholder-capital-receipts/{receiptId}/prepare` | `finance.posting-intent.create` |
| Approve/reject | `POST /api/v1/finance/shareholder-capital-postings/{postingIntentId}/decision` | `finance.capital-receipt.approve` |
| Post | `POST /api/v1/finance/shareholder-capital-postings/{postingIntentId}/post` | `finance.capital-receipt.post` |
| Read trace | `GET /api/v1/finance/shareholder-capital-trace/{contributionId}` | `shareholder.capital-receipt.read` |

All write schemas are strict and omit actor ID, legal entity, permissions, session provenance, approval flags, workflow policy, ledger mappings and account classifications. The application service accepts a server-only session proof plus correlation/idempotency metadata. A future PostgreSQL gateway must resolve and revalidate all authority and configuration through the reviewed SECURITY DEFINER entry point.

Current reserved write and trace routes return HTTP 503 with `SCHEMA_NOT_AVAILABLE`. There is no production memory adapter and no environment switch that can claim the coordinated schema is installed.

## Authorization boundary

Operational execution requires:

- an active, unrevoked, unexpired `PASSWORD_OPERATIONAL` session;
- current user status and no forced password change;
- current legal-entity grant for the source object;
- the exact current permission listed above;
- Treasury recorder and custody verifier separation;
- Finance approver separation from the Treasury recorder, custody verifier, and Finance preparer;
- database-owned source, policy, evidence, destination, mapping, accounting-period and participant facts.

Synthetic/developer provenance cannot enter this application lane. The existing isolated memory kernel continues to test active-session, current-grant, entity-scope, idempotency, concurrency, source-fingerprint, over-receipt and posting uniqueness behavior, but it is not connected to any production endpoint.

## Capability gate

The capability states are `NOT_OPERATIONAL`, `SCHEMA_NOT_AVAILABLE`, and `OPERATIONAL`. This branch always reports `SCHEMA_NOT_AVAILABLE` for the production bridge. A later database-backed capability probe must prove the coordinated schema/functions/privileges before returning `OPERATIONAL`.

The review page is available only when `ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE=1` and `NODE_ENV` is not production. Playwright sets that flag only for its isolated test server. The real Shareholder page remains read/setup capable and displays an English/Dari boundary explaining that receipt, custody verification, Finance approval and posting are unavailable.

## Read model

The pure projection in `packages/finance/src/shareholder-capital-read-model.ts` keeps these amounts separate per exact contribution ID and currency:

- declared;
- received;
- custody verified;
- Finance approved;
- posted;
- outstanding declaration.

Each receipt retains destination and state lineage. Shareholder profile and business party remain explicit. Legacy agreements are returned in a separate collection with `includedInContributionTotals: false`. Tests preserve Zemar's two same-value declarations as different contribution IDs and keep Hashmatullah's legacy agreement outside both totals.

## Idempotency and concurrency contract

- every write carries a server-side correlation ID, stable idempotency key and strict version expectation;
- same key/same canonical request replays the authorized result;
- same key/different request rejects;
- source uniqueness prevents a different key from producing another posting for the same receipt;
- expected contribution/receipt/intent versions reject stale commands;
- receipt allocation locks prevent concurrent over-receipt;
- one receipt can have at most one terminal custody decision, one intent, one terminal Finance decision and one journal;
- only the first same-currency CASH path is represented; deferred paths remain unavailable.

The database constraints and lock behavior remain proposed, not claimed as implemented.

## Audit and event contracts

Typed event names cover receipt recorded, custody verified/rejected, posting prepared, posting approved/rejected, and receipt posted. Payloads carry source/receipt/intent/journal lineage, before/after state, and policy/mapping/evidence references. Credentials, session proofs, file bytes and caller authority claims are excluded. The future adapter must append audit/outbox facts in the same transaction and emit nothing extra on an idempotent replay.

## PostgreSQL harness gate

`packages/e1-integration/src/shareholder-finance-bridge-schema-gated.test.ts` lists the required upgrade, isolation, posting-shape, idempotency, concurrency and deferred-path cases. It does not connect to PostgreSQL unless `ABOS_SHAREHOLDER_FINANCE_SCHEMA_TESTS=1`. When enabled it also requires `ABOS_TEST_DATABASE_URL`, applies only the repository migration catalog to a disposable schema, fails if the coordinated objects are absent, verifies zero fresh-install receipt backfill, and checks that restricted runtimes lack direct protected-table mutation.

The remaining gated cases are deliberately skipped until the coordinated migration and its disposable fixtures exist. No fake migration or table is created by the harness.

## UI boundary

The isolated English/Dari review displays Declared, Received, Custody verified, Finance approved, Posted, and Outstanding separately. A Treasury recorder cannot verify their own receipt. Finance actions do not appear before custody verification. The review uses React memory only and makes no business API request. Refresh clears it.

The operational Shareholder page exposes no Record, Verify, Approve, or Post control. Its banner reports the absent schema capability rather than implying success or an ended session.
