import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  LegalEntityId,
  Money,
  PhysicalCashCountId,
  TreasuryPermission,
  UserAccountId
} from "@abos/contracts";
import { TreasuryDomainError } from "./errors.ts";
import {
  assertAccountCanReceive,
  assertAssignedCashier,
  assertCountCoversReceipt,
  assertIndependentVerifier,
  assertOpeningApprover,
  assertSourceCanBeReceived,
  compareDecimal,
  receiptStage,
  requirePermission
} from "./policy.ts";
import type {
  CapitalReceiptSource,
  CashAccountRecord,
  CashLocationRecord,
  PhysicalCashCountRecord,
  TreasuryActor,
  TreasuryReceipt
} from "./types.ts";

// Every value below is synthetic. None of it represents a real AL-BERUNIY safe, cashier or amount.

const ENTITY = "le-synthetic-001" as LegalEntityId;
const CASHIER = "user-synthetic-cashier" as UserAccountId;
const VERIFIER = "user-synthetic-verifier" as UserAccountId;
const COUNTER = "user-synthetic-counter" as UserAccountId;
const SAFE = "loc-synthetic-safe" as CashLocationId;
const USD_ACCOUNT = "acct-synthetic-usd" as CashLocationCurrencyAccountId;

const usd = (amount: string): Money => ({ amount: amount as Money["amount"], currency: "USD" });

function actor(user: UserAccountId, permissions: readonly TreasuryPermission[]): TreasuryActor {
  return { userAccountId: user, legalEntityId: ENTITY, treasuryPermissions: permissions, sessionId: "session" };
}

const location: CashLocationRecord = {
  id: SAFE, legalEntityId: ENTITY, name: "Synthetic Head Office Safe", kind: "OFFICE_SAFE",
  status: "ACTIVE", responsibleCashierUserAccountId: CASHIER
};
const account: CashAccountRecord = {
  id: USD_ACCOUNT, legalEntityId: ENTITY, cashLocationId: SAFE, currency: "USD",
  ledgerAccountId: "ledger-synthetic-cash-usd", status: "ACTIVE"
};
const source: CapitalReceiptSource = {
  id: "intent-synthetic-1" as CapitalReceiptIntentId, legalEntityId: ENTITY,
  shareholderBusinessPartyId: "party-synthetic", shareholderDisplayName: "Synthetic Shareholder One",
  capitalAgreementId: "agr-synthetic", agreementReference: "SYN-CAP-001",
  capitalInstallmentId: "inst-synthetic-1", installmentSequence: 1, amount: usd("25000.00"),
  destinationCashAccountId: USD_ACCOUNT, status: "ELIGIBLE", businessEventAt: "2026-09-22T07:00:00.000Z",
  evidenceReferenceId: "ev-synthetic"
};
const receipt: TreasuryReceipt = {
  id: "rcpt-synthetic-1" as CashReceiptId, legalEntityId: ENTITY, capitalReceiptIntentId: source.id,
  capitalInstallmentId: source.capitalInstallmentId, cashAccountId: USD_ACCOUNT, cashLocationId: SAFE,
  receiptReference: "RCPT-SYN-1", amount: usd("25000.00"), businessEventAt: "2026-09-22T07:10:00.000Z",
  receivedByUserAccountId: CASHIER, physicalCashCountId: "count-synthetic-1" as PhysicalCashCountId,
  status: "COUNTED", submittedForVerificationAt: "2026-09-22T07:20:00.000Z"
};
const count: PhysicalCashCountRecord = {
  id: "count-synthetic-1" as PhysicalCashCountId, legalEntityId: ENTITY, cashAccountId: USD_ACCOUNT,
  currency: "USD", countedAmount: "25000.00", countedAt: "2026-09-22T07:15:00.000Z",
  countedByUserAccountId: CASHIER, evidenceReferenceId: "ev-count", purpose: "RECEIPT", status: "RECORDED"
};

