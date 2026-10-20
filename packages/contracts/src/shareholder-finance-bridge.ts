import { z } from "zod";

import type { AccountingPeriodId, JournalId, LedgerAccountId, LegalEntityId, UserAccountId } from "./ids.ts";
import { moneySchema, type Money, type SupportedCurrency } from "./money.ts";
import { isoDateSchema, opaqueUuidSchema } from "./runtime-schemas.ts";

/**
 * Application contract for the reviewed Shareholders -> Finance bridge.
 *
 * A contribution is a declaration. Receipts, approvals and postings are separate immutable facts.
 * This contract intentionally has no database adapter: migration 0036 remains a proposal.
 */
export type CapitalReceiptState = "RECORDED" | "CANCELLED";
export type CapitalReceiptApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "NOT_REQUIRED";
export type CapitalReceiptPostingState = "NOT_POSTED" | "POSTED" | "REVERSED";

export interface CapitalContributionDeclaration {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly shareholderProfileId: string;
  readonly contributionType: "CASH" | "IN_KIND" | "CREDIT";
  /** Exact 0035 source lifecycle. Receipt/approval/posting states are held separately. */
  readonly recordStatus: "DRAFT" | "DECLARED" | "CANCELLED";
  readonly businessDate: string;
  readonly amount: Money | null;
  readonly documentVersion: number | null;
  /** Legacy agreements are displayed beside declarations but never copied into this collection. */
  readonly sourceModel: "CONTRIBUTION_0035";
}

export interface CapitalReceiptRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly contributionId: string;
  /** Immutable binding of declaration identity, shareholder, date, type and original amount. */
  readonly sourceFingerprint: string;
  readonly amount: Money;
  readonly receiptDate: string;
  readonly treasuryDestinationId: string;
  readonly paymentReference: string | null;
  readonly evidenceReferenceId: string | null;
  readonly receiptState: CapitalReceiptState;
  readonly approvalState: CapitalReceiptApprovalState;
  readonly postingState: CapitalReceiptPostingState;
  readonly recordedBy: UserAccountId;
  readonly recordedAt: string;
  readonly approvedBy: UserAccountId | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: UserAccountId | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly journalId: JournalId | null;
  readonly reversedByJournalId: JournalId | null;
  readonly version: number;
}

export interface CapitalReceiptPostingConfiguration {
  readonly legalEntityId: LegalEntityId;
  readonly baseCurrency: SupportedCurrency;
  readonly policyVersionId: string;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly periodStatus: "OPEN" | "CLOSED";
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  /** Resolved configuration identifiers. The bridge never invents account codes. */
  readonly receivingLedgerAccountId: LedgerAccountId | null;
  readonly paidInCapitalLedgerAccountId: LedgerAccountId | null;
  readonly treasuryDestinationId: string;
  /** Explicit isolated fixture policy. A declaration/document hash cannot establish this. */
  readonly paidInEquityRecognitionApproved: boolean;
  readonly receiptEvidenceRequired: boolean;
  /** False until a separately approved reversal policy exists. */
  readonly reversalPostingEnabled: boolean;
}

export interface CapitalReceiptPostingIntentRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly sourceType: "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT";
  readonly sourceReceiptId: string;
  readonly contributionId: string;
  readonly originalAmount: Money;
  readonly baseAmount: Money;
  readonly treasuryDestinationId: string;
  readonly debitLedgerAccountId: LedgerAccountId;
  readonly creditLedgerAccountId: LedgerAccountId;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly policyVersionId: string;
  readonly status: "APPROVED" | "POSTED" | "REVERSED";
}

export interface CapitalBridgeAuditEntry {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly contributionId: string;
  readonly receiptId: string;
  readonly actorUserAccountId: UserAccountId;
  readonly action:
    | "CAPITAL_RECEIPT_RECORDED"
    | "CAPITAL_RECEIPT_CANCELLED"
    | "CAPITAL_RECEIPT_APPROVED"
    | "CAPITAL_RECEIPT_REJECTED"
    | "CAPITAL_RECEIPT_POSTED"
    | "CAPITAL_RECEIPT_REVERSED";
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly details: Readonly<Record<string, string>>;
}

