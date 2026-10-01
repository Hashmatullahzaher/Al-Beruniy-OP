/**
 * Shareholder master data and DRAFT capital agreement setup (migration 0031). The database derives
 * actor and legal entity from the session; these shapes carry business fields only. Amounts are
 * plain decimal strings and are never summed across currencies.
 */

export const SHAREHOLDER_SETUP_PERMISSION = "shareholder.setup.manage";

/** Why no capital can be received on an agreement yet. */
export type ShareholderSetupBlocker =
  | "AGREEMENT_DRAFT"
  | "AGREEMENT_EVIDENCE_MISSING"
  | "REGISTRATION_NOT_VERIFIED"
  | "NO_FUNDING_DECISION"
  | "RECEIPT_PATH_NOT_OPERATIONAL";

export interface ShareholderSetupShareholder {
  readonly id: string;
  readonly businessPartyId: string;
  readonly name: string;
  readonly reference: string | null;
  readonly status: string;
  readonly since: string | null;
  readonly createdAt: string;
  /** False once the shareholder has posted capital: corrections then need a controlled process. */
  readonly correctable: boolean;
  readonly agreementCount: number;
}

export interface ShareholderSetupInstallment {
  readonly id: string;
  readonly sequence: number;
  readonly amount: string;
  readonly currency: string;
  readonly dueOn: string | null;
  readonly status: string;
  readonly editable: boolean;
}

export interface ShareholderSetupDocument {
  readonly id: string;
  readonly version: number;
  readonly reference: string;
  readonly documentDate: string;
  readonly sha256: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface ShareholderSetupAgreement {
  readonly id: string;
  readonly shareholderProfileId: string;
  readonly shareholderName: string;
  readonly reference: string;
  readonly kind: string;
  readonly currency: string;
  readonly committed: string;
  /** Non-cancelled installments; never more than committed. */
  readonly planned: string;
  /** Open capital requests, not yet received. */
  readonly requested: string;
  /** Genuinely posted, non-reversed capital only. */
  readonly received: string;
  readonly remaining: string;
  readonly effectiveOn: string;
  readonly status: string;
  readonly partialAllowed: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly editable: boolean;
  readonly installments: readonly ShareholderSetupInstallment[];
  readonly documents: readonly ShareholderSetupDocument[];
  readonly registration: "VERIFIED" | "PENDING" | "NONE";
  readonly requestBlockers: readonly ShareholderSetupBlocker[];
}

export interface ShareholderSetupWorkspace {
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null } | null;
  readonly permissions: { readonly canManage: boolean; readonly canCreateRequests: boolean };
  readonly today: string;
  readonly receiptPathOperational: boolean;
  /** No policy row means REQUIRED; the owner-approved Al-Beruniy policy is OPTIONAL. */
  readonly agreementDocumentRequirement: "OPTIONAL" | "REQUIRED";
  readonly currencies: readonly string[];
  readonly shareholders: readonly ShareholderSetupShareholder[];
  readonly agreements: readonly ShareholderSetupAgreement[];
  readonly totalsByCurrency: readonly { readonly currency: string; readonly committed: string; readonly received: string; readonly remaining: string }[];
}

export interface ShareholderSetupCreateShareholder {
  readonly displayName: string;
  readonly externalReference: string | null;
  readonly shareholderSince: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ShareholderSetupCorrectShareholder {
  readonly shareholderProfileId: string;
  readonly displayName: string;
  readonly externalReference: string | null;
}

export interface ShareholderSetupCreateAgreement {
  readonly shareholderProfileId: string;
  readonly agreementReference: string;
  readonly committedAmount: string;
  readonly currencyCode: string;
  readonly effectiveOn: string;
  readonly partialInstallmentsAllowed: boolean;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ShareholderSetupUpdateAgreement {
  readonly capitalAgreementId: string;
  readonly agreementReference: string;
  readonly committedAmount: string;
  readonly currencyCode: string;
  readonly effectiveOn: string;
  readonly partialInstallmentsAllowed: boolean;
}

export interface ShareholderSetupAddInstallment {
  readonly capitalAgreementId: string;
  readonly expectedAmount: string;
  readonly dueOn: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ShareholderSetupUpdateInstallment {
  readonly capitalInstallmentId: string;
  readonly expectedAmount: string;
  readonly dueOn: string | null;
}

export interface ShareholderSetupCancelInstallment {
  readonly capitalInstallmentId: string;
  readonly reason: string;
}

export interface ShareholderSetupRecordAgreementDocument {
  readonly capitalAgreementId: string;
  readonly documentReference: string;
  readonly documentDate: string;
  readonly sha256: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/** One setup command, as the API accepts it. */
export type ShareholderSetupCommand =
  | ({ readonly action: "create-shareholder" } & ShareholderSetupCreateShareholder)
  | ({ readonly action: "correct-shareholder" } & ShareholderSetupCorrectShareholder)
  | ({ readonly action: "create-agreement" } & ShareholderSetupCreateAgreement)
  | ({ readonly action: "update-agreement" } & ShareholderSetupUpdateAgreement)
  | ({ readonly action: "add-installment" } & ShareholderSetupAddInstallment)
  | ({ readonly action: "update-installment" } & ShareholderSetupUpdateInstallment)
  | ({ readonly action: "cancel-installment" } & ShareholderSetupCancelInstallment)
  | ({ readonly action: "record-agreement-document" } & ShareholderSetupRecordAgreementDocument);

export type ShareholderSetupAction = ShareholderSetupCommand["action"];

export interface ShareholderSetupResult {
  readonly replayed?: boolean;
  readonly changed?: boolean;
  readonly [key: string]: unknown;
}
