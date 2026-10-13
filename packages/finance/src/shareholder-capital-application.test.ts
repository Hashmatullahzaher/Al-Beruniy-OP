import assert from "node:assert/strict";
import test from "node:test";

import {
  SHAREHOLDER_FINANCE_PERMISSION_BY_OPERATION,
  shareholderCapitalCustodyDecisionSchema,
  shareholderCapitalPostingDecisionSchema,
  shareholderCapitalReceiptRecordSchema,
  type CorrelationId,
  type IdempotencyKey
} from "@abos/contracts";

import { FinanceDomainError } from "./errors.ts";
import {
  ShareholderFinanceApplicationService,
  UnavailableShareholderFinanceGateway
} from "./shareholder-capital-application.ts";

const context = {
  sessionProof: "server-cookie-proof",
  idempotencyKey: "stable-request-key" as IdempotencyKey,
  correlationId: "correlation-bridge" as CorrelationId
};

test("production commands fail closed while the coordinated schema capability is absent", async () => {
  const service = new ShareholderFinanceApplicationService(new UnavailableShareholderFinanceGateway());
  await assert.rejects(
    service.recordReceipt(context, {
      contributionId: "11111111-1111-4111-8111-111111111111",
      expectedContributionVersion: 1,
      amount: { amount: "100", currency: "USD" },
      receiptDate: "2026-10-13",
      treasuryDestinationId: "22222222-2222-4222-8222-222222222222"
    }),
    (error: unknown) => error instanceof FinanceDomainError && error.code === "SCHEMA_NOT_AVAILABLE"
  );
  assert.deepEqual(await service.capability(), {
    state: "SCHEMA_NOT_AVAILABLE",
    schemaInstalled: false,
    mutationAvailable: false,
    reviewModeAvailable: false,
    requiredSessionProvenance: "PASSWORD_OPERATIONAL",
    reason: "The coordinated Shareholders to Finance database capability is not installed."
  });
});

test("write schemas reject caller-supplied authority and policy fields", () => {
  const base = {
    contributionId: "11111111-1111-4111-8111-111111111111",
    expectedContributionVersion: 1,
    amount: { amount: "100", currency: "USD" },
    receiptDate: "2026-10-13",
    treasuryDestinationId: "22222222-2222-4222-8222-222222222222"
  };
  for (const injected of [
    { actorUserAccountId: "33333333-3333-4333-8333-333333333333" },
    { legalEntityId: "44444444-4444-4444-8444-444444444444" },
    { permissions: ["finance.capital-receipt.post"] },
    { approvalRequired: false },
    { paidInCapitalLedgerAccountId: "55555555-5555-4555-8555-555555555555" }
  ]) assert.equal(shareholderCapitalReceiptRecordSchema.safeParse({ ...base, ...injected }).success, false);
});

test("custody and Finance decisions are distinct strict contracts", () => {
  assert.equal(shareholderCapitalCustodyDecisionSchema.safeParse({
    expectedReceiptVersion: 1,
    decision: "VERIFIED",
    verificationKind: "PHYSICAL_CASH_COUNT",
    evidenceReferenceId: "11111111-1111-4111-8111-111111111111"
  }).success, true);
  assert.equal(shareholderCapitalCustodyDecisionSchema.safeParse({
    expectedReceiptVersion: 1,
    decision: "REJECTED",
    verificationKind: "PHYSICAL_CASH_COUNT",
    evidenceReferenceId: "11111111-1111-4111-8111-111111111111"
  }).success, false);
  assert.equal(shareholderCapitalPostingDecisionSchema.safeParse({
    expectedIntentVersion: 1,
    decision: "APPROVED",
    evidenceReferenceId: "11111111-1111-4111-8111-111111111111",
    decisionReason: "Independent Finance review completed"
  }).success, true);
});

test("production operations map to the coordinated least-privilege permissions", () => {
  assert.deepEqual(SHAREHOLDER_FINANCE_PERMISSION_BY_OPERATION, {
    RECORD_RECEIPT: "shareholder.capital-receipt.record",
    VERIFY_CUSTODY: "treasury.capital-receipt.verify",
    PREPARE_POSTING: "finance.posting-intent.create",
    DECIDE_POSTING: "finance.capital-receipt.approve",
    POST_RECEIPT: "finance.capital-receipt.post",
    READ_TRACE: "shareholder.capital-receipt.read"
  });
});
