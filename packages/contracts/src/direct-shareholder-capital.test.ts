import assert from "node:assert/strict";
import test from "node:test";
import { directShareholderCommandSchema } from "./direct-shareholder-capital.ts";

const contribution = { fundingMethod: "CASH", amount: "20000", currencyCode: "USD", receiptDate: "2026-10-24",
  destinationAccountId: "2c8e28e8-e43f-4e3e-a383-e585230b6125", providerName: null, itemDescription: null,
  expenseLedgerAccountId: null, paymentReference: null, note: null };
const capital = { action: "add-capital", shareholderProfileId: "7a2a3516-cb51-4a42-95af-324eb5e850a1",
  ...contribution, idempotencyKey: "one-capital-business-event",
  correlationId: "c48f91d4-78dc-4685-bdd6-521ee234b375" };

test("contributions preserve exact decimal text without floating-point conversion", () => {
  const value = directShareholderCommandSchema.parse({ ...capital, amount: "9007199254740993.125" });
  assert.equal(value.action, "add-capital");
  if (value.action === "add-capital") assert.equal(value.amount, "9007199254740993.125");
});
test("amounts reject exponent, NaN, Infinity, negative and zero representations", () => {
  for (const amount of ["2e4", "NaN", "Infinity", "-1", "0", "0.000", "20,000", "01", "1".repeat(41)]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...capital, amount }).success, false, amount);
  }
});
test("browser requests cannot select actor, entity, approval, journal or custody state", () => {
  for (const key of ["legalEntityId", "actorId", "approved", "journalId", "verified", "processingModel", "sessionProvenance"]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...capital, [key]: "forged" }).success, false, key);
  }
});
test("contributions require stable request keys, valid identifiers and business dates", () => {
  for (const patch of [{ idempotencyKey: "" }, { correlationId: "forged" }, { receiptDate: "2026-99-99" },
    { destinationAccountId: "../../foreign" }, { currencyCode: "usd" }]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...capital, ...patch }).success, false);
  }
});
test("each way of contributing carries only its own details", () => {
  // Cash and hawala need a Safe; an asset or a paid bill never does.
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, destinationAccountId: null }).success, false);
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "HAWALA" }).success, false,
    "hawala without a saraf is refused");
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "HAWALA",
    providerName: "Saraf Mahmood" }).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, providerName: "Saraf Mahmood" }).success, false,
    "a saraf belongs only to a hawala");
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "ASSET",
    destinationAccountId: null, itemDescription: "Hilux pickup, 2019" }).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "ASSET",
    destinationAccountId: null, itemDescription: null }).success, false);
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "BILL_PAYMENT",
    destinationAccountId: null, itemDescription: "Generator fuel", expenseLedgerAccountId: "2c8e28e8-e43f-4e3e-a383-e585230b6125" }).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "BILL_PAYMENT",
    destinationAccountId: null, itemDescription: "Generator fuel" }).success, false,
    "a paid bill needs the expense account it covers");
  assert.equal(directShareholderCommandSchema.safeParse({ ...capital, fundingMethod: "GIFT" }).success, false);
});
test("one save adds the shareholder with or without money, and needs no agreement or approval", () => {
  const { idempotencyKey, correlationId } = capital;
  const add = { action: "add-shareholder", displayName: "Demo Shareholder", agreedTotal: null, currencyCode: null,
    externalReference: null, note: null, businessDate: "2026-10-24", firstContribution: null,
    idempotencyKey, correlationId };
  assert.equal(directShareholderCommandSchema.safeParse(add).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...add, firstContribution: contribution }).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...add, agreedTotal: "100000", currencyCode: "USD" }).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...add, agreedTotal: "100000" }).success, false,
    "an agreed total needs its currency");
  assert.equal(directShareholderCommandSchema.safeParse({ ...add, agreedTotal: "0", currencyCode: "USD" }).success, false);
  assert.equal(directShareholderCommandSchema.safeParse({ ...add, ownershipPercent: "12.5" }).success, false,
    "ownership percentages are no longer part of this workflow");
  assert.equal(directShareholderCommandSchema.safeParse({ ...add,
    firstContribution: { ...contribution, destinationAccountId: null } }).success, false);
});