export interface CapitalContributionFinanceSummary {
  readonly contributionId: string;
  readonly declared: Money;
  readonly received: Money;
  readonly outstanding: Money;
  readonly posted: Money;
  readonly receiptCount: number;
  readonly approvalState: CapitalReceiptApprovalState | "NOT_RECEIVED";
  readonly postingState: CapitalReceiptPostingState;
}

/**
 * Production application contract for the future coordinated PostgreSQL bridge.
 *
 * These request schemas deliberately omit actor, legal-entity, permission, policy and account
 * mapping fields. The server obtains the session proof from its secure cookie and PostgreSQL must
 * resolve every authority/configuration fact again at execution time.
 */
export const shareholderCapitalReceiptRecordSchema = z.object({
  contributionId: opaqueUuidSchema,
  expectedContributionVersion: z.number().int().positive(),
  amount: moneySchema,
  receiptDate: isoDateSchema,
  treasuryDestinationId: opaqueUuidSchema,
  paymentReference: z.string().trim().min(1).max(120).nullable().optional(),
  evidenceReferenceId: opaqueUuidSchema.nullable().optional()
}).strict();

export const shareholderCapitalCustodyDecisionSchema = z.object({
  expectedReceiptVersion: z.number().int().positive(),
  decision: z.enum(["VERIFIED", "REJECTED"]),
  verificationKind: z.enum(["PHYSICAL_CASH_COUNT", "BANK_CONFIRMATION", "SARAF_CONFIRMATION", "CONTROLLED_EVIDENCE"]),
  evidenceReferenceId: opaqueUuidSchema,
  decisionReason: z.string().trim().min(3).max(500).nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.decision === "REJECTED" && !value.decisionReason) {
    context.addIssue({ code: "custom", path: ["decisionReason"], message: "A rejection reason is required." });
  }
});

export const shareholderCapitalPostingPrepareSchema = z.object({
  expectedReceiptVersion: z.number().int().positive(),
  accountingEffectiveDate: isoDateSchema
}).strict();

export const shareholderCapitalPostingDecisionSchema = z.object({
  expectedIntentVersion: z.number().int().positive(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  evidenceReferenceId: opaqueUuidSchema,
  decisionReason: z.string().trim().min(3).max(500)
}).strict();

export const shareholderCapitalPostingPostSchema = z.object({
  expectedIntentVersion: z.number().int().positive()
}).strict();

export const shareholderCapitalMappingConfigureSchema = z.object({
  ledgerAccountId: opaqueUuidSchema,
  evidenceReferenceId: opaqueUuidSchema,
  changeReason: z.string().trim().min(3).max(500)
}).strict();

export const SHAREHOLDER_CAPITAL_EVIDENCE_KINDS = [
  "CAPITAL_ACCOUNT_MAPPING", "CASH_RECEIPT", "PHYSICAL_CASH_COUNT", "BANK_CONFIRMATION",
  "SARAF_CONFIRMATION", "CONTROLLED_EVIDENCE", "FINANCE_APPROVAL"
] as const;

export type ShareholderCapitalEvidenceKind = (typeof SHAREHOLDER_CAPITAL_EVIDENCE_KINDS)[number];

export const shareholderCapitalEvidenceRegisterSchema = z.object({
  evidenceKind: z.enum(SHAREHOLDER_CAPITAL_EVIDENCE_KINDS),
  subjectId: opaqueUuidSchema.nullable(),
  documentReference: z.string().trim().min(1).max(200),
  sha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/)
}).strict();

export interface ShareholderCapitalEvidenceRegistrationResult {
  readonly evidenceReferenceId: string;
  readonly evidenceKind: ShareholderCapitalEvidenceKind;
  readonly documentReference: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface ShareholderCapitalConfiguration {
  readonly accounts: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly currency: SupportedCurrency;
  }[];
  readonly mapping: {
    readonly mappingVersionId: string;
    readonly version: number;
    readonly ledgerAccountId: string;
  } | null;
}

