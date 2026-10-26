import { z } from "zod";
import { isoDateSchema, opaqueUuidSchema } from "./runtime-schemas.ts";

const positive = z.string().max(40).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).refine(value => /[1-9]/.test(value));
const currency = z.string().regex(/^[A-Z]{3}$/);
const optional = (length: number) => z.string().max(length).nullable();
const metadata = { idempotencyKey: z.string().min(8).max(128), correlationId: opaqueUuidSchema };

/** How a shareholder's money or value reaches the company. Each one has its own exact debit. */
export const DIRECT_CAPITAL_METHODS = ["CASH", "HAWALA", "ASSET", "BILL_PAYMENT"] as const;
export type DirectCapitalMethod = (typeof DIRECT_CAPITAL_METHODS)[number];

/**
 * One contribution. The database enforces which fields each method requires; these shapes refuse
 * the obvious mismatches early so the person gets a plain message instead of a database error.
 */
const contributionShape = {
  fundingMethod: z.enum(DIRECT_CAPITAL_METHODS),
  amount: positive,
  currencyCode: currency,
  receiptDate: isoDateSchema,
  destinationAccountId: opaqueUuidSchema.nullable(),
  providerName: z.string().trim().min(2).max(160).nullable(),
  itemDescription: z.string().trim().min(2).max(300).nullable(),
  expenseLedgerAccountId: opaqueUuidSchema.nullable(),
  paymentReference: optional(120),
  note: optional(1000)
};

function matchesMethod(value: {
  readonly fundingMethod: DirectCapitalMethod; readonly destinationAccountId: string | null;
  readonly providerName: string | null; readonly itemDescription: string | null;
  readonly expenseLedgerAccountId: string | null;
}): boolean {
  const cashBearing = value.fundingMethod === "CASH" || value.fundingMethod === "HAWALA";
  return cashBearing === (value.destinationAccountId !== null)
    && (value.fundingMethod === "HAWALA") === (value.providerName !== null)
    && (!cashBearing) === (value.itemDescription !== null)
    && (value.fundingMethod === "BILL_PAYMENT") === (value.expenseLedgerAccountId !== null);
}

const methodMessage = "Each way of contributing needs its own details: a Safe for cash, a saraf for hawala, a description for an asset, and an expense account for a bill.";

export const directCapitalContributionSchema = z.object(contributionShape).strict().refine(matchesMethod, { message: methodMessage });

/** Decimal strings only; the database performs exact allocation and accounting arithmetic. */
export const directShareholderCommandSchema = z.discriminatedUnion("action", [
  // One save: the shareholder, an optional agreed total and the money arriving now.
  z.object({ action: z.literal("add-shareholder"), displayName: z.string().trim().min(2).max(160),
    agreedTotal: positive.nullable(), currencyCode: currency.nullable(),
    externalReference: optional(60), note: optional(1000), businessDate: isoDateSchema,
    firstContribution: z.object(contributionShape).strict().refine(matchesMethod, { message: methodMessage }).nullable(),
    ...metadata }).strict()
    .refine(value => value.agreedTotal === null || value.currencyCode !== null,
      { message: "An agreed total needs its currency." }),
  // More money from a shareholder who already exists.
  z.object({ action: z.literal("add-capital"), shareholderProfileId: opaqueUuidSchema, ...contributionShape, ...metadata })
    .strict().refine(matchesMethod, { message: methodMessage })
]);
export type DirectShareholderCommand = z.infer<typeof directShareholderCommandSchema>;

export interface DirectCapitalWorkspace {
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string };
  readonly permissions: { readonly canManage: boolean; readonly canReceive: boolean };
  readonly currencies: readonly { readonly code: string; readonly label: string }[];
  readonly destinations: readonly { readonly id: string; readonly name: string; readonly currency: string; readonly balance: string | null }[];
  /** Ordinary expense accounts, for a bill a shareholder paid directly. */
  readonly expenseAccounts: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  /** False until one "shareholder contributed assets" account exists in the Chart of Accounts. */
  readonly assetAccountReady: boolean;
  readonly receiveAvailable: boolean;
  readonly unavailableReason: string | null;
  readonly shareholders: readonly {
    readonly id: string; readonly name: string; readonly reference: string | null; readonly note: string | null;
    readonly active: boolean;
    /** What they actually contributed, with an agreed total only where one was given. */
    readonly capitals: readonly { readonly currency: string; readonly contributed: string;
      readonly agreedTotal: string | null; readonly remaining: string | null }[];
    readonly transactions: readonly { readonly id: string; readonly date: string; readonly amount: string;
      readonly currency: string; readonly method: DirectCapitalMethod; readonly destination: string | null;
      readonly providerName: string | null; readonly itemDescription: string | null; readonly debitAccount: string | null;
      readonly reference: string; readonly status: "POSTED";
      readonly journalId: string; readonly note: string | null; readonly paymentReference: string | null }[];
    readonly documents: readonly { readonly id: string; readonly fileName: string; readonly version: number }[];
  }[];
}
export interface DirectCapitalResult {
  readonly shareholderProfileId?: string; readonly contributionId?: string | null; readonly receiptId?: string;
  readonly journalId?: string; readonly reference?: string; readonly status?: "POSTED"; readonly replayed?: boolean;
  readonly agreedTotal?: string | null;
  readonly firstReceipt?: { readonly receiptId: string; readonly journalId: string; readonly reference: string } | null;
}
