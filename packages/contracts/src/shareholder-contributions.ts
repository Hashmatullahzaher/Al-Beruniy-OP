/**
 * Shareholder contributions (migration 0035). DECLARATION ONLY: nothing here receives cash, values an
 * asset, classifies credit or posts to Treasury or the General Ledger. A shareholder without
 * contribution rows simply has none yet. Amounts are plain decimal strings and are never summed
 * across types or currencies; estimated asset values are reported separately from CASH and CREDIT.
 */

export type ContributionType = "CASH" | "IN_KIND" | "CREDIT";
export type ContributionAssetCategory = "LAND_PROPERTY" | "EQUIPMENT_MACHINERY" | "GOODS_MATERIALS" | "OTHER";
export type ContributionRecordStatus = "DRAFT" | "DECLARED" | "APPROVED" | "CANCELLED" | "POSTED";
export type ContributionReceiptStatus = "NOT_APPLICABLE" | "NOT_RECEIVED" | "PARTIALLY_RECEIVED" | "RECEIVED";
export type ContributionValuationStatus = "NOT_APPLICABLE" | "NOT_VALUED" | "VALUED" | "APPROVED";
export type CreditClassification = "UNCLASSIFIED" | "CAPITAL_RECEIVABLE" | "SHAREHOLDER_LOAN" | "OFFSET";

export const CONTRIBUTION_ASSET_CATEGORIES: readonly ContributionAssetCategory[] = [
  "LAND_PROPERTY", "EQUIPMENT_MACHINERY", "GOODS_MATERIALS", "OTHER"
];

export interface ShareholderContribution {
  readonly id: string;
  readonly type: ContributionType;
  readonly businessDate: string;
  readonly description: string | null;
  readonly reference: string | null;
  readonly recordStatus: ContributionRecordStatus;
  readonly receiptStatus: ContributionReceiptStatus;
  readonly valuationStatus: ContributionValuationStatus;
  /** CASH and CREDIT only. */
  readonly amount: string | null;
  readonly currency: string | null;
  /** IN_KIND only. The estimated value is information, never cash received. */
  readonly assetCategory: ContributionAssetCategory | null;
  readonly itemName: string | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly ownershipNote: string | null;
  readonly estimatedValue: string | null;
  readonly valuationCurrency: string | null;
  /** CREDIT only; UNCLASSIFIED until a later Finance step. */
  readonly creditClassification: CreditClassification | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly cancellationReason: string | null;
  readonly editable: boolean;
}

/** A capital agreement from the earlier cash workflow, shown as history; never a contribution row. */
export interface LegacyCashAgreement {
  readonly id: string;
  readonly reference: string;
  readonly kind: string;
  readonly committed: string;
  readonly currency: string;
  readonly status: string;
  readonly effectiveOn: string;
  readonly installmentCount: number;
  readonly planned: string;
}

export interface ShareholderWithContributions {
  readonly id: string;
  readonly businessPartyId: string;
  readonly name: string;
  readonly reference: string | null;
  readonly status: string;
  readonly since: string | null;
  readonly contributions: readonly ShareholderContribution[];
  /** CASH and CREDIT amounts per type and currency, excluding cancelled rows and legacy agreements. */
  readonly declaredTotals: readonly { readonly type: "CASH" | "CREDIT"; readonly currency: string; readonly amount: string }[];
  /** Informational asset estimates per valuation currency; never part of CASH or CREDIT. */
  readonly estimatedAssetTotals: readonly { readonly currency: string; readonly amount: string }[];
  readonly legacyCashAgreements: readonly LegacyCashAgreement[];
}

export interface ShareholderContributionsWorkspace {
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null } | null;
  readonly permissions: { readonly canManage: boolean };
  readonly today: string;
  readonly currencies: readonly string[];
  readonly shareholders: readonly ShareholderWithContributions[];
}

/** Type-specific fields. Fields of other types must be absent or empty. */
export interface ContributionFields {
  readonly businessDate: string;
  readonly description: string | null;
  readonly reference: string | null;
  readonly amount?: string | null;
  readonly currencyCode?: string | null;
  readonly assetCategory?: ContributionAssetCategory | null;
  readonly itemName?: string | null;
  readonly quantity?: string | null;
  readonly unit?: string | null;
  readonly ownershipNote?: string | null;
  readonly estimatedValue?: string | null;
  readonly valuationCurrencyCode?: string | null;
}

export interface ShareholderContributionCreate extends ContributionFields {
  readonly shareholderProfileId: string;
  readonly contributionType: ContributionType;
  /** true records it as DECLARED at once; false keeps a DRAFT. */
  readonly declare: boolean;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ShareholderContributionUpdate extends ContributionFields {
  readonly contributionId: string;
  readonly expectedVersion: number;
}

export interface ShareholderContributionDeclare {
  readonly contributionId: string;
  readonly expectedVersion: number;
}

export interface ShareholderContributionCancel {
  readonly contributionId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export type ShareholderContributionCommand =
  | ({ readonly action: "create-contribution" } & ShareholderContributionCreate)
  | ({ readonly action: "update-contribution" } & ShareholderContributionUpdate)
  | ({ readonly action: "declare-contribution" } & ShareholderContributionDeclare)
  | ({ readonly action: "cancel-contribution" } & ShareholderContributionCancel);
