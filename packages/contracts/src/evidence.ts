import type { DocumentId, EvidenceReferenceId } from "./ids.ts";

export type EvidenceKind =
  | "CAPITAL_AGREEMENT"
  | "FORMAL_REGISTRATION"
  | "PHYSICAL_CASH_COUNT"
  | "CASH_RECEIPT"
  | "OPENING_RECONCILIATION"
  | "FINANCE_APPROVAL"
  | "REVERSAL_REASON";

export interface EvidenceReference {
  readonly id: EvidenceReferenceId;
  readonly documentId: DocumentId;
  readonly kind: EvidenceKind;
  readonly version: number;
  readonly sha256: string;
  readonly completedAt: string;
}

export interface BusinessDates {
  readonly businessEventAt: string;
  readonly evidenceCompletedAt: string;
  readonly accountingEffectiveDate: string;
  readonly approvedAt?: string;
  readonly postedAt?: string;
}
