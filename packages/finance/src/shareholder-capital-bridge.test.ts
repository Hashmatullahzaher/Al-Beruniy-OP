import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AccountingPeriodId,
  CapitalContributionDeclaration,
  CapitalReceiptPostingConfiguration,
  CorrelationId,
  DecimalString,
  DocumentId,
  EvidenceReference,
  EvidenceReferenceId,
  IdempotencyKey,
  LedgerAccountId,
  LegalEntityId,
  ServerActorContext,
  UserAccountId
} from "@abos/contracts";

import { FinanceDomainError } from "./errors.ts";
import type { LedgerAccountPolicy } from "./journal.ts";
import { InMemoryShareholderCapitalBridgeRepository } from "./shareholder-capital-bridge-memory.ts";
import { ShareholderCapitalBridgeService } from "./shareholder-capital-bridge.ts";
import type { BridgeDestination, BridgeLedgerAccount, BridgeReversalDecision } from "./shareholder-capital-bridge.ts";

const entity = "11111111-1111-4111-8111-111111111111" as LegalEntityId;
const otherEntity = "22222222-2222-4222-8222-222222222222" as LegalEntityId;
const cashAccount = "33333333-3333-4333-8333-333333333333" as LedgerAccountId;
const capitalAccount = "44444444-4444-4444-8444-444444444444" as LedgerAccountId;
const period = "55555555-5555-4555-8555-555555555555" as AccountingPeriodId;

const recorder = actor("recorder", [], ["treasury.cash-receipt.record"]);
const approver = actor("approver", ["finance.posting-intent.approve", "finance.journal.post"]);
const reverser = actor("reverser", ["finance.journal.reverse"]);
const reader = actor("reader", ["finance.report.operational.read"]);
const requester = actor("requester", ["finance.journal.reverse"]);
const dualRecorder = actor("dual-recorder", ["finance.posting-intent.approve", "finance.journal.post"], ["treasury.cash-receipt.record"]);
const outsider = actor("outsider", ["finance.posting-intent.approve", "finance.journal.post"], [], otherEntity);

test("a declared contribution has zero received, full outstanding and no journal", async () => {
  const fixture = setup([declaration("zemar-1", "50000", "2026-10-06")]);
  assert.deepEqual(await fixture.service.summary("zemar-1", reader), {
    contributionId: "zemar-1",
    declared: { amount: "50000", currency: "USD" },
    received: { amount: "0", currency: "USD" },
    outstanding: { amount: "50000", currency: "USD" },
    posted: { amount: "0", currency: "USD" },
    receiptCount: 0,
    approvalState: "NOT_RECEIVED",
    postingState: "NOT_POSTED"
  });
  assert.equal(fixture.repository.listJournals().length, 0);
  assert.equal(fixture.repository.listPostingIntents().length, 0);
});

test("recording a receipt creates no declaration duplicate, journal or Treasury movement", async () => {
  const fixture = setup([declaration("hash-new", "20000", "2026-10-08")]);
  const receipt = await record(fixture, "hash-new", "20000", "record-once");
  assert.equal(receipt.approvalState, "PENDING");
  assert.equal(fixture.repository.contributionCount(), 1);
  assert.equal(fixture.repository.listJournals().length, 0);
  assert.equal(fixture.repository.treasuryMovements.length, 0);
});

test("receipt recording replay is idempotent and conflicting reuse is refused", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const first = await record(fixture, "c1", "10000", "record-key");
  const replay = await record(fixture, "c1", "10000", "record-key");
  assert.equal(replay.id, first.id);
  await expectCode(() => record(fixture, "c1", "11000", "record-key"), "IDEMPOTENCY_CONFLICT");
});

test("approval is maker-checker controlled and creates no posting", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await expectCode(() => decide(fixture, receipt.id, receipt.version, recorder, "APPROVE", "self"), "PERMISSION_DENIED");
  const approved = await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  assert.equal(approved.approvalState, "APPROVED");
  assert.equal(fixture.repository.listJournals().length, 0);
});

test("posting creates one balanced journal, posting intent and two subledger-tagged lines", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  const journal = await post(fixture, receipt.id, "post");
  assert.equal(journal.lines.length, 2);
  assert.equal(journal.lines[0]?.debitBase, "50000");
  assert.equal(journal.lines[0]?.subledgerType, "CASH_LOCATION");
  assert.equal(journal.lines[1]?.creditBase, "50000");
  assert.equal(journal.lines[1]?.subledgerType, "SHAREHOLDER_CAPITAL");
  assert.equal(fixture.repository.listPostingIntents().length, 1);
  assert.equal(fixture.repository.listJournals().length, 1);
});

