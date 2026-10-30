/**
 * Refusals of the foreign-currency conversion (migration 0051) and the rate snapshot (0016), matched on the database's
 * own messages and shared by every money lane. No imports, so every server module can use it.
 */

export const FX_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /FX setup: no FX difference account/i, status: 422, code: "FX_SETUP_REQUIRED",
    message: "Foreign-currency posting is not set up: create one active income or expense account in the accounting currency with the control “FX difference” in the Chart of Accounts." },
  { pattern: /FX setup: \d+ active accounts carry control FX_DIFFERENCE/i, status: 422, code: "FX_SETUP_AMBIGUOUS",
    message: "Several accounts carry the control “FX difference”. Save an FX policy for this currency that names one." },
  { pattern: /FX setup:/i, status: 422, code: "FX_SETUP_INVALID",
    message: "The FX difference account is not usable. Check it in the Chart of Accounts or save a new FX policy for this currency." },
  { pattern: /FX policy is exact-only/i, status: 422, code: "CONVERSION_NOT_EXACT",
    message: "This amount does not convert exactly at the chosen rate, and this currency's FX policy is exact-only." },
  { pattern: /too small to convert/i, status: 422, code: "AMOUNT_TOO_SMALL",
    message: "This amount is too small to convert: it rounds to zero in the accounting currency." },
  { pattern: /exchange rate is recorded for/i, status: 422, code: "RATE_MISSING",
    message: "No exchange rate is recorded for this date. Record the day's rate first." },
  { pattern: /choose which rate this transaction uses/i, status: 422, code: "RATE_CHOICE_REQUIRED",
    message: "Several exchange rates exist for this date. Choose which rate this movement uses." },
  { pattern: /not a current .* rate for/i, status: 422, code: "RATE_INVALID",
    message: "The chosen exchange rate is not a current rate for this date." }
];

/** The first FX refusal that matches a database message, if any. */
export function fxRefusal(error: unknown) {
  const message = error instanceof Error && error.name !== "IdentityError" ? error.message : "";
  return message === "" ? undefined : FX_REFUSALS.find((refusal) => refusal.pattern.test(message));
}
