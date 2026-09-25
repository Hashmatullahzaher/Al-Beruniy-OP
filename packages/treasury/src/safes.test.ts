import assert from "node:assert/strict";
import test from "node:test";
import type { CashLocationCurrencyAccountId, CashLocationId, LegalEntityId, TreasuryPermission, UserAccountId } from "@abos/contracts";
import { TreasuryDomainError } from "./errors.ts";
import type { TreasuryRepository } from "./repository.ts";
import { TreasurySafesService, type SafeCountRecord, type SarafAccountRecord, type TreasurySafesRepository } from "./safes.ts";
import type { CashAccountRecord, TreasuryActor } from "./types.ts";

// Every value below is synthetic.
const ENTITY = "le-synthetic-001" as LegalEntityId;
const SAFE = "safe-synthetic-1" as CashLocationId;
const USD_ACCOUNT = "acct-usd-1" as CashLocationCurrencyAccountId;

function actor(id: string, permissions: readonly string[]): TreasuryActor {
  return { userAccountId: id as UserAccountId, legalEntityId: ENTITY, sessionId: "s", treasuryPermissions: permissions as readonly TreasuryPermission[] };
}

function build(options: { openingApproved?: boolean; saraf?: SarafAccountRecord[]; counts?: SafeCountRecord[] } = {}) {
  const calls: string[] = [];
  const account: CashAccountRecord = { id: USD_ACCOUNT, legalEntityId: ENTITY, cashLocationId: SAFE, currency: "USD", ledgerAccountId: "l-usd", status: "ACTIVE" };
  const treasury = {
    findLocation: async () => ({ id: SAFE, legalEntityId: ENTITY, name: "Synthetic Safe", kind: "OFFICE_SAFE", status: "ACTIVE", responsibleCashierUserAccountId: "c" }),
    listAccounts: async () => [],
    findAccount: async () => account,
    findOpening: async () => (options.openingApproved === false ? undefined : { status: "APPROVED" }),
    openAccount: async () => { calls.push("openAccount"); }
  } as unknown as TreasuryRepository;
  const safes: TreasurySafesRepository = {
    listCashLedgerChoices: async () => [
      { id: "l-usd", accountCode: "1010-USD", accountName: "Synthetic cash USD", currency: "USD" },
      { id: "l-afn", accountCode: "1011-AFN", accountName: "Synthetic cash AFN", currency: "AFN" }
    ],
    listSarafLedgerChoices: async () => [{ id: "s-usd", accountCode: "2300-USD", accountName: "Synthetic Saraf USD", currency: "USD" }],
    listSarafParties: async () => [{ id: "party-saraf", displayName: "Synthetic Saraf" }],
    listSarafAccounts: async () => options.saraf ?? [],
    findSarafAccount: async (_entity, id) => (options.saraf ?? []).find((item) => item.id === id),
    listSafeCounts: async () => options.counts ?? [],
    findSafeCount: async (_entity, id) => (options.counts ?? []).find((item) => item.id === id),
    listCountEvidence: async () => [
      { id: "ev-free", kind: "PHYSICAL_CASH_COUNT", documentId: "d", version: 1, sha256: "0".repeat(64), createdAt: "", used: false },
      { id: "ev-used", kind: "PHYSICAL_CASH_COUNT", documentId: "d", version: 1, sha256: "0".repeat(64), createdAt: "", used: true }
    ],
    listPhysicalCounts: async () => [],
    blockAccount: async () => { calls.push("block"); },
    createSarafAccount: async () => { calls.push("createSaraf"); },
    activateSarafAccount: async () => { calls.push("activateSaraf"); },
    deactivateSarafAccount: async () => { calls.push("deactivateSaraf"); },
    recordSafeCount: async () => { calls.push("recordSafeCount"); },
    confirmSafeCount: async () => { calls.push("confirmSafeCount"); }
  };
  return { service: new TreasurySafesService(safes, treasury, () => "new-id"), calls };
}

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof TreasuryDomainError && error.code === code);
}

const manager = actor("manager", ["treasury.read", "treasury.cash-location.manage", "treasury.saraf-account.manage"]);
const counter = actor("counter", ["treasury.read", "treasury.cash-count.record"]);
const approver = actor("approver", ["treasury.read", "treasury.cash-account.approve", "treasury.saraf-account.manage"]);