test("posting retry and simultaneous attempts produce exactly one journal", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  const [first, second] = await Promise.all([
    post(fixture, receipt.id, "post-race"),
    post(fixture, receipt.id, "post-race")
  ]);
  assert.equal(second.id, first.id);
  assert.equal(fixture.repository.listJournals().length, 1);
  assert.equal(fixture.repository.listPostingIntents().length, 1);
});

test("two Zemar declarations remain distinct even with identical amount and currency", async () => {
  const fixture = setup([
    declaration("zemar-2026-10-06", "50000", "2026-10-06"),
    declaration("zemar-2026-10-07", "50000", "2026-10-07")
  ]);
  const first = await record(fixture, "zemar-2026-10-06", "50000", "zemar-one");
  const second = await record(fixture, "zemar-2026-10-07", "50000", "zemar-two");
  assert.notEqual(first.contributionId, second.contributionId);
  assert.equal((await fixture.service.summary(first.contributionId, reader)).receiptCount, 1);
  assert.equal((await fixture.service.summary(second.contributionId, reader)).receiptCount, 1);
});

test("legacy commitment and cancelled installment are never converted or mutated", async () => {
  const fixture = setup([declaration("hash-new", "20000", "2026-10-08")]);
  fixture.repository.seedLegacyCommitment("hash-legacy", "20000");
  fixture.repository.seedUntouchedInstallment("cancelled-5000", "CANCELLED");
  await record(fixture, "hash-new", "20000", "hash-new-receipt");
  assert.equal(fixture.repository.legacyCommitments.get("hash-legacy"), "20000");
  assert.equal(fixture.repository.untouchedInstallments.get("cancelled-5000"), "CANCELLED");
  assert.equal(fixture.repository.contributionCount(), 1);
});

test("partial and multiple receipts preserve exact outstanding amount", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  await record(fixture, "c1", "12500.25", "part-one");
  await record(fixture, "c1", "7499.75", "part-two");
  const summary = await fixture.service.summary("c1", reader);
  assert.equal(summary.received.amount, "20000");
  assert.equal(summary.outstanding.amount, "30000");
  assert.equal(summary.receiptCount, 2);
});

test("over-receipt and wrong currency fail before any state change", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  await record(fixture, "c1", "40000", "part-one");
  await expectCode(() => record(fixture, "c1", "10000.01", "too-much"), "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT");
  await expectCode(() => fixture.service.recordReceipt({ actor: recorder, contributionId: "c1",
    amount: { amount: "1" as DecimalString, currency: "AFN" }, receiptDate: "2026-10-09",
    treasuryDestinationId: "safe-usd", metadata: metadata("wrong-currency") }), "CURRENCY_MISMATCH");
  assert.equal((await fixture.service.summary("c1", reader)).received.amount, "40000");
});

test("authorization and legal-entity scope fail closed", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  await expectCode(() => fixture.service.recordReceipt({ actor: approver, contributionId: "c1",
    amount: money("1"), receiptDate: "2026-10-09", treasuryDestinationId: "safe-usd",
    metadata: metadata("no-treasury") }), "PERMISSION_DENIED");
  const receipt = await record(fixture, "c1", "50000", "record");
  await expectCode(() => decide(fixture, receipt.id, receipt.version, outsider, "APPROVE", "outside"), "SCOPE_MISMATCH");
});

test("rejection and pre-approval cancellation remain auditable and unposted", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const rejected = await record(fixture, "c1", "10000", "record-reject");
  await decide(fixture, rejected.id, rejected.version, approver, "REJECT", "reject", "Evidence incomplete");
  const pending = await record(fixture, "c1", "5000", "record-cancel");
  await fixture.service.cancelReceipt({ actor: recorder, receiptId: pending.id, expectedVersion: pending.version,
    reason: "Entry duplicated before approval", metadata: metadata("cancel") });
  assert.equal(fixture.repository.listJournals().length, 0);
  assert.deepEqual(fixture.repository.listAudit().map((entry) => entry.action), [
    "CAPITAL_RECEIPT_RECORDED", "CAPITAL_RECEIPT_REJECTED", "CAPITAL_RECEIPT_RECORDED", "CAPITAL_RECEIPT_CANCELLED"
  ]);
});

