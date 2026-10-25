import assert from "node:assert/strict";
import test from "node:test";
import { directShareholderCommandSchema } from "./direct-shareholder-capital.ts";

const receipt = { action: "receive-capital", shareholderProfileId: "7a2a3516-cb51-4a42-95af-324eb5e850a1",
  amount: "20000", currencyCode: "USD", receiptDate: "2026-10-24",
  destinationAccountId: "2c8e28e8-e43f-4e3e-a383-e585230b6125", paymentReference: null, note: null,
  idempotencyKey: "one-capital-business-event", correlationId: "c48f91d4-78dc-4685-bdd6-521ee234b375" };

test("direct receipts preserve exact decimal text without floating-point conversion", () => {
  const value = directShareholderCommandSchema.parse({ ...receipt, amount: "9007199254740993.125" });
  assert.equal(value.action, "receive-capital");
  if (value.action === "receive-capital") assert.equal(value.amount, "9007199254740993.125");
});
test("amounts reject exponent, NaN, Infinity, negative and zero representations", () => {
  for (const amount of ["2e4", "NaN", "Infinity", "-1", "0", "0.000", "20,000", "01", "1".repeat(41)]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...receipt, amount }).success, false, amount);
  }
});
test("browser requests cannot select actor, entity, approval, journal or custody state", () => {
  for (const key of ["legalEntityId", "actorId", "approved", "journalId", "verified", "processingModel", "sessionProvenance"]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...receipt, [key]: "forged" }).success, false, key);
  }
});
test("receipts require stable request keys, valid identifiers and business dates", () => {
  for (const patch of [{ idempotencyKey: "" }, { correlationId: "forged" }, { receiptDate: "2026-99-99" },
    { destinationAccountId: "../../foreign" }, { currencyCode: "usd" }]) {
    assert.equal(directShareholderCommandSchema.safeParse({ ...receipt, ...patch }).success, false);
  }
});
test("creating capital does not require an agreement, installment, approval or document", () => {
  const { idempotencyKey, correlationId } = receipt;
  const create = { action: "create-shareholder", displayName: "Demo Shareholder", totalCapital: "100000",
    currencyCode: "USD", ownershipPercent: null, externalReference: null, note: null,
    businessDate: "2026-10-24", idempotencyKey, correlationId };
  assert.equal(directShareholderCommandSchema.safeParse(create).success, true);
  assert.equal(directShareholderCommandSchema.safeParse({ ...create, ownershipPercent: "101" }).success, false);
});
