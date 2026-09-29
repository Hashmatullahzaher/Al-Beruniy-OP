import { z } from "zod";

import { supportedCurrencySchema, type SupportedCurrency } from "./money.ts";
import { opaqueUuidSchema } from "./runtime-schemas.ts";

export const OPERATIONAL_TREASURY_ACCOUNT_TYPES = [
  "SAFE",
  "CASH_BOX",
  "PETTY_CASH",
  "BANK",
  "SARAF",
  "OTHER"
] as const;

export type OperationalTreasuryAccountType = (typeof OPERATIONAL_TREASURY_ACCOUNT_TYPES)[number];
export type OperationalConfigurationStatus = "ACTIVE" | "INACTIVE";

const configurationStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
const optionalUuidSchema = opaqueUuidSchema.nullish();
const optionalTextSchema = z.string().trim().min(1).max(120).nullish();

/**
 * Exact payload accepted by the protected Treasury-account configuration entry point.
 * Legal entity and actor identifiers are deliberately absent: PostgreSQL derives both from the
 * live session. A caller that adds either field is rejected by the strict schema.
 */
export const operationalTreasuryAccountUpsertSchema = z.object({
  id: opaqueUuidSchema.optional(),
  nameEn: z.string().trim().min(2).max(120),
  nameFa: z.string().trim().min(1).max(120).nullish(),
  accountType: z.enum(OPERATIONAL_TREASURY_ACCOUNT_TYPES),
  currencyCode: supportedCurrencySchema,
  ledgerAccountId: opaqueUuidSchema,
  sarafBusinessPartyId: optionalUuidSchema,
  externalReference: optionalTextSchema,
  status: configurationStatusSchema,
  expectedVersion: z.number().int().min(0)
}).strict();

export type OperationalTreasuryAccountUpsert = z.infer<typeof operationalTreasuryAccountUpsertSchema>;

/** The category code is immutable after creation and identifies the category in reports. */
export const operationalExpenseCategoryUpsertSchema = z.object({
  id: opaqueUuidSchema.optional(),
  categoryCode: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  nameEn: z.string().trim().min(2).max(120),
  nameFa: z.string().trim().min(1).max(120).nullish(),
  ledgerAccountId: opaqueUuidSchema,
  status: configurationStatusSchema,
  expectedVersion: z.number().int().min(0)
}).strict();

export type OperationalExpenseCategoryUpsert = z.infer<typeof operationalExpenseCategoryUpsertSchema>;

export const operationalPeriodOpenSchema = z.object({
  periodId: opaqueUuidSchema,
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(5).max(500)
}).strict();

export type OperationalPeriodOpen = z.infer<typeof operationalPeriodOpenSchema>;

export interface OperationalTreasuryAccountView {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: OperationalTreasuryAccountType;
  readonly currencyCode: SupportedCurrency;
  readonly ledgerAccountId: string;
  readonly ledgerAccountCode: string;
  readonly ledgerAccountName: string;
  readonly sarafBusinessPartyId: string | null;
  readonly sarafName: string | null;
  readonly externalReference: string | null;
  readonly status: OperationalConfigurationStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface OperationalExpenseCategoryView {
  readonly id: string;
  readonly categoryCode: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly ledgerAccountId: string;
  readonly ledgerAccountCode: string;
  readonly ledgerAccountName: string;
  readonly status: OperationalConfigurationStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface OperationalAccountingPeriodView {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: "PENDING" | "OPEN" | "SOFT_CLOSED" | "CLOSED";
  readonly version: number;
  readonly openedAt: string | null;
  readonly openedBy: string | null;
}

export interface OperationalFinanceConfigurationWorkspace {
  readonly legalEntity: {
    readonly id: string;
    readonly name: string;
    readonly baseCurrency: SupportedCurrency | null;
  };
  readonly permissions: {
    readonly canManageTreasuryAccounts: boolean;
    readonly canManageExpenseCategories: boolean;
    readonly canManagePeriods: boolean;
  };
  readonly treasuryAccounts: readonly OperationalTreasuryAccountView[];
  readonly expenseCategories: readonly OperationalExpenseCategoryView[];
  readonly periods: readonly OperationalAccountingPeriodView[];
  readonly options: {
    readonly treasuryLedgerAccounts: readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly currencyCode: SupportedCurrency;
      readonly controlType: "CASH" | "SARAF";
    }[];
    readonly expenseLedgerAccounts: readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly currencyCode: SupportedCurrency;
    }[];
    readonly sarafs: readonly { readonly id: string; readonly name: string }[];
  };
}
