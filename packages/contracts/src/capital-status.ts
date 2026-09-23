import type { StageOneErrorCode } from "./api.ts";
import type { CapitalAgreementStatus } from "./shareholder-capital.ts";

/**
 * Canonical capital-agreement status vocabulary — contract revision `stage1-e0-v2`.
 *
 * Finding F-1 of `docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md`: `stage1-e0-v1` declared
 * `CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED"` while
 * `abos.capital_agreements.status` stores `'DRAFT' | 'PENDING_EVIDENCE' | 'ELIGIBLE' | 'SUSPENDED' |
 * 'CLOSED'`. `APPROVED` could not be persisted and the two persisted-only values could not be
 * expressed, so the Finance kernel asserted a status no row could hold.
 *
 * The canonical vocabulary is the persisted one. That is a *representation* decision only: no name
 * acquires a meaning it did not already have, and `APPROVED` is not re-spelled as `ELIGIBLE`.
 *
 * Whether a given canonical status *permits funding an installment* is a business-policy question
 * that remains open, so it is never inferred from the name. It is answered only by a recorded
 * `CapitalAgreementFundingPolicy`, and in the absence of one every status is unfundable — see
 * `assertAgreementMayFund`.
 */
export type CanonicalCapitalAgreementStatus =
  | "DRAFT"
  | "PENDING_EVIDENCE"
  | "ELIGIBLE"
  | "SUSPENDED"
  | "CLOSED";

export const CANONICAL_CAPITAL_AGREEMENT_STATUSES: readonly CanonicalCapitalAgreementStatus[] = [
  "DRAFT",
  "PENDING_EVIDENCE",
  "ELIGIBLE",
  "SUSPENDED",
  "CLOSED"
];

/**
 * Statuses that can never fund an installment whatever policy is recorded.
 *
 * These are structural, not policy: a draft agreement is not yet an agreement, and a suspended or
 * closed one has been withdrawn from use. A funding policy naming one of them is rejected rather
 * than honoured.
 */
export const STRUCTURALLY_UNFUNDABLE_STATUSES: readonly CanonicalCapitalAgreementStatus[] = [
  "DRAFT",
  "SUSPENDED",
  "CLOSED"
];

/**
 * Who decided which canonical statuses may fund an installment.
 *
 * `SANDBOX_SYNTHETIC` exists so the E1 sandbox can run end to end without anyone pretending the
 * client's Finance function has approved anything. A sandbox decision is refused whenever the
 * persisted policy gate is not itself synthetic-test-only.
 */
export type FundingDecisionAuthority = "SANDBOX_SYNTHETIC" | "OWNER_PROVISIONAL" | "CLIENT_FINANCE";

export interface CapitalAgreementFundingPolicy {
  readonly vocabularyVersion: "stage1-e0-v2";
  /** A durable artefact recording the decision: an ADR, an issue comment, a signed approval. */
  readonly decisionReference: string;
  readonly decidedBy: FundingDecisionAuthority;
  readonly fundableStatuses: readonly CanonicalCapitalAgreementStatus[];
  readonly decidedAt: string;
}

export interface FundingPolicyViolation {
  readonly code: Extract<StageOneErrorCode, "POLICY_CONFIGURATION_PENDING" | "CAPITAL_AGREEMENT_REQUIRED">;
  readonly message: string;
}

/**
 * Fails closed. Returns a violation rather than throwing so each package can raise its own domain
 * error type; callers must treat `undefined` as "permitted" and anything else as a refusal.
 */
export function checkAgreementMayFund(
  status: CanonicalCapitalAgreementStatus,
  policy: CapitalAgreementFundingPolicy | undefined
): FundingPolicyViolation | undefined {
  if (policy === undefined) {
    return {
      code: "POLICY_CONFIGURATION_PENDING",
      message:
        "No capital-agreement funding policy is recorded. Finance review F-1 requires the fundable " +
        "status to be decided and recorded before any agreement can fund an installment."
    };
  }
  if (policy.vocabularyVersion !== "stage1-e0-v2") {
    return {
      code: "POLICY_CONFIGURATION_PENDING",
      message: `Funding policy targets vocabulary ${policy.vocabularyVersion}, not stage1-e0-v2`
    };
  }
  if (policy.decisionReference.trim().length === 0) {
    return {
      code: "POLICY_CONFIGURATION_PENDING",
      message: "A funding policy must cite a durable decision reference"
    };
  }
  if (policy.fundableStatuses.length === 0) {
    return {
      code: "POLICY_CONFIGURATION_PENDING",
      message: "A funding policy must name at least one fundable status"
    };
  }
  for (const candidate of policy.fundableStatuses) {
    if (STRUCTURALLY_UNFUNDABLE_STATUSES.includes(candidate)) {
      return {
        code: "POLICY_CONFIGURATION_PENDING",
        message: `Funding policy ${policy.decisionReference} names ${candidate}, which can never fund an installment`
      };
    }
  }
  if (!policy.fundableStatuses.includes(status)) {
    return {
      code: "CAPITAL_AGREEMENT_REQUIRED",
      message: `Capital agreement status ${status} is not fundable under decision ${policy.decisionReference}`
    };
  }
  return undefined;
}

/**
 * Bridge for `stage1-e0-v1` consumers that still hold a `CapitalAgreementStatus`.
 *
 * Only the three identically-named values convert, because those assert nothing. `APPROVED` has no
 * canonical equivalent and never gains one by inference: the v1 vocabulary is deprecated, and a
 * caller holding `APPROVED` must be migrated to the canonical vocabulary rather than translated.
 */
export function canonicalFromLegacyStatus(
  legacy: CapitalAgreementStatus
): CanonicalCapitalAgreementStatus | undefined {
  return legacy === "APPROVED" ? undefined : legacy;
}
