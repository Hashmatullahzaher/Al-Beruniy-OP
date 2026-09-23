import { checkAgreementMayFund } from "@abos/contracts";
import type {
  CanonicalCapitalAgreementStatus,
  CapitalAgreementFundingPolicy,
  CapitalAgreementStatus
} from "@abos/contracts";
import { ShareholderDomainError } from "./errors.ts";

/**
 * Finding F-1: how the divergence was resolved, and what is still open.
 *
 * The divergence was that the frozen contract (`stage1-e0-v1`) declared
 *   CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED"
 * while `abos.capital_agreements.status` stores
 *   'DRAFT' | 'PENDING_EVIDENCE' | 'ELIGIBLE' | 'SUSPENDED' | 'CLOSED'.
 *
 * Two questions were tangled together, and separating them is the resolution:
 *
 *  1. *Which vocabulary is canonical?* A representation question with no accounting content.
 *     Answered in `stage1-e0-v2`: the persisted vocabulary. No name gains a meaning it did not
 *     already have, and nothing is renamed. `APPROVED` is deprecated rather than re-spelled.
 *
 *  2. *Which status permits funding an installment?* A business-policy question, still open. It is
 *     answered only by a recorded `CapitalAgreementFundingPolicy`, persisted per legal entity in
 *     `abos.capital_agreement_funding_policies`. With no decision recorded, nothing is fundable.
 *
 * So the mapping that the owner refused - `ELIGIBLE` silently meaning `APPROVED` - does not exist
 * anywhere. It was not replaced by a different silent mapping; the question it was answering is now
 * asked explicitly and fails closed until someone answers it.
 */
export type PersistedAgreementStatus = CanonicalCapitalAgreementStatus;

/** The canonical vocabulary is the persisted one, so persisted values need no translation. */
export const CANONICAL_STATUS_VOCABULARY = "stage1-e0-v2" as const;

/**
 * True while the *business* half of F-1 is open: no client-approved funding decision exists.
 *
 * A sandbox decision (`decidedBy: "SANDBOX_SYNTHETIC"`) lets E1 run end to end without anyone
 * claiming the client's Finance function has approved anything.
 */
export function isFundingDecisionOutstanding(
  policy: CapitalAgreementFundingPolicy | undefined
): boolean {
  return policy === undefined || policy.decidedBy !== "CLIENT_FINANCE";
}

/**
 * Whether an agreement may fund an installment, as a throwing assertion in this domain's error type.
 * Delegates to the shared contract predicate so Finance and Shareholder cannot drift apart.
 */
export function assertAgreementMayFund(
  status: CanonicalCapitalAgreementStatus,
  policy: CapitalAgreementFundingPolicy | undefined
): void {
  const violation = checkAgreementMayFund(status, policy);
  if (violation !== undefined) {
    throw new ShareholderDomainError(violation.code, violation.message);
  }
}

/**
 * Bridge for any remaining `stage1-e0-v1` consumer.
 *
 * Only the three identically-named values convert. `APPROVED` still throws, because giving it a
 * canonical equivalent would be exactly the policy-semantic mapping that must not be made
 * silently. A v1 consumer holding `APPROVED` must migrate to the canonical vocabulary.
 */
export function toCanonicalAgreementStatus(
  legacy: CapitalAgreementStatus
): CanonicalCapitalAgreementStatus {
  if (legacy === "APPROVED") {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      "The stage1-e0-v1 status APPROVED has no canonical equivalent and is never inferred. " +
        "Migrate the caller to CanonicalCapitalAgreementStatus and a recorded funding decision."
    );
  }
  return legacy;
}

/** Canonical to v1, for a consumer that cannot yet be migrated. Same refusal in reverse. */
export function toLegacyAgreementStatus(
  canonical: CanonicalCapitalAgreementStatus
): CapitalAgreementStatus {
  if (canonical === "PENDING_EVIDENCE" || canonical === "ELIGIBLE") {
    throw new ShareholderDomainError(
      "POLICY_CONFIGURATION_PENDING",
      `The canonical status ${canonical} has no stage1-e0-v1 equivalent. Expressing it as APPROVED ` +
        "would assert that the business approval requirement is met, which is not decided here."
    );
  }
  return canonical;
}
