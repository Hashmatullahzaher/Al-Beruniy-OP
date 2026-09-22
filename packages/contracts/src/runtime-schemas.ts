import { z } from "zod";
import { moneySchema, supportedCurrencySchema } from "./money.ts";

export const opaqueUuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const isoDateSchema = z.iso.date();

export const companyLevelDimensionsSchema = z
  .object({
    scope: z.literal("COMPANY_LEVEL"),
    legalEntityId: opaqueUuidSchema,
    companyLevelReason: z.enum(["CORPORATE_CAPITAL", "TREASURY", "OTHER_APPROVED"]),
    departmentId: opaqueUuidSchema.optional(),
    costCenterId: opaqueUuidSchema.optional()
  })
  .strict();

export const projectLevelDimensionsSchema = z
  .object({
    scope: z.literal("PROJECT_LEVEL"),
    legalEntityId: opaqueUuidSchema,
    projectId: opaqueUuidSchema,
    departmentId: opaqueUuidSchema,
    costCenterId: opaqueUuidSchema
  })
  .strict();

export const transactionDimensionsSchema = z.discriminatedUnion("scope", [
  companyLevelDimensionsSchema,
  projectLevelDimensionsSchema
]);

export const writeRequestHeadersSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    correlationId: z.string().trim().min(8).max(200)
  })
  .strict();

export const capitalReceiptDraftRequestSchema = z
  .object({
    shareholderPartyId: opaqueUuidSchema,
    agreementId: opaqueUuidSchema,
    installmentId: opaqueUuidSchema,
    expectedDestinationAccountId: opaqueUuidSchema,
    dimensions: transactionDimensionsSchema,
    amount: moneySchema,
    evidenceReferenceIds: z.array(opaqueUuidSchema).min(1),
    businessEventAt: isoDateTimeSchema
  })
  .strict();

export const treasuryCashReceiptRequestSchema = z
  .object({
    capitalReceiptIntentId: opaqueUuidSchema,
    destinationAccountId: opaqueUuidSchema,
    physicalCashCountId: opaqueUuidSchema,
    countedAmount: moneySchema,
    evidenceReferenceIds: z.array(opaqueUuidSchema).min(1),
    businessEventAt: isoDateTimeSchema
  })
  .strict();

export const financeApprovalRequestSchema = z
  .object({
    evidenceReferenceIds: z.array(opaqueUuidSchema).min(1),
    decisionReason: z.string().trim().min(3).max(1000)
  })
  .strict();

export const financePostRequestSchema = z
  .object({
    accountingEffectiveDate: isoDateSchema,
    expectedCurrency: supportedCurrencySchema
  })
  .strict();