export type ShareholderCapitalReceiptRecordRequest = z.infer<typeof shareholderCapitalReceiptRecordSchema>;
export type ShareholderCapitalCustodyDecisionRequest = z.infer<typeof shareholderCapitalCustodyDecisionSchema>;
export type ShareholderCapitalPostingPrepareRequest = z.infer<typeof shareholderCapitalPostingPrepareSchema>;
export type ShareholderCapitalPostingDecisionRequest = z.infer<typeof shareholderCapitalPostingDecisionSchema>;
export type ShareholderCapitalPostingPostRequest = z.infer<typeof shareholderCapitalPostingPostSchema>;
export type ShareholderCapitalMappingConfigureRequest = z.infer<typeof shareholderCapitalMappingConfigureSchema>;
export type ShareholderCapitalEvidenceRegisterRequest = z.infer<typeof shareholderCapitalEvidenceRegisterSchema>;

export type ShareholderFinanceCapabilityState = "NOT_OPERATIONAL" | "SCHEMA_NOT_AVAILABLE" | "OPERATIONAL";

export interface ShareholderFinanceCapability {
  readonly approvalRequired?: boolean | null;
  readonly state: ShareholderFinanceCapabilityState;
  readonly schemaInstalled: boolean;
  readonly mutationAvailable: boolean;
  readonly reviewModeAvailable: boolean;
  readonly requiredSessionProvenance: "PASSWORD_OPERATIONAL";
  readonly reason: string;
  readonly permissions?: readonly string[];
  readonly policyVersion?: number | null;
  readonly mappingVersionId?: string | null;
  readonly treasuryDestinations?: readonly {
    readonly id: string;
    readonly name: string;
    readonly currency: SupportedCurrency;
  }[];
}

export type ShareholderFinanceOperation =
  | "RECORD_RECEIPT"
  | "VERIFY_CUSTODY"
  | "PREPARE_POSTING"
  | "DECIDE_POSTING"
  | "POST_RECEIPT"
  | "READ_TRACE";

export const SHAREHOLDER_FINANCE_PERMISSION_BY_OPERATION: Readonly<Record<ShareholderFinanceOperation, string>> = Object.freeze({
  RECORD_RECEIPT: "shareholder.capital-receipt.record",
  VERIFY_CUSTODY: "treasury.capital-receipt.verify",
  PREPARE_POSTING: "finance.capital-receipt.prepare",
  DECIDE_POSTING: "finance.capital-receipt.approve",
  POST_RECEIPT: "finance.capital-receipt.post",
  READ_TRACE: "shareholder.capital-receipt.read"
});

export type ShareholderCapitalCustodyState = "NOT_RECEIVED" | "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED";
export type ShareholderCapitalTraceStatus = "DECLARED" | "RECEIVED" | "VERIFIED" | "APPROVED" | "POSTED";

