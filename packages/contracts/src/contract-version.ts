/**
 * Shared Stage 1 contract revisions.
 *
 * `stage1-e0-v1` (`8fb471475a76587b36414dfa3ab3f8dfc0cb0124`) is the frozen E0 coordination
 * contract. `stage1-e0-v2` is an additive revision raised during E1 to resolve findings F-1, F-4
 * and F-8 of `docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md`.
 *
 * Additive means: every v1 type still exists and still compiles. Two fields became optional and are
 * marked `@deprecated` rather than removed, and no existing field changed meaning. Nothing in v2
 * decides an open accounting policy; where policy is unresolved v2 adds an explicit, fail-closed
 * representation of the fact that it is unresolved.
 */
export const STAGE_ONE_CONTRACT_VERSION = "stage1-e0-v2" as const;
export type StageOneContractVersion = typeof STAGE_ONE_CONTRACT_VERSION;

/** What `stage1-e0-v2` adds, for the coordination record. */
export const STAGE_ONE_V2_ADDITIONS: readonly string[] = [
  "capital-status.ts: CanonicalCapitalAgreementStatus, CapitalAgreementFundingPolicy, checkAgreementMayFund (F-1)",
  "CapitalAgreementSummary.canonicalStatus; CapitalAgreementSummary.status deprecated (F-1)",
  "CapitalInstallmentEligibility.canonicalAgreementStatus; .agreementStatus deprecated (F-1)",
  "CapitalInstallmentEligibility.remainingEligibleAmount, .partialInstallmentsAllowed (F-4)",
  "ServerActorContext.costCenterIds (F-8), .sessionId, .expiresAt (sandbox authentication)",
  "sandbox.ts: SandboxAuthorization, SandboxPostingGate (F-3)"
];

/**
 * `stage1-e1-treasury-v1`, additive on top of `stage1-e0-v2`. Raised by Claude for the Treasury
 * domain and listed here for Codex's review; nothing in it changes a Finance type.
 */
export const STAGE_ONE_TREASURY_ADDITIONS: readonly string[] = [
  "treasury.ts: TreasuryPermission, TREASURY_PERMISSIONS, CashLocationSummary, TreasuryReceiptRecord, TreasuryReceiptStatus, TreasuryFinanceHandoff",
  "ServerActorContext.treasuryPermissions (separate from Finance permissions)"
];