function rejects(code: TreasuryDomainError["code"], run: () => void, message?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof TreasuryDomainError, `expected TreasuryDomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  }, message);
}

test("a missing Treasury permission is refused, and a Finance permission does not substitute", () => {
  rejects("PERMISSION_DENIED", () => requirePermission(actor(CASHIER, []), "treasury.cash-receipt.record"));
  requirePermission(actor(CASHIER, ["treasury.cash-receipt.record"]), "treasury.cash-receipt.record");
});

test("an inactive account, a blocked account or an inactive safe cannot receive cash", () => {
  assertAccountCanReceive(account, location);
  for (const status of ["DRAFT", "RECONCILED", "APPROVED", "BLOCKED"] as const) {
    rejects("CASH_ACCOUNT_INACTIVE", () => assertAccountCanReceive({ ...account, status }, location), status);
  }
  rejects("CASH_ACCOUNT_INACTIVE", () => assertAccountCanReceive(account, { ...location, status: "INACTIVE" }));
  rejects("NOT_FOUND", () => assertAccountCanReceive(undefined, location));
});

test("the source must be ELIGIBLE, in this entity, for this account and in this currency", () => {
  assertSourceCanBeReceived(source, account);
  for (const status of ["DRAFT", "REJECTED", "TREASURY_VERIFIED", "POSTED"] as const) {
    rejects("CAPITAL_AGREEMENT_REQUIRED", () => assertSourceCanBeReceived({ ...source, status }, account), status);
  }
  rejects("SCOPE_MISMATCH", () => assertSourceCanBeReceived({ ...source, legalEntityId: "other" as LegalEntityId }, account));
  rejects("SCOPE_MISMATCH", () =>
    assertSourceCanBeReceived({ ...source, destinationCashAccountId: "acct-other" as CashLocationCurrencyAccountId }, account));
  rejects("CURRENCY_MISMATCH", () =>
    assertSourceCanBeReceived({ ...source, amount: { amount: "25000.00" as Money["amount"], currency: "AFN" } }, account));
  rejects("NOT_FOUND", () => assertSourceCanBeReceived(undefined, account));
});

test("only an assigned cashier can receive cash into a safe", () => {
  assertAssignedCashier(actor(CASHIER, []), [CASHIER]);
  rejects("PERMISSION_DENIED", () => assertAssignedCashier(actor(VERIFIER, ["treasury.cash-receipt.record"]), [CASHIER]));
  rejects("PERMISSION_DENIED", () => assertAssignedCashier(actor(CASHIER, []), []));
});

test("the physical count must cover the receipt, compared exactly", () => {
  assertCountCoversReceipt("25000.00", "25000.00");
  assertCountCoversReceipt("25000", "25000.00");
  assertCountCoversReceipt("30000.50", "25000.00");
  rejects("EVIDENCE_REQUIRED", () => assertCountCoversReceipt("24999.99", "25000.00"));
  rejects("CURRENCY_MISMATCH", () => assertCountCoversReceipt("1e5", "25000.00"));
  rejects("CURRENCY_MISMATCH", () => assertCountCoversReceipt("-1", "25000.00"));
  // Exact comparison: a float would call these equal.
  assert.equal(compareDecimal("0.3", "0.1000000000000000055511151231257827"), 1);
  assert.equal(compareDecimal("9007199254740993", "9007199254740992"), 1);
});

test("verification is independent of the cashier and of the counter", () => {
  assertIndependentVerifier(actor(VERIFIER, []), receipt, count);
  rejects("SEGREGATION_OF_DUTIES_VIOLATION", () => assertIndependentVerifier(actor(CASHIER, []), receipt, count), "self-verification");
  rejects("SEGREGATION_OF_DUTIES_VIOLATION", () =>
    assertIndependentVerifier(actor(COUNTER, []), { ...receipt, receivedByUserAccountId: VERIFIER }, { ...count, countedByUserAccountId: COUNTER }));
  rejects("EVIDENCE_REQUIRED", () => assertIndependentVerifier(actor(VERIFIER, []), receipt, undefined), "missing count evidence");
});

test("the opening approver is neither the reconciler nor the counter", () => {
  assertOpeningApprover(actor(VERIFIER, []), CASHIER, COUNTER);
  rejects("SEGREGATION_OF_DUTIES_VIOLATION", () => assertOpeningApprover(actor(CASHIER, []), CASHIER, COUNTER));
  rejects("SEGREGATION_OF_DUTIES_VIOLATION", () => assertOpeningApprover(actor(COUNTER, []), CASHIER, COUNTER));
});

test("the displayed stage never claims more than the stored rows record", () => {
  assert.equal(receiptStage({ ...receipt, status: "DRAFT" }, undefined, undefined), "DRAFT");
  const counted = { ...receipt };
  delete (counted as { submittedForVerificationAt?: string }).submittedForVerificationAt;
  assert.equal(receiptStage(counted, undefined, undefined), "COUNTED");
  assert.equal(receiptStage(receipt, undefined, undefined), "PENDING_VERIFICATION");
  const verified = { ...receipt, status: "VERIFIED" as const };
  assert.equal(receiptStage(verified, undefined, undefined), "VERIFIED");
  const handoff = {
    id: "h", legalEntityId: ENTITY, cashReceiptId: receipt.id, capitalReceiptIntentId: source.id,
    handedOffByUserAccountId: VERIFIER, handedOffAt: "2026-09-22T08:00:00.000Z", status: "READY_FOR_FINANCE" as const
  };
  assert.equal(receiptStage(verified, handoff, undefined), "HANDED_TO_FINANCE");
  assert.equal(receiptStage(verified, handoff, "journal-1"), "POSTED_BY_FINANCE");
  // "Approved" and "posted" are distinct, and neither is claimed without a handoff.
  assert.equal(receiptStage(verified, handoff, undefined, "APPROVED"), "APPROVED_BY_FINANCE");
  assert.equal(receiptStage(verified, handoff, undefined, "REJECTED"), "REJECTED_BY_FINANCE");
  assert.equal(receiptStage(verified, undefined, undefined, "APPROVED"), "VERIFIED");
  assert.equal(receiptStage(verified, handoff, "journal-1", "APPROVED"), "POSTED_BY_FINANCE");
  // A journal id on an unverified receipt cannot promote it: posting requires verification first.
  assert.equal(receiptStage(receipt, undefined, "journal-1"), "PENDING_VERIFICATION");
  assert.equal(receiptStage({ ...receipt, status: "VOIDED" }, handoff, "journal-1"), "VOIDED");
});

test("the Treasury domain cannot post: no Finance dependency and no ledger-writing surface", async () => {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    readonly dependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies), ["@abos/contracts"]);

  const sources = (await readdir(import.meta.dirname)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  for (const file of sources) {
    const code = (await readFile(resolve(import.meta.dirname, file), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /@abos\/finance/, `${file} must not import Finance`);
    assert.doesNotMatch(code, /\b(postJournal|postCapitalReceipt|journal_lines|subledger_entries)\b/, `${file} must not reach the ledger`);
    assert.doesNotMatch(code, /\b(creditAccount|debitAccount|ledgerBalance|safeBalance)\b/, `${file} must not keep a balance`);
  }
});
