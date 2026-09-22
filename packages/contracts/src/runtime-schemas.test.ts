import assert from "node:assert/strict";
import test from "node:test";
import {
  capitalReceiptDraftRequestSchema,
  companyLevelDimensionsSchema,
  projectLevelDimensionsSchema,
  writeRequestHeadersSchema
} from "./runtime-schemas.ts";
import { moneySchema } from "./money.ts";

const legalEntityId = "10000000-0000-4000-8000-000000000001";
const uuid = (last: number) => `10000000-0000-4000-8000-${String(last).padStart(12, "0")}`;

test("money requires a canonical decimal string and explicit supported currency", () => {
  assert.equal(moneySchema.parse({ amount: "100.25", currency: "USD" }).amount, "100.25");
  assert.throws(() => moneySchema.parse({ amount: 100.25, currency: "USD" }));
  assert.throws(() => moneySchema.parse({ amount: "1e3", currency: "USD" }));
  assert.throws(() => moneySchema.parse({ amount: "-1", currency: "USD" }));
  assert.throws(() => moneySchema.parse({ amount: "1", currency: "EUR" }));
});

test("company-level corporate capital does not invent a project", () => {
  const result = companyLevelDimensionsSchema.parse({
    scope: "COMPANY_LEVEL",
    legalEntityId,
    companyLevelReason: "CORPORATE_CAPITAL"
  });
  assert.equal("projectId" in result, false);
  assert.throws(() => companyLevelDimensionsSchema.parse({ ...result, projectId: uuid(2) }));
});

test("project-level dimensions require project, department, and cost center", () => {
  assert.throws(() => projectLevelDimensionsSchema.parse({ scope: "PROJECT_LEVEL", legalEntityId }));
  assert.doesNotThrow(() => projectLevelDimensionsSchema.parse({
    scope: "PROJECT_LEVEL",
    legalEntityId,
    projectId: uuid(2),
    departmentId: uuid(3),
    costCenterId: uuid(4)
  }));
});

test("actor identity cannot be injected in a capital receipt body", () => {
  const body = {
    shareholderPartyId: uuid(5),
    agreementId: uuid(6),
    installmentId: uuid(7),
    expectedDestinationAccountId: uuid(8),
    dimensions: { scope: "COMPANY_LEVEL", legalEntityId, companyLevelReason: "CORPORATE_CAPITAL" },
    amount: { amount: "25000", currency: "USD" },
    evidenceReferenceIds: [uuid(9)],
    businessEventAt: "2026-09-22T08:00:00+04:30",
    actorUserAccountId: uuid(10)
  };
  assert.throws(() => capitalReceiptDraftRequestSchema.parse(body));
});

test("write metadata requires both idempotency and correlation identifiers", () => {
  assert.doesNotThrow(() => writeRequestHeadersSchema.parse({
    idempotencyKey: "receipt-key-001",
    correlationId: "correlation-001"
  }));
  assert.throws(() => writeRequestHeadersSchema.parse({ correlationId: "correlation-001" }));
});
