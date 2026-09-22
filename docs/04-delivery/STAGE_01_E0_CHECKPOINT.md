# Stage 1 E0 Checkpoint — Shared Foundation and Finance Contract

**Checkpoint status:** `READY_FOR_OWNER_REVIEW`
**Environment:** development/test only
**Branch:** `agent/codex/stage-1-finance-foundation`
**Exact base SHA:** `999a5335521fac5a9ac9b01b9e5d8261c47424d5`
**Approved Stage 0 reference:** `a4ff484d357d22ba60ab1efd1650022bde9ab43c`
**Checkpoint implementation SHA:** `bf7af4bca28df840971f7100bced3a5e9f9693f2`

## Authorization and purpose

The E0 engineering gate establishes a common contract and eligible WP-0002/WP-0003/WP-0005 foundations for coordinated Shareholder, Treasury and Finance work. It does not permit real records, live posting, production deployment, official reports or unattended implementation of later Stage 1 slices.

## Governance reconciliation

- Recorded the coordination and Stage 0 reference SHAs without rewriting historical Stage 0 approvals.
- Kept legal-entity accounting currency and every Finance Manager policy approval-gated while freezing USD/AFN transaction-currency types.
- Recorded that the current slice has physical safes and later Saraf boundaries, with no bank account or bank integration.
- Accepted the narrow E0 dependency exception in ADR-0001 while preserving F0/F1/F2/F3 gates.
- Marked WP-0002, WP-0003 and WP-0005 `IN_PROGRESS`; none is `DONE`, `VERIFIED` or an F0 gate pass.
- Published the `stage1-e0-v1` schema/API freeze and Finance-only General Ledger ownership boundary.

## Checkpoint inventory

The implementation is complete for the authorized E0 checkpoint. Operational posting remains disabled and later Stage 1 work remains outside this handoff.

| Area | State | Evidence |
|---|---|---|
| Governance and dependency exception | Documented | ADR-0001 and governance ledgers |
| Shared schema/API contract | Frozen for E0 review | `docs/03-architecture/STAGE_01_SHARED_SCHEMA_API_CONTRACT.md`; typed-contract SHA `bf7af4bca28df840971f7100bced3a5e9f9693f2` |
| Typed contracts | Implemented and locally validated | `packages/contracts`; exact implementation SHA `bf7af4bca28df840971f7100bced3a5e9f9693f2` |
| Database/migration foundation | Implemented for E0 review | `infrastructure/database`; migration checksum `9259f624433992d71aeff84078cb606f066a24f8fc2dfb4a7dcd5592c9ebd80e` |
| API/service boundary | Read-only E0 status implemented | `apps/web/src/app/api/v1/finance/foundation/route.ts`; no financial mutation route enabled |
| Finance invariant kernel | Implemented and locally validated | `packages/finance`; posting remains synthetic development/test only |
| CI quality gate | Implemented; remote run pending push | `.github/workflows/stage1-e0-quality.yml`; PostgreSQL 17 applies, verifies and behavior-tests the migration |
| Operational capital posting | **BLOCKED** | E1 policies and prerequisites unresolved |
| Real opening balances and production records | **NOT AUTHORIZED** | separate owner and Finance approval required |

## Validation evidence

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS — all 6 workspace projects already up to date |
| `pnpm lint` | PASS — zero warnings |
| `pnpm typecheck` | PASS — 5/5 workspaces |
| `pnpm test:unit` | PASS — contracts 5/5, database 5/5, finance 23/23 |
| `pnpm build` | PASS — Next.js production build and API route compilation |
| `pnpm test:smoke` | PASS — 3/3 |
| Serial Playwright browser suite | PASS — 23/23, including tablet and Dari RTL coverage |
| Stage 0 preservation | PASS — no holographic-presentation diff; Mazar Mall image blob remains `fbee1f2a9d10278d9084949b4677b42a055d6aeb` |
| Contract and migration checks | PASS — OpenAPI/typed contract tests and canonical migration checksum validation |
| High-risk independent review | PASS for E0 — no P0/P1 findings; finance/security review clean |

The database behavior fixture covers balanced posting, duplicate receipt/intent prevention, source uniqueness, cashier/approver segregation, scope, agreement classification, shareholder role, formal registration, active safe linkage, controlled-account composition, immutable provenance and reversal linkage. It executes inside a rolled-back transaction.

Local PostgreSQL execution was unavailable because the Docker daemon was not running. The branch CI gate provisions PostgreSQL 17 and applies the migration, verification SQL and rolled-back behavior fixture after push. Recovery is forward-only remediation or an approved database restore; no destructive down migration is supplied.

The independent database review retained one P2 operational limitation: opposing parent/child lock order can make PostgreSQL abort one concurrent transaction. Integrity remains atomic; a future database adapter must translate the transient error and apply bounded retry.

**Validation status:** `LOCAL_CHECKS_PASS_REMOTE_POSTGRESQL_GATE_PENDING_PUSH`

## Gates that remain closed

Operational approval/posting remains blocked until the Finance Manager confirms the applicable legal entity accounting currency, CoA, periods, evidence, opening/activation, authorization, correction and reporting policies. AFN/cross-currency behavior also requires approved rate, precision, rounding and FX accounting rules. Missing configuration must return a typed failure.

Company-wide statements, opening-balance import, real customer/shareholder/safe data, bank functionality, Saraf execution, production deployment, merging to `main` and the next financial slice all require separate authorization.

## Next review decision

At the end of E0, review the exact integrated SHA, shared contract, migrations, tests, independent security/Finance review and unresolved policy list. Only that review can authorize contract-dependent domain implementation or an E1/E2 sandbox transaction. E3 production activation remains a separate future decision.
