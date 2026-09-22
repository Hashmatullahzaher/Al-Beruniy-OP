# ADR-0001 — Stage 1 E0 Dependency Exception

**Status:** Accepted for E0 engineering scaffolding only
**Decision date:** 2026-09-22
**Coordination baseline:** `999a5335521fac5a9ac9b01b9e5d8261c47424d5`
**Approved Stage 0 reference:** `a4ff484d357d22ba60ab1efd1650022bde9ab43c`

## Context

The canonical build queue places database and API foundations before events, identity, workflow, master data and the Finance kernel. The E0 implementation order calls for a common vocabulary and fail-closed integration contracts before separate Shareholder, Treasury and Finance work proceeds.

Waiting for every downstream phase before defining contracts would prevent safe coordination. Treating E0 as permission to bypass those dependencies would compromise authorization, accounting and audit controls.

## Decision

Permit these activities under E0:

1. WP-0002 database/migration foundations for development and test environments, with no real company data.
2. WP-0003 API/service boundaries and shared typed contracts, including exact-decimal money, legal-entity scope, evidence, audit, idempotency and errors.
3. WP-0005 test and quality-harness work required to validate those foundations.
4. Non-operational Shareholder and Treasury draft contracts that consume the shared contract instead of introducing competing schemas or posting engines.
5. Finance journal validation, immutability, reversal and reconciliation **invariant/test kernels** that cannot perform operational posting while dependencies or policies are missing.

These packages may be `IN_PROGRESS`. This ADR does not make any package `DONE`, complete F0, or authorize F1/F2/F3 operational behavior.

## Boundaries

- The shared freeze is documented in `docs/03-architecture/STAGE_01_SHARED_SCHEMA_API_CONTRACT.md` and anchored to the reviewed `packages/contracts` SHA in the final handoff.
- Only Finance may own the future General Ledger posting service. Other domains produce source intent or verification records.
- Production identity, RBAC, segregation of duties, workflow, audit persistence, company/project scope, approved master data, CoA, periods, opening balances and financial policies remain hard gates.
- Persistence uses synthetic development/test data until separate data-import authorization exists.
- No endpoint may post, activate a real cash account, import opening balances, generate an official statement or imply a verified capital contribution under E0.
- The first slice contains no bank account or bank integration. Physical safe and Saraf contracts remain separate.
- USD and AFN are supported transaction-currency contract values. Base-currency activation and every FX policy remain approval-gated.
- Stage 0 UI and the holographic presentation are outside this exception and remain protected.

## Fail-closed consequence

If identity, permission, segregation of duties, approved policy, CoA, open period, evidence, active/reconciled cash-location account, idempotency or legal-entity/currency scope is absent, the application must refuse approval and posting. Test configuration may exercise invariants but cannot silently stand in for client policy.

## Exit criteria

The exception ends at E0 checkpoint review. Advancing to an integrated sandbox posting path requires a separate E1/E2 decision plus documented financial policies, completed prerequisites, reviewed migrations/contracts and negative-test evidence. Production activation remains the independent E3 gate.

## Consequences

This enables coordinated engineering without fragmenting schema ownership. It intentionally leaves operational Finance blocked and may require additive contract revisions after Finance Manager review. Breaking contract changes require a new version and cross-domain review; historical events and posted-record contracts may never be silently reinterpreted.
