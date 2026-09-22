import type { CapitalAgreementStatus } from "@abos/contracts";
import { ShareholderDomainError } from "./errors.ts";

/**
 * PROVISIONAL — pending Codex's ruling on finding F-1 of
 * `docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md`.
 *
 * The frozen contract (`stage1-e0-v1`) declares
 *   CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED"
 * while `abos.capital_agreements.status` stores
 *   'DRAFT' | 'PENDING_EVIDENCE' | 'ELIGIBLE' | 'SUSPENDED' | 'CLOSED'.
 *
 * `APPROVED` cannot be persisted and `PENDING_EVIDENCE` / `ELIGIBLE` cannot be expressed in the
 * contract, so no adapter can round-trip an agreement today. Every dependency the shareholder domain
 * has on that divergence is confined to this file: when the ruling lands, this is the only edit.
 */
export type PersistedAgreementStatus =
  | "DRAFT"
  | "PENDING_EVIDENCE"
  | "ELIGIBLE"
  | "SUSPENDED"
  | "CLOSED";

/** The single persisted status that means "this agreement may fund an installment". */
export const PERSISTED_FUNDABLE_STATUS: PersistedAgreementStatus = "ELIGIBLE";

/** The single contract status the Finance kernel accepts today (`posting-service.ts`). */
export const CONTRACT_FUNDABLE_STATUS: CapitalAgreementStatus = "APPROVED";

/** Persisted → contract. Throws rather than guessing for the two statuses with no contract term. */
export function toContractAgreementStatus(
  persisted: PersistedAgreementStatus
): CapitalAgreementStatus {
  switch (persisted) {
    case "ELIGIBLE":
      return CONTRACT_FUNDABLE_STATUS;
    case "DRAFT":
      return "DRAFT";
    case "SUSPENDED":
      return "SUSPENDED";
    case "CLOSED":
      return "CLOSED";
    case "PENDING_EVIDENCE":
      throw new ShareholderDomainError(
        "POLICY_CONFIGURATION_PENDING",
        "Persisted status PENDING_EVIDENCE has no stage1-e0-v1 contract term (Finance review F-1)"
      );
    default: {
      const exhaustive: never = persisted;
      throw new ShareholderDomainError(
        "POLICY_CONFIGURATION_PENDING",
        `Unknown persisted agreement status ${String(exhaustive)}`
      );
    }
  }
}

/** Contract → persisted, for adapters writing rows. */
export function toPersistedAgreementStatus(
  status: CapitalAgreementStatus
): PersistedAgreementStatus {
  return status === "APPROVED" ? PERSISTED_FUNDABLE_STATUS : status;
}