export interface ShareholderCapitalReceiptTrace {
  readonly approvalRequired?: boolean | null;
  readonly preparerUserAccountId?: string | null;
  readonly receiptId: string;
  readonly contributionId: string;
  readonly amount: Money;
  readonly receiptDate: string;
  readonly treasuryDestinationId: string;
  readonly treasuryDestinationName: string;
  readonly custodyState: ShareholderCapitalCustodyState;
  readonly approvalState: CapitalReceiptApprovalState;
  readonly postingState: CapitalReceiptPostingState;
  readonly postingIntentId: string | null;
  readonly receiptVersion: number;
  readonly postingIntentVersion: number | null;
  readonly journalId: JournalId | null;
  readonly paymentReference?: string | null;
  readonly evidenceReferenceId?: string | null;
  readonly recorderUserAccountId?: string | null;
  readonly recorderName?: string | null;
  readonly recordedAt?: string | null;
  readonly verifierName?: string | null;
  readonly verifiedAt?: string | null;
  readonly custodyReason?: string | null;
  readonly verificationKind?: Exclude<ShareholderCapitalEvidenceKind, "CAPITAL_ACCOUNT_MAPPING" | "CASH_RECEIPT" | "FINANCE_APPROVAL"> | null;
  readonly preparerName?: string | null;
  readonly preparedAt?: string | null;
  readonly accountingEffectiveDate?: string | null;
  readonly approverName?: string | null;
  readonly approverUserAccountId?: string | null;
  readonly approvedAt?: string | null;
  readonly approvalReason?: string | null;
  readonly policyVersion?: number | null;
  readonly mappingVersion?: number | null;
  readonly mappingVersionId?: string | null;
  readonly debitAccount?: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly creditAccount?: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly receiptEvidence?: { readonly reference: string; readonly sha256: string; readonly kind: ShareholderCapitalEvidenceKind } | null;
  readonly custodyEvidence?: { readonly reference: string; readonly sha256: string; readonly kind: ShareholderCapitalEvidenceKind } | null;
  readonly approvalEvidence?: { readonly reference: string; readonly sha256: string; readonly kind: ShareholderCapitalEvidenceKind } | null;
}

export interface ShareholderCapitalContributionTrace {
  readonly contributionId: string;
  readonly shareholderProfileId: string;
  readonly shareholderBusinessPartyId: string;
  readonly shareholderDisplayName: string;
  readonly declarationDate: string;
  readonly declaredAmount: Money;
  readonly receivedAmount: Money;
  readonly custodyVerifiedAmount: Money;
  readonly approvedAmount: Money;
  readonly postedAmount: Money;
  readonly outstandingAmount: Money;
  readonly status: ShareholderCapitalTraceStatus;
  readonly receipts: readonly ShareholderCapitalReceiptTrace[];
}

export interface ShareholderCapitalLegacyAgreementTrace {
  readonly agreementId: string;
  readonly shareholderProfileId: string;
  readonly shareholderDisplayName: string;
  readonly committedAmount: Money;
  readonly sourceModel: "LEGACY_CAPITAL_AGREEMENT";
  readonly includedInContributionTotals: false;
}

export interface ShareholderCapitalTraceReadModel {
  readonly capability: ShareholderFinanceCapability;
  readonly contribution: ShareholderCapitalContributionTrace;
  /** Legacy agreements remain separate and are never copied into contribution receipt totals. */
  readonly legacyAgreements: readonly ShareholderCapitalLegacyAgreementTrace[];
}

export type ShareholderCapitalBridgeEventType =
  | "SHAREHOLDER_CAPITAL_RECEIPT_RECORDED"
  | "SHAREHOLDER_CAPITAL_CUSTODY_VERIFIED"
  | "SHAREHOLDER_CAPITAL_CUSTODY_REJECTED"
  | "SHAREHOLDER_CAPITAL_POSTING_PREPARED"
  | "SHAREHOLDER_CAPITAL_POSTING_APPROVED"
  | "SHAREHOLDER_CAPITAL_POSTING_REJECTED"
  | "SHAREHOLDER_CAPITAL_RECEIPT_POSTED";

export interface ShareholderCapitalBridgeEventPayload {
  readonly contributionId: string;
  readonly receiptId: string;
  readonly postingIntentId: string | null;
  readonly journalId: JournalId | null;
  readonly fromState: string | null;
  readonly toState: string;
  readonly policyVersionId: string | null;
  readonly mappingVersionId: string | null;
  readonly evidenceReferenceId: string | null;
}

export interface ShareholderCapitalReceiptCommandResult {
  readonly receipt: ShareholderCapitalReceiptTrace;
  readonly replayed: boolean;
}

export interface ShareholderCapitalPostingCommandResult {
  readonly receiptId: string;
  readonly postingIntentId: string;
  readonly status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "POSTED";
  readonly version: number;
  readonly journalId: JournalId | null;
  readonly replayed: boolean;
}
