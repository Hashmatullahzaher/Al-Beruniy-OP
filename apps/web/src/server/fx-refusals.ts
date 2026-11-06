/**
 * Refusals of the foreign-currency conversion (migration 0051) and the rate snapshot (0016), matched on the database's
 * own messages and shared by every money lane. No imports, so every server module can use it.
 */

export const FX_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  // 0063 and 0064: realized FX and Treasury carrying value, on every lane that can move foreign currency.
  { pattern: /REALIZED_FX_GAIN_ACCOUNT_REQUIRED/, status: 422, code: "REALIZED_FX_GAIN_ACCOUNT_REQUIRED",
    message: "This transaction realizes an FX gain. Create a Realized FX Gain account in the Chart of Accounts first. Nothing was recorded." },
  { pattern: /REALIZED_FX_LOSS_ACCOUNT_REQUIRED/, status: 422, code: "REALIZED_FX_LOSS_ACCOUNT_REQUIRED",
    message: "This transaction realizes an FX loss. Create a Realized FX Loss account in the Chart of Accounts first. Nothing was recorded." },
  { pattern: /REALIZED_FX_ACCOUNT_INVALID/, status: 422, code: "REALIZED_FX_ACCOUNT_INVALID",
    message: "Keep exactly one active Realized FX Gain account and one Realized FX Loss account, in the accounting currency, without dimensions. Nothing was recorded." },
  { pattern: /TREASURY_FX_OUT_OF_ORDER/, status: 422, code: "TREASURY_FX_OUT_OF_ORDER",
    message: "This account already has a later movement, and its value was worked out without this one. Date this on or after that day, or reverse the later movement first." },
  { pattern: /TREASURY_CARRYING_CORRECTION_REQUIRED/, status: 422, code: "TREASURY_CARRYING_CORRECTION_REQUIRED",
    message: "This account's accounting value comes from older postings and needs correcting before money can leave it. Nothing was recorded." },
  { pattern: /TREASURY_DISPOSE_IN_FULL/, status: 422, code: "TREASURY_DISPOSE_IN_FULL",
    message: "So little accounting value remains in this account that its balance can only be moved in full." },
  { pattern: /TREASURY_FX_OPENING_ORDER/, status: 422, code: "TREASURY_FX_OPENING_ORDER",
    message: "This account already owes this currency, so it cannot take an opening balance." },
  { pattern: /FX setup: no FX difference account/i, status: 422, code: "FX_SETUP_REQUIRED",
    message: "This would record an FX difference, which needs one active income or expense account in the accounting currency with the control “FX difference” in the Chart of Accounts." },
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