test("a safe account links only a chosen CASH ledger account of its own currency", async () => {
  const { service, calls } = build();
  await refused(service.openCurrencyAccount(manager, { cashLocationId: SAFE, currency: "AFN", ledgerAccountId: "l-usd" }), "CURRENCY_MISMATCH");
  await refused(service.openCurrencyAccount(manager, { cashLocationId: SAFE, currency: "USD", ledgerAccountId: "s-usd" }), "POLICY_CONFIGURATION_PENDING");
  await refused(service.openCurrencyAccount(counter, { cashLocationId: SAFE, currency: "USD", ledgerAccountId: "l-usd" }), "PERMISSION_DENIED");
  assert.equal(await service.openCurrencyAccount(manager, { cashLocationId: SAFE, currency: "AFN", ledgerAccountId: "l-afn" }), "new-id");
  assert.deepEqual(calls, ["openAccount"]);
});

test("a Saraf account needs a SARAF ledger account in its currency and is activated by someone other than its creator", async () => {
  const draft: SarafAccountRecord = {
    id: "saraf-1", legalEntityId: ENTITY, businessPartyId: "party-saraf", partyName: "Synthetic Saraf", currency: "USD",
    ledgerAccountId: "s-usd", ledgerAccountCode: "2300-USD", ledgerAccountName: "x", status: "DRAFT",
    createdByUserAccountId: "manager" as UserAccountId, createdByName: "m", createdAt: ""
  };
  const { service, calls } = build({ saraf: [draft] });
  await refused(service.createSarafAccount(manager, { businessPartyId: "party-saraf", currency: "USD", ledgerAccountId: "l-usd" }), "POLICY_CONFIGURATION_PENDING");
  await refused(service.createSarafAccount(manager, { businessPartyId: "party-saraf", currency: "AFN", ledgerAccountId: "s-usd" }), "CURRENCY_MISMATCH");
  await refused(service.createSarafAccount(manager, { businessPartyId: "party-other", currency: "USD", ledgerAccountId: "s-usd" }), "NOT_FOUND");
  await refused(service.createSarafAccount(manager, { businessPartyId: "party-saraf", currency: "USD", ledgerAccountId: "s-usd" }), "IDEMPOTENCY_CONFLICT");
  await refused(service.createSarafAccount(counter, { businessPartyId: "party-saraf", currency: "USD", ledgerAccountId: "s-usd" }), "PERMISSION_DENIED");
  await refused(service.activateSarafAccount(manager, "saraf-1"), "SEGREGATION_OF_DUTIES_VIOLATION");
  await service.activateSarafAccount(approver, "saraf-1");
  assert.deepEqual(calls, ["activateSaraf"]);
});

test("a whole-safe count needs an approved opening and unused count evidence, and is confirmed by someone else", async () => {
  const recorded: SafeCountRecord = {
    id: "count-1", legalEntityId: ENTITY, cashAccountId: USD_ACCOUNT, cashLocationId: SAFE, currency: "USD",
    countedAmount: "10", countedAt: "", countedByUserAccountId: "approver" as UserAccountId, countedByName: "a",
    evidenceReferenceId: "ev", openingAmount: "0", verifiedReceiptsAmount: "0", verifiedReceiptCount: 0,
    unverifiedReceiptCount: 0, custodyTotal: "0", difference: "10", status: "RECORDED"
  };
  await refused(build({ openingApproved: false }).service.recordSafeCount(counter, { cashAccountId: USD_ACCOUNT, countedAmount: "1", evidenceReferenceId: "ev-free" }), "OPENING_POSITION_NOT_APPROVED");
  const { service, calls } = build({ counts: [recorded] });
  await refused(service.recordSafeCount(counter, { cashAccountId: USD_ACCOUNT, countedAmount: "1.1234567", evidenceReferenceId: "ev-free" }), "CURRENCY_MISMATCH");
  await refused(service.recordSafeCount(counter, { cashAccountId: USD_ACCOUNT, countedAmount: "1", evidenceReferenceId: "ev-used" }), "IDEMPOTENCY_CONFLICT");
  await refused(service.recordSafeCount(counter, { cashAccountId: USD_ACCOUNT, countedAmount: "1", evidenceReferenceId: "ev-missing" }), "EVIDENCE_REQUIRED");
  await refused(service.recordSafeCount(approver, { cashAccountId: USD_ACCOUNT, countedAmount: "1", evidenceReferenceId: "ev-free" }), "PERMISSION_DENIED");
  assert.equal(await service.recordSafeCount(counter, { cashAccountId: USD_ACCOUNT, countedAmount: "1", evidenceReferenceId: "ev-free" }), "new-id");
  await refused(service.confirmSafeCount(approver, "count-1"), "SEGREGATION_OF_DUTIES_VIOLATION");
  await refused(service.confirmSafeCount(counter, "count-1"), "PERMISSION_DENIED");
  assert.deepEqual(calls, ["recordSafeCount"]);
});