test("reversal creates a separate compensating journal and preserves the original", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  const original = await post(fixture, receipt.id, "post");
  fixture.repository.seedConfiguration({ ...config(), reversalPostingEnabled: true });
  fixture.repository.seedReversalDecision(reversalDecision(original.id));
  const reversal = await fixture.service.reverseReceipt({ actor: reverser, receiptId: receipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: { ...config(), reversalPostingEnabled: true }, ledgerAccounts: accounts(),
    reversalRequestId: "reversal-approved", metadata: metadata("reverse") });
  assert.equal(reversal.reversalOfJournalId, original.id);
  assert.equal(reversal.lines[0]?.creditBase, original.lines[0]?.debitBase);
  assert.equal(reversal.lines[1]?.debitBase, original.lines[1]?.creditBase);
  assert.equal(fixture.repository.listJournals().length, 2);
  assert.equal((await fixture.service.summary("c1", reader)).postingState, "REVERSED");
  assert.equal(fixture.repository.listSubledgerEntries().length, 4);
  assert.deepEqual(await fixture.repository.findJournal(original.id), original);
  const effects = fixture.repository.listSubledgerEntries();
  assert.equal(effects[2]?.reversalOfEntryId, effects[0]?.id);
});

test("posting refuses missing CoA mapping, closed periods and cross-currency valuation", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  await expectCode(() => fixture.service.postReceipt({ actor: approver, receiptId: receipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: { ...config(), paidInCapitalLedgerAccountId: null },
    ledgerAccounts: accounts(), metadata: metadata("missing-account") }), "POLICY_CONFIGURATION_PENDING");
  const closed = { ...config(), periodStatus: "CLOSED" as const };
  fixture.repository.seedConfiguration(closed);
  await expectCode(() => fixture.service.postReceipt({ actor: approver, receiptId: receipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: closed,
    ledgerAccounts: accounts(), metadata: metadata("closed-period") }), "ACCOUNTING_PERIOD_CLOSED");
});

test("audit history is complete while Treasury and document versions remain unchanged", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06", 7)]);
  fixture.repository.seedDocument("agreement-doc", 7);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  await post(fixture, receipt.id, "post");
  assert.deepEqual(fixture.repository.listAudit().map((entry) => entry.action), [
    "CAPITAL_RECEIPT_RECORDED", "CAPITAL_RECEIPT_APPROVED", "CAPITAL_RECEIPT_POSTED"
  ]);
  assert.equal(fixture.repository.treasuryMovements.length, 0);
  assert.equal(fixture.repository.documentVersions.get("agreement-doc"), 7);
});

test("forged caller permissions, synthetic provenance, revoked and expired sessions fail closed", async () => {
  const forged = setup([declaration("c1", "50000", "2026-10-06")]);
  await expectCode(() => forged.service.recordReceipt({
    actor: { ...approver, treasuryPermissions: ["treasury.cash-receipt.record"] },
    contributionId: "c1", amount: money("1"), receiptDate: "2026-10-09",
    treasuryDestinationId: "safe-usd", metadata: metadata("forged-grant")
  }), "PERMISSION_DENIED");

  const synthetic = setup([declaration("c1", "50000", "2026-10-06")]);
  synthetic.repository.seedSession(recorder, { provenance: "SYNTHETIC_TEST_ONLY" });
  await expectCode(() => record(synthetic, "c1", "1", "synthetic-session"), "PERMISSION_DENIED");

  const revoked = setup([declaration("c1", "50000", "2026-10-06")]);
  revoked.repository.revokeSession(recorder.sessionId!);
  await expectCode(() => record(revoked, "c1", "1", "revoked-session"), "AUTHENTICATION_REQUIRED");

  const expired = setup([declaration("c1", "50000", "2026-10-06")]);
  expired.repository.seedSession(recorder, { expiresAt: "2026-10-10T11:59:59.000Z" });
  await expectCode(() => record(expired, "c1", "1", "expired-session"), "AUTHENTICATION_REQUIRED");
});

test("a refreshed valid session may replay the same business request without duplicating it", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const first = await record(fixture, "c1", "100", "stable-request");
  fixture.repository.seedSession({ ...recorder, authenticatedAt: "2026-10-10T11:30:00.000Z" });
  const replay = await record(fixture, "c1", "100", "stable-request");
  assert.equal(replay.id, first.id);
  assert.equal((await fixture.service.summary("c1", reader)).receiptCount, 1);
});

test("concurrent receipts cannot over-allocate one declaration", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const results = await Promise.allSettled([
    record(fixture, "c1", "30000", "concurrent-one"),
    record(fixture, "c1", "30000", "concurrent-two")
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected"
    && result.reason instanceof FinanceDomainError
    && result.reason.code === "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT").length, 1);
  assert.equal((await fixture.service.summary("c1", reader)).received.amount, "30000");
});

