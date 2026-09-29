import { z } from "zod";

import { decimalStringSchema, supportedCurrencySchema, type SupportedCurrency } from "./money.ts";
import { isoDateSchema, opaqueUuidSchema } from "./runtime-schemas.ts";

const nullableUuidSchema = opaqueUuidSchema.nullable();
const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => /[1-9]/.test(value),
  "Amount must be greater than zero"
);

/** Exact browser payload accepted by the operational-expense create boundary. */
export const operationalExpenseCreateSchema = z.object({
  treasuryAccountId: opaqueUuidSchema,
  expenseCategoryId: opaqueUuidSchema,
  payeeBusinessPartyId: nullableUuidSchema,
  projectId: nullableUuidSchema,
  departmentId: nullableUuidSchema,
  costCenterId: nullableUuidSchema,
  reference: z.string().trim().min(1).max(120),
  description: z.string().trim().min(3).max(500),
  note: z.string().trim().min(1).max(1000).nullable(),
  businessDate: isoDateSchema,
  originalAmount: positiveDecimalStringSchema,
  currencyCode: supportedCurrencySchema,
  exchangeRateId: nullableUuidSchema,
  correlationId: opaqueUuidSchema,
  idempotencyKey: z.string().trim().min(8).max(200)
}).strict();

export type OperationalExpenseCreate = z.infer<typeof operationalExpenseCreateSchema>;

/** Date range accepted by the read-only expense workspace. */
export const operationalExpenseWorkspaceQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema
}).strict().superRefine((value, context) => {
  const from = Date.parse(`${value.from}T00:00:00.000Z`);
  const to = Date.parse(`${value.to}T00:00:00.000Z`);
  const days = (to - from) / 86_400_000;
  if (to < from) {
    context.addIssue({ code: "custom", path: ["to"], message: "End date must not precede start date" });
  } else if (days > 366) {
    context.addIssue({ code: "custom", path: ["to"], message: "Date range cannot exceed 366 days" });
  }
});

export type OperationalExpenseWorkspaceQuery = z.infer<typeof operationalExpenseWorkspaceQuerySchema>;

/** Body accepted by the independent approval endpoint; the expense ID remains in the URL. */
export const operationalExpenseApproveBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().min(5).max(500)
}).strict();

export type OperationalExpenseApproveBody = z.infer<typeof operationalExpenseApproveBodySchema>;

export type OperationalExpenseStatus = "DRAFT" | "PENDING_APPROVAL" | "VALIDATED" | "POSTED";

export interface OperationalExpenseExchangeRateSnapshot {
  readonly id: string;
  readonly exchangeRateId: string;
  readonly rateDate: string;
  readonly rateSource: string;
  readonly unitCurrency: SupportedCurrency;
  readonly quoteCurrency: SupportedCurrency;
  readonly rate: string;
}

export interface OperationalExpenseApprovalView {
  readonly id: string;
  readonly decision: "APPROVED";
  readonly note: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
}

/** JSON produced by `abos.operational_expense_json`. */
export interface OperationalExpenseView {
  readonly id: string;
  readonly legalEntityId: string;
  readonly treasuryAccountId: string;
  readonly treasuryAccountNameEn: string;
  readonly treasuryAccountNameFa: string | null;
  readonly expenseCategoryId: string;
  readonly expenseCategoryCode: string;
  readonly expenseCategoryNameEn: string;
  readonly expenseCategoryNameFa: string | null;
  readonly payeeBusinessPartyId: string | null;
  readonly payeeName: string | null;
  readonly projectId: string | null;
  readonly departmentId: string | null;
  readonly costCenterId: string | null;
  readonly reference: string;
  readonly description: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly originalAmount: string;
  readonly originalCurrency: SupportedCurrency;
  readonly baseAmount: string | null;
  readonly baseCurrency: SupportedCurrency;
  readonly exchangeRateSnapshot: OperationalExpenseExchangeRateSnapshot | null;
  readonly workflowPolicyVersionId: string;
  readonly approvalRequired: boolean;
  readonly status: OperationalExpenseStatus;
  readonly version: number;
  readonly journalId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approval: OperationalExpenseApprovalView | null;
}

