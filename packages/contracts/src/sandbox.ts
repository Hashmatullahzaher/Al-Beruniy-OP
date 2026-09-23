import type { LegalEntityId, UserAccountId } from "./ids.ts";
import type { SupportedCurrency } from "./money.ts";

/**
 * Persisted synthetic-only authorization - finding F-3.
 *
 * `stage1-e0-v1` expressed the gate as `FinancePolicyGate`, an object the *caller* supplied. A
 * caller could therefore assert "this is a synthetic test environment" against any database. The
 * authorization below is a row in the database being written to, so the database itself decides,
 * and a database with no such row cannot be posted to at all.
 *
 * Nothing here is a default. There is no permissive fallback and no value that means "assume
 * sandbox": absence is refusal.
 */
export interface SandboxAuthorization {
  /** Always the single authorized row; the table permits no second one. */
  readonly singleton: true;
  readonly environment: "development" | "test";
  readonly configurationState: "SYNTHETIC_TEST_ONLY";
  readonly policyVersionId: string;
  /** Must be false. A true value is rejected by a database CHECK, not by application code. */
  readonly realPostingEnabled: false;
  /** Free-text marker the deploying operator must match at session level; never defaulted. */
  readonly runtimeMarker: string;
  readonly authorizedByUserAccountId: UserAccountId;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

/** Legal entities inside the authorized sandbox. An entity not listed here cannot be posted to. */
export interface SandboxLegalEntityScope {
  readonly legalEntityId: LegalEntityId;
  readonly baseCurrency: SupportedCurrency;
  readonly authorizedAt: string;
}

/**
 * The gate as the *server* resolved it, from the database and process configuration. It is produced
 * by `@abos/sandbox-auth`, never parsed from a request body.
 */
export interface SandboxPostingGate {
  readonly authorization: SandboxAuthorization;
  readonly scope: SandboxLegalEntityScope;
  readonly resolvedAt: string;
  /**
   * HMAC over the resolved fields, keyed by the process signing secret.
   *
   * TypeScript cannot stop a caller from constructing an object of this shape, so the gate carries
   * a witness that it came from `SandboxAuthenticator.resolveGate`. A caller without the secret
   * cannot produce a valid one, and `FinancePostingService` verifies it before posting.
   *
   * This is defence in depth. The authoritative refusal is the database trigger installed by
   * migration 0002, which does not depend on any in-process value.
   */
  readonly signature: string;
}

/** Canonical serialisation the signature is computed over. Shared so both sides agree exactly. */
export function sandboxGateFingerprint(
  gate: Omit<SandboxPostingGate, "signature">
): string {
  return [
    gate.authorization.environment,
    gate.authorization.configurationState,
    gate.authorization.policyVersionId,
    String(gate.authorization.realPostingEnabled),
    gate.authorization.expiresAt,
    gate.scope.legalEntityId,
    gate.scope.baseCurrency,
    gate.resolvedAt
  ].join("|");
}
