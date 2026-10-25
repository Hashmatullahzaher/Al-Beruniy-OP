import { z } from "zod";
import { isoDateSchema, opaqueUuidSchema } from "./runtime-schemas.ts";

const positive = z.string().max(40).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).refine(value => /[1-9]/.test(value));
const currency = z.string().regex(/^[A-Z]{3}$/);
const optional = (length: number) => z.string().max(length).nullable();
const metadata = { idempotencyKey: z.string().min(8).max(128), correlationId: opaqueUuidSchema };

/** Decimal strings only; the database performs exact allocation and accounting arithmetic. */
export const directShareholderCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-shareholder"), displayName: z.string().trim().min(2).max(160),
    totalCapital: positive, currencyCode: currency, ownershipPercent: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
      .refine(value => Number(value) <= 100).nullable(), externalReference: optional(60), note: optional(1000),
    businessDate: isoDateSchema, ...metadata }).strict(),
  z.object({ action: z.literal("receive-capital"), shareholderProfileId: opaqueUuidSchema, amount: positive,
    currencyCode: currency, receiptDate: isoDateSchema, destinationAccountId: opaqueUuidSchema,
    paymentReference: optional(120), note: optional(1000), ...metadata }).strict()
]);
export type DirectShareholderCommand = z.infer<typeof directShareholderCommandSchema>;

export interface DirectCapitalWorkspace {
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string };
  readonly permissions: { readonly canManage: boolean; readonly canReceive: boolean };
  readonly currencies: readonly { readonly code: string; readonly label: string }[];
  readonly destinations: readonly { readonly id: string; readonly name: string; readonly currency: string; readonly balance: string | null }[];
  readonly receiveAvailable: boolean;
  readonly unavailableReason: string | null;
  readonly shareholders: readonly {
    readonly id: string; readonly name: string; readonly reference: string | null; readonly note: string | null;
    readonly ownershipPercent: string | null; readonly active: boolean;
    readonly capitals: readonly { readonly currency: string; readonly total: string; readonly received: string;
      readonly outstanding: string; readonly available: string }[];
    readonly transactions: readonly { readonly id: string; readonly date: string; readonly amount: string;
      readonly currency: string; readonly destination: string; readonly reference: string; readonly status: "POSTED";
      readonly journalId: string; readonly note: string | null; readonly paymentReference: string | null }[];
    readonly documents: readonly { readonly id: string; readonly fileName: string; readonly version: number }[];
  }[];
}
export interface DirectCapitalResult {
  readonly shareholderProfileId?: string; readonly contributionId?: string; readonly receiptId?: string;
  readonly journalId?: string; readonly reference?: string; readonly status?: "POSTED"; readonly replayed?: boolean;
}