test("posting revalidates the declaration fingerprint and authoritative accounting configuration", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  fixture.repository.seedContribution(declaration("c1", "49999", "2026-10-06"));
  await expectCode(() => post(fixture, receipt.id, "changed-source"), "POSTED_RECORD_IMMUTABLE");

  const mapping = setup([declaration("c1", "50000", "2026-10-06")]);
  const mappedReceipt = await record(mapping, "c1", "50000", "record");
  await decide(mapping, mappedReceipt.id, mappedReceipt.version, approver, "APPROVE", "approve");
  await expectCode(() => mapping.service.postReceipt({ actor: approver, receiptId: mappedReceipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: { ...config(), policyVersionId: "caller-injected" },
    ledgerAccounts: accounts(), metadata: metadata("caller-config") }), "POLICY_CONFIGURATION_PENDING");
});

test("receipt evidence policy and reversal policy both remain fail-closed", async () => {
  const evidenceRequired = setup([declaration("c1", "50000", "2026-10-06")]);
  evidenceRequired.repository.seedConfiguration({ ...config(), receiptEvidenceRequired: true });
  const receipt = await record(evidenceRequired, "c1", "50000", "record");
  await decide(evidenceRequired, receipt.id, receipt.version, approver, "APPROVE", "approve");
  await expectCode(() => evidenceRequired.service.postReceipt({ actor: approver, receiptId: receipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: { ...config(), receiptEvidenceRequired: true },
    ledgerAccounts: accounts(), metadata: metadata("missing-evidence") }), "EVIDENCE_REQUIRED");

  const reversalBlocked = setup([declaration("c2", "50000", "2026-10-06")]);
  const postedReceipt = await record(reversalBlocked, "c2", "50000", "record");
  await decide(reversalBlocked, postedReceipt.id, postedReceipt.version, approver, "APPROVE", "approve");
  const journal = await post(reversalBlocked, postedReceipt.id, "post");
  reversalBlocked.repository.seedReversalDecision(reversalDecision(journal.id));
  await expectCode(() => reversalBlocked.service.reverseReceipt({ actor: reverser, receiptId: postedReceipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: config(), ledgerAccounts: accounts(),
    reversalRequestId: "reversal-approved", metadata: metadata("blocked-reversal") }), "POLICY_CONFIGURATION_PENDING");
});

test("a reversed receipt cannot be reposted through its old or a new idempotency key", async () => {
  const fixture = setup([declaration("c1", "50000", "2026-10-06")]);
  const receipt = await record(fixture, "c1", "50000", "record");
  await decide(fixture, receipt.id, receipt.version, approver, "APPROVE", "approve");
  const original = await post(fixture, receipt.id, "post");
  fixture.repository.seedConfiguration({ ...config(), reversalPostingEnabled: true });
  fixture.repository.seedReversalDecision(reversalDecision(original.id));
  await fixture.service.reverseReceipt({ actor: reverser, receiptId: receipt.id,
    accountingEffectiveDate: "2026-10-10", configuration: { ...config(), reversalPostingEnabled: true },
    ledgerAccounts: accounts(), reversalRequestId: "reversal-approved", metadata: metadata("reverse") });
  await expectCode(() => post(fixture, receipt.id, "post"), "POSTED_RECORD_IMMUTABLE");
  await expectCode(() => post(fixture, receipt.id, "new-post-key"), "POSTED_RECORD_IMMUTABLE");
  assert.equal(fixture.repository.listJournals().length, 2);
});

function setup(contributions: readonly CapitalContributionDeclaration[]) {
  const repository = new InMemoryShareholderCapitalBridgeRepository();
  for (const who of [recorder, approver, reverser, reader, requester, dualRecorder, outsider]) repository.seedActor(who);
  repository.seedDestination(destination());
  repository.seedConfiguration(config());
  for (const account of accounts().values()) repository.seedLedgerAccount(account);
  repository.seedEvidence(entity, evidence("evidence-reversal", "REVERSAL_REASON"));
  repository.seedEvidence(entity, evidence("evidence-receipt", "CASH_RECEIPT"));
  for (const contribution of contributions) repository.seedContribution(contribution);
  let sequence = 0;
  const service = new ShareholderCapitalBridgeService(repository, () => "2026-10-10T12:00:00.000Z", () => `bridge-${++sequence}`);
  return { repository, service };
}

