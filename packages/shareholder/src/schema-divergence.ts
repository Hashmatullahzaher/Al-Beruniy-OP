import type { CapitalAgreementStatus } from "@abos/contracts";
import { ShareholderDomainError } from "./errors.ts";

/**
 * UNRESOLVED — finding F-1 of `docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md`.
 *
 * The frozen contract (`stage1-e0-v1`) declares
 *   CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED"
 * while `abos.capital_agreements.status` stores
 *   'DRAFT' | 'PENDING_EVIDENCE' | 'ELIGIBLE' | 'SUSPENDED' | 'CLOSED'.
 *
 * `APPROVED` cannot be persisted; `PENDING_EVIDENCE` and `ELIGIBLE` cannot be expressed in the
 * contract. Whether `ELIGIBLE` *means* `APPROVED` is a policy-semantic question — it asserts that a
 * row marked eligible has cleared whatever approval the business requires — and the owner has
 * directed (issue #3, 2026-09-22) that it must not be resolved silently.
 *
 * Therefore this module **fails closed by default**. The mapping is applied only when the caller
 * supplies a `JointStatusDecision` recording an agreed, referenced decision by Codex and Claude.
 * Until that exists no adapter can produce a fundable agreement from persisted data, so the
 * shareholder domain refuses to create capital receipt intents against real rows. That is the
 * intended behaviour while E1 remains in progress.
 */
export type PersistedAgreementStatus =
  | "DRAFT"
  | "PENDING_EVIDENCE"
  | "ELIGIBLE"
  | "SUSPENDED"
  | "CLOSED";

/**
 * A recorded joint decision on the canonical status vocabulary.
 * `decisionReference` must point at a durable artefact — an ADR, a versioned contract bump, or the
 * coordination issue comment that records agreement. It is never defaulted.
 */
export interface JointStatusDecision {
  readonly decisionReference: string;
  /** The persisted status agreed to mean "this agreement may fund an installment". */
  readonly canonicalFundableStatus: PersistedAgreementStatus;
  /** The contract term agreed to be its equivalent. */
  readonly contractEquivalent: CapitalAgreementStatus;
}

/** True while F-1 is open. Remove it, and the guards below, when the decision lands. */
export const CANONICAL_STATUS_DECISION_PENDING = true;

/**
 * Statuses whose names are identical in both vocabularies. Mapping these asserts nothing about
 * policy, so they need no decision.
 */
const IDENTICAL: ReadonlySet<PersistedAgreementStatus> = new Set(["DRAFT", "SUSPENDED", "CLOSED"]);

/**
 * Persisted → contract.
 *
 * Without a `JointStatusDecision` this throws for `ELIGIBLE` and `PENDING_EVIDENCE`, because both
 * would require inventing a policy meaning. It never guesses.
 */
export function toContractAgreementStatus(
  persisted: PersistedAgreementStatus,
  decision?: JointStatusDecision
): CapitalAgreementStatus {
  if (IDENTICAL.has(persisted)) {
    return persisted as CapitalAgreementStatus;
  }

  if (decision === undefined) {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      `Persisted agreement status ${persisted} has no agreed stage1-e0-v1 equivalent. ` +
        "Finance review F-1 is open: Codex and Claude must jointly version the canonical status " +
        "vocabulary. Supply a JointStatusDecision once that decision is recorded."
    );
  }

  assertDecisionIsUsable(decision);

  if (persisted === decision.canonicalFundableStatus) {
    return decision.contractEquivalent;
  }

  throw new ShareholderDomainError(
    "POLICY_CONFIGURATION_PENDING",
    `Persisted agreement status ${persisted} is outside the recorded decision ` +
      `${decision.decisionReference}, which covers only ${decision.canonicalFundableStatus}`
  );
}

/** Contract → persisted, for adapters writing rows. Subject to the same decision requirement. */
export function toPersistedAgreementStatus(
  status: CapitalAgreementStatus,
  decision?: JointStatusDecision
): PersistedAgreementStatus {
  if (status !== "APPROVED") {
    return status as PersistedAgreementStatus;
  }
  if (decision === undefined) {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      "Contract status APPROVED has no persistable equivalent until Finance review F-1 is decided"
    );
  }
  assertDecisionIsUsable(decision);
  if (decision.contractEquivalent !== "APPROVED") {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      `Recorded decision ${decision.decisionReference} does not map APPROVED`
    );
  }
  return decision.canonicalFundableStatus;
}

function assertDecisionIsUsable(decision: JointStatusDecision): void {
  if (decision.decisionReference.trim().length === 0) {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      "A JointStatusDecision must cite a durable decision reference"
    );
  }
  if (IDENTICAL.has(decision.canonicalFundableStatus)) {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      `${decision.canonicalFundableStatus} is not a fundable status`
    );
  }
}