export interface OperationalExpenseMutationResult {
  readonly expense: OperationalExpenseView;
  readonly replayed: boolean;
}

export interface OperationalExpenseWorkspace {
  readonly legalEntityId: string;
  readonly from: string;
  readonly to: string;
  readonly permissions: {
    readonly canCreate: boolean;
    readonly canApprove: boolean;
  };
  readonly expenses: readonly OperationalExpenseView[];
  readonly totalsByOriginalCurrency: readonly {
    readonly currency: SupportedCurrency;
    readonly amount: string;
  }[];
  readonly baseTotal: {
    readonly currency: SupportedCurrency | null;
    readonly amount: string;
  };
  readonly options: {
    readonly treasuryAccounts: readonly {
      readonly id: string;
      readonly nameEn: string;
      readonly nameFa: string | null;
      readonly currencyCode: SupportedCurrency;
      readonly accountType: string;
    }[];
    readonly expenseCategories: readonly {
      readonly id: string;
      readonly code: string;
      readonly nameEn: string;
      readonly nameFa: string | null;
    }[];
    readonly payees: readonly { readonly id: string; readonly name: string }[];
  };
}

/** One business date, used by the Record Expense options and the Daily Financial Report. */
export const operationalFinanceDateQuerySchema = z.object({ date: isoDateSchema }).strict();

export type OperationalFinanceDateQuery = z.infer<typeof operationalFinanceDateQuerySchema>;

interface DimensionRequirements {
  readonly requiresProject: boolean;
  readonly requiresDepartment: boolean;
  readonly requiresCostCenter: boolean;
}

export interface OperationalDimensionOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** JSON produced by `abos.operational_expense_entry_options` (migration 0029). */
export interface OperationalExpenseEntryOptions {
  readonly businessDate: string;
  readonly baseCurrency: SupportedCurrency | null;
  readonly policyConfigured: boolean;
  readonly approvalRequired: boolean | null;
  readonly openPeriod: { readonly nameEn: string; readonly nameFa: string | null } | null;
  readonly treasuryAccounts: readonly (DimensionRequirements & {
    readonly id: string;
    readonly nameEn: string;
    readonly nameFa: string | null;
    readonly currencyCode: SupportedCurrency;
    readonly accountType: string;
  })[];
  readonly expenseCategories: readonly (DimensionRequirements & {
    readonly id: string;
    readonly code: string;
    readonly nameEn: string;
    readonly nameFa: string | null;
  })[];
  readonly payees: readonly { readonly id: string; readonly name: string }[];
  readonly projects: readonly OperationalDimensionOption[];
  readonly departments: readonly OperationalDimensionOption[];
  readonly costCenters: readonly OperationalDimensionOption[];
  readonly exchangeRates: readonly {
    readonly id: string;
    readonly rateSource: "MARKET" | "SARAF";
    readonly sarafName: string | null;
    readonly unitCurrency: SupportedCurrency;
    readonly quoteCurrency: SupportedCurrency;
    readonly rate: string;
  }[];
}

/** JSON produced by `abos.operational_finance_daily_report` (migration 0029). */
export interface OperationalFinanceDailyReport {
  readonly reportDate: string;
  readonly baseCurrency: SupportedCurrency;
  readonly expensesByCategory: readonly {
    readonly categoryId: string;
    readonly code: string;
    readonly nameEn: string;
    readonly nameFa: string | null;
    readonly currency: SupportedCurrency;
    readonly count: number;
    readonly amount: string;
    readonly baseAmount: string;
  }[];
  readonly totalsByCurrency: readonly {
    readonly currency: SupportedCurrency;
    readonly count: number;
    readonly amount: string;
  }[];
  readonly baseTotal: { readonly currency: SupportedCurrency; readonly amount: string };
  readonly pendingApproval: { readonly count: number };
  readonly treasuryMovements: readonly {
    readonly treasuryAccountId: string;
    readonly nameEn: string;
    readonly nameFa: string | null;
    readonly currency: SupportedCurrency;
    readonly status: string;
    readonly before: string;
    readonly day: string;
    readonly after: string;
  }[];
}
