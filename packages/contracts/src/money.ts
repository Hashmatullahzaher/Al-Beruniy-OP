import { z } from "zod";

export const supportedCurrencySchema = z.enum(["USD", "AFN"]);
export type SupportedCurrency = z.infer<typeof supportedCurrencySchema>;

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const decimalStringSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(decimalPattern, "Amount must be a non-negative canonical decimal string");

export type DecimalString = string & { readonly __decimalString: true };

export const moneySchema = z
  .object({
    amount: decimalStringSchema,
    currency: supportedCurrencySchema
  })
  .strict();

export interface Money {
  readonly amount: DecimalString;
  readonly currency: SupportedCurrency;
}

export function asDecimalString(value: string): DecimalString {
  return decimalStringSchema.parse(value) as DecimalString;
}