async function record(fixture: ReturnType<typeof setup>, contributionId: string, amount: string, key: string) {
  return fixture.service.recordReceipt({ actor: recorder, contributionId, amount: money(amount), receiptDate: "2026-10-09",
    treasuryDestinationId: "safe-usd", paymentReference: `REF-${key}`, metadata: metadata(key) });
}

async function decide(fixture: ReturnType<typeof setup>, receiptId: string, expectedVersion: number,
  who: ServerActorContext, decision: "APPROVE" | "REJECT", key: string, reason?: string) {
  return fixture.service.decideReceipt({ actor: who, receiptId, expectedVersion, decision,
    ...(reason === undefined ? {} : { reason }), metadata: metadata(key) });
}

async function post(fixture: ReturnType<typeof setup>, receiptId: string, key: string) {
  return fixture.service.postReceipt({ actor: approver, receiptId, accountingEffectiveDate: "2026-10-10",
    configuration: config(), ledgerAccounts: accounts(), metadata: metadata(key) });
}

function declaration(id: string, amount: string, businessDate: string, documentVersion: number | null = null): CapitalContributionDeclaration {
  return { id, legalEntityId: entity, shareholderProfileId: `shareholder-${id}`, contributionType: "CASH",
    recordStatus: "DECLARED", businessDate, amount: money(amount), documentVersion, sourceModel: "CONTRIBUTION_0035" };
}

function config(): CapitalReceiptPostingConfiguration {
  return { legalEntityId: entity, baseCurrency: "USD", policyVersionId: "review-only-v1",
    accountingPeriodId: period, periodStatus: "OPEN", periodStartsOn: "2026-10-01", periodEndsOn: "2026-10-31",
    receivingLedgerAccountId: cashAccount, paidInCapitalLedgerAccountId: capitalAccount,
    treasuryDestinationId: "safe-usd", paidInEquityRecognitionApproved: true,
    receiptEvidenceRequired: false, reversalPostingEnabled: false };
}

function accounts(): ReadonlyMap<LedgerAccountId, BridgeLedgerAccount> {
  return new Map([
    [cashAccount, { id: cashAccount, legalEntityId: entity, status: "ACTIVE", postable: true,
      currency: "USD", accountType: "ASSET", controlType: "CASH" }],
    [capitalAccount, { id: capitalAccount, legalEntityId: entity, status: "ACTIVE", postable: true,
      currency: "USD", accountType: "EQUITY", controlType: "SHAREHOLDER_CAPITAL" }]
  ]);
}

function destination(): BridgeDestination {
  return { id: "safe-usd", legalEntityId: entity, currency: "USD", status: "ACTIVE",
    ledgerAccountId: cashAccount, openingPositionApproved: true, destinationType: "CASH_LOCATION" };
}

function evidence(id: string, kind: EvidenceReference["kind"]): EvidenceReference {
  return { id: id as EvidenceReferenceId, documentId: `document-${id}` as DocumentId,
    kind, version: 1, sha256: "a".repeat(64), completedAt: "2026-10-09T10:00:00.000Z" };
}

function reversalDecision(journalId: BridgeReversalDecision["originalJournalId"]): BridgeReversalDecision {
  return { id: "reversal-approved", legalEntityId: entity, originalJournalId: journalId,
    requestedBy: requester.userAccountId, approvedBy: reverser.userAccountId,
    status: "APPROVED", reason: "Approved correction", evidenceReferenceId: "evidence-reversal",
    accountingPeriodId: period, accountingEffectiveDate: "2026-10-10" };
}

function actor(name: string, permissions: ServerActorContext["permissions"], treasuryPermissions: NonNullable<ServerActorContext["treasuryPermissions"]> = [], scope = entity): ServerActorContext {
  return { userAccountId: actorId(name), permissions, treasuryPermissions, legalEntityIds: [scope], projectIds: [],
    departmentIds: [], authenticatedAt: "2026-10-10T11:00:00.000Z", sessionId: `session-${name}` };
}

function actorId(name: string): UserAccountId { return name as UserAccountId; }
function money(amount: string) { return { amount: amount as DecimalString, currency: "USD" as const }; }
function metadata(key: string) { return { idempotencyKey: key as IdempotencyKey, correlationId: `correlation-${key}` as CorrelationId }; }

async function expectCode(action: () => Promise<unknown>, code: FinanceDomainError["code"]) {
  await assert.rejects(action, (error: unknown) => error instanceof FinanceDomainError && error.code === code);
}
