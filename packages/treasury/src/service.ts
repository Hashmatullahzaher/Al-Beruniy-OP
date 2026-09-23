import { randomUUID } from "node:crypto";
import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  PhysicalCashCountId,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";
import { assertTreasury } from "./errors.ts";
import {
  assertAccountCanReceive,
  assertAmount,
  assertAssignedCashier,
  assertCountCoversReceipt,
  assertIndependentVerifier,
  assertOpeningApprover,
  assertReceiptStatus,
  assertSourceCanBeReceived,
  requirePermission
} from "./policy.ts";
import type { TreasuryRepository } from "./repository.ts";
import type { TreasuryActor, TreasuryReceipt } from "./types.ts";

/**
 * The Treasury workflow.
 *
 *   capital receipt intent (Shareholder, ELIGIBLE)
 *     -> recordReceipt          assigned cashier, cash physically received
 *     -> countReceipt           physical count and evidence recorded
 *     -> submitForVerification  cashier releases it for independent review
 *     -> verifyReceipt          independent verifier confirms the count and the receipt
 *     -> handOffToFinance       shareholder intent becomes TREASURY_VERIFIED; Finance may now act
 *
 * What this service cannot do, structurally: post a journal (there is no such method on its
 * repository and no Finance dependency in this package), increase a balance (Treasury does not
 * keep one - it keeps counts and receipts), or choose the amount of a capital receipt (the
 * amount, currency and destination come from the shareholder intent).
 */
export class TreasuryService {
  private readonly repository: TreasuryRepository;
  private readonly newId: () => string;

  constructor(repository: TreasuryRepository, newId: () => string = () => randomUUID()) {
    this.repository = repository;
    this.newId = newId;
  }

  // ---------------------------------------------------------------- safes and accounts

  async createOfficeSafe(actor: TreasuryActor, input: {
    readonly name: string;
    readonly responsibleCashierUserAccountId: UserAccountId;
  }): Promise<CashLocationId> {
    requirePermission(actor, "treasury.cash-location.manage");
    assertTreasury(input.name.trim().length >= 3, "EVIDENCE_REQUIRED", "A safe needs a descriptive name");
    const id = this.newId() as CashLocationId;
    await this.repository.createLocation(actor, { id, name: input.name.trim(), responsibleCashierUserAccountId: input.responsibleCashierUserAccountId });
    return id;
  }

  async activateSafe(actor: TreasuryActor, id: CashLocationId): Promise<void> {
    requirePermission(actor, "treasury.cash-location.manage");
    const location = await this.repository.findLocation(actor.legalEntityId, id);
    assertTreasury(location, "NOT_FOUND", "The cash location does not exist");
    await this.repository.setLocationStatus(actor, id, "ACTIVE");
  }

  /**
   * Opens one currency account inside a safe. USD and AFN are opened separately and each has its
   * own lifecycle; opening one never activates the other.
   */
  async openCurrencyAccount(actor: TreasuryActor, input: {
    readonly cashLocationId: CashLocationId;
    readonly currency: SupportedCurrency;
  }): Promise<CashLocationCurrencyAccountId> {
    requirePermission(actor, "treasury.cash-location.manage");
    const location = await this.repository.findLocation(actor.legalEntityId, input.cashLocationId);
    assertTreasury(location, "NOT_FOUND", "The cash location does not exist");
    const existing = await this.repository.listAccounts(actor.legalEntityId, input.cashLocationId);
    assertTreasury(
      !existing.some((account) => account.currency === input.currency),
      "IDEMPOTENCY_CONFLICT",
      `${location.name} already has a ${input.currency} account`
    );
    const ledgerAccountId = await this.repository.findFinanceCashLedgerAccount(actor.legalEntityId, input.currency);
    assertTreasury(
      ledgerAccountId,
      "POLICY_CONFIGURATION_PENDING",
      `Finance has not configured a ${input.currency} cash ledger account; Treasury does not create one`
    );
    const id = this.newId() as CashLocationCurrencyAccountId;
    await this.repository.openAccount(actor, { id, cashLocationId: input.cashLocationId, currency: input.currency, ledgerAccountId });
    return id;
  }

  async assignCashier(actor: TreasuryActor, input: {
    readonly cashLocationId: CashLocationId;
    readonly userAccountId: UserAccountId;
  }): Promise<string> {
    requirePermission(actor, "treasury.cash-location.manage");
    assertTreasury(
      input.userAccountId !== actor.userAccountId,
      "SEGREGATION_OF_DUTIES_VIOLATION",
      "Nobody can assign themselves custody of cash"
    );
    const assignments = await this.repository.listAssignments(actor.legalEntityId, input.cashLocationId);
    assertTreasury(
      !assignments.some((item) => item.userAccountId === input.userAccountId && item.revokedAt === undefined),
      "IDEMPOTENCY_CONFLICT",
      "This user is already an assigned cashier of this safe"
    );
    const id = this.newId();
    await this.repository.assignCashier(actor, { id, cashLocationId: input.cashLocationId, userAccountId: input.userAccountId });
    return id;
  }

  async revokeCashier(actor: TreasuryActor, assignmentId: string): Promise<void> {
    requirePermission(actor, "treasury.cash-location.manage");
    await this.repository.revokeCashier(actor, assignmentId);
  }

  // ---------------------------------------------------------------- opening reconciliation

  /** The counter records what is physically in the safe. Nothing is assumed or defaulted. */
  async recordOpeningCount(actor: TreasuryActor, input: {
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly countedAmount: string;
    readonly evidenceReferenceId: string;
  }): Promise<PhysicalCashCountId> {
    requirePermission(actor, "treasury.cash-count.record");
    assertAmount(input.countedAmount, "The opening count");
    const account = await this.repository.findAccount(actor.legalEntityId, input.cashAccountId);
    assertTreasury(account, "NOT_FOUND", "The cash account does not exist");
    assertTreasury(account.status === "DRAFT", "OPENING_POSITION_NOT_APPROVED", `The account is already ${account.status}`);
    const id = this.newId() as PhysicalCashCountId;
    await this.repository.recordCount(actor, {
      id, cashAccountId: account.id, currency: account.currency,
      countedAmount: input.countedAmount, evidenceReferenceId: input.evidenceReferenceId, purpose: "OPENING"
    });
    return id;
  }

  async confirmOpeningCount(actor: TreasuryActor, countId: PhysicalCashCountId): Promise<void> {
    requirePermission(actor, "treasury.cash-account.approve");
    const count = await this.repository.findCount(actor.legalEntityId, countId);
    assertTreasury(count, "NOT_FOUND", "The physical cash count does not exist");
    assertTreasury(count.purpose === "OPENING", "SCOPE_MISMATCH", "This is not an opening count");
    assertTreasury(
      count.countedByUserAccountId !== actor.userAccountId,
      "SEGREGATION_OF_DUTIES_VIOLATION",
      "The person who counted the cash cannot confirm the count"
    );
    await this.repository.confirmCount(actor, countId);
  }

  async reconcileOpening(actor: TreasuryActor, input: {
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly physicalCashCountId: PhysicalCashCountId;
    readonly reconciliationEvidenceReferenceId: string;
  }): Promise<void> {
    requirePermission(actor, "treasury.cash-account.reconcile");
    const account = await this.repository.findAccount(actor.legalEntityId, input.cashAccountId);
    assertTreasury(account, "NOT_FOUND", "The cash account does not exist");
    const count = await this.repository.findCount(actor.legalEntityId, input.physicalCashCountId);
    assertTreasury(
      count && count.purpose === "OPENING" && count.status === "CONFIRMED" && count.cashAccountId === account.id,
      "OPENING_POSITION_NOT_APPROVED",
      "An opening is reconciled against a confirmed opening count of this same account"
    );
    await this.repository.reconcileOpening(actor, {
      cashAccountId: account.id, currency: account.currency, openingCountedAmount: count.countedAmount,
      physicalCashCountId: count.id, reconciliationEvidenceReferenceId: input.reconciliationEvidenceReferenceId
    });
  }

  async approveOpening(actor: TreasuryActor, cashAccountId: CashLocationCurrencyAccountId): Promise<void> {
    requirePermission(actor, "treasury.cash-account.approve");
    const opening = await this.repository.findOpening(actor.legalEntityId, cashAccountId);
    assertTreasury(opening, "OPENING_POSITION_NOT_APPROVED", "The opening position has not been reconciled");
    const count = await this.repository.findCount(actor.legalEntityId, opening.physicalCashCountId);
    assertTreasury(count, "EVIDENCE_REQUIRED", "The opening count is missing");
    assertOpeningApprover(actor, opening.reconciledByUserAccountId, count.countedByUserAccountId);
    await this.repository.approveOpening(actor, cashAccountId);
  }

  async activateAccount(actor: TreasuryActor, cashAccountId: CashLocationCurrencyAccountId): Promise<void> {
    requirePermission(actor, "treasury.cash-account.approve");
    const opening = await this.repository.findOpening(actor.legalEntityId, cashAccountId);
    assertTreasury(opening?.status === "APPROVED", "OPENING_POSITION_NOT_APPROVED", "The opening position is not approved");
    assertTreasury(
      opening.reconciledByUserAccountId !== actor.userAccountId,
      "SEGREGATION_OF_DUTIES_VIOLATION",
      "The person who reconciled the opening position cannot activate the account"
    );
    await this.repository.activateAccount(actor, cashAccountId, opening.reconciliationEvidenceReferenceId);
  }

  // ---------------------------------------------------------------- receipts

  /**
   * Step 3 of the E1 workflow: an assigned cashier records that the cash was physically received.
   * The amount, currency and destination are the shareholder intent's; the caller cannot supply
   * different ones.
   */
  async recordReceipt(actor: TreasuryActor, input: {
    readonly capitalReceiptIntentId: CapitalReceiptIntentId;
    readonly receiptReference: string;
    readonly businessEventAt: string;
  }): Promise<CashReceiptId> {
    requirePermission(actor, "treasury.cash-receipt.record");
    const source = await this.repository.findSource(actor.legalEntityId, input.capitalReceiptIntentId);
    assertTreasury(source, "NOT_FOUND", "The shareholder capital receipt intent does not exist");
    const account = await this.repository.findAccount(actor.legalEntityId, source.destinationCashAccountId);
    const location = account ? await this.repository.findLocation(actor.legalEntityId, account.cashLocationId) : undefined;
    assertAccountCanReceive(account, location);
    assertSourceCanBeReceived(source, account);
    const cashiers = await this.repository.listAssignments(actor.legalEntityId, account.cashLocationId);
    assertAssignedCashier(actor, cashiers.filter((item) => item.revokedAt === undefined).map((item) => item.userAccountId));
    assertTreasury(input.receiptReference.trim().length > 0, "EVIDENCE_REQUIRED", "A receipt reference is required");
    assertTreasury(!Number.isNaN(Date.parse(input.businessEventAt)), "EVIDENCE_REQUIRED", "When the cash was received must be recorded");
    const live = (await this.repository.listReceipts(actor.legalEntityId))
      .find((item) => item.capitalReceiptIntentId === source.id && item.status !== "VOIDED");
    assertTreasury(!live, "IDEMPOTENCY_CONFLICT", "This capital receipt intent already has a live Treasury receipt");
    const id = this.newId() as CashReceiptId;
    await this.repository.recordReceipt(actor, { id, source, receiptReference: input.receiptReference.trim(), businessEventAt: input.businessEventAt });
    return id;
  }

  /** Step 4: the physical count and its evidence. */
  async countReceipt(actor: TreasuryActor, input: {
    readonly receiptId: CashReceiptId;
    readonly countedAmount: string;
    readonly countEvidenceReferenceId: string;
    readonly receiptEvidenceReferenceId: string;
  }): Promise<PhysicalCashCountId> {
    requirePermission(actor, "treasury.cash-count.record");
    const receipt = await this.repository.findReceipt(actor.legalEntityId, input.receiptId);
    assertReceiptStatus(receipt, "DRAFT", "count this receipt");
    const cashiers = await this.repository.listAssignments(actor.legalEntityId, receipt.cashLocationId);
    assertAssignedCashier(actor, cashiers.filter((item) => item.revokedAt === undefined).map((item) => item.userAccountId));
    assertCountCoversReceipt(input.countedAmount, receipt.amount.amount);
    assertTreasury(input.countEvidenceReferenceId.trim().length > 0, "EVIDENCE_REQUIRED", "Count evidence is required");
    assertTreasury(input.receiptEvidenceReferenceId.trim().length > 0, "EVIDENCE_REQUIRED", "Receipt evidence is required");
    const countId = this.newId() as PhysicalCashCountId;
    await this.repository.countReceipt(actor, {
      receiptId: receipt.id,
      count: {
        id: countId, cashAccountId: receipt.cashAccountId, currency: receipt.amount.currency,
        countedAmount: input.countedAmount, evidenceReferenceId: input.countEvidenceReferenceId
      },
      receiptEvidenceReferenceId: input.receiptEvidenceReferenceId
    });
    return countId;
  }

  async submitForVerification(actor: TreasuryActor, receiptId: CashReceiptId): Promise<void> {
    requirePermission(actor, "treasury.cash-receipt.record");
    const receipt = await this.repository.findReceipt(actor.legalEntityId, receiptId);
    assertReceiptStatus(receipt, "COUNTED", "submit this receipt");
    assertTreasury(receipt.submittedForVerificationAt === undefined, "IDEMPOTENCY_CONFLICT", "This receipt is already awaiting verification");
    assertTreasury(
      receipt.receivedByUserAccountId === actor.userAccountId,
      "PERMISSION_DENIED",
      "Only the cashier who received the cash submits it for verification"
    );
    await this.repository.submitForVerification(actor, receiptId);
  }

  /** Step 5 and 6: an independent verifier confirms the count and the receipt becomes VERIFIED. */
  async verifyReceipt(actor: TreasuryActor, receiptId: CashReceiptId): Promise<void> {
    requirePermission(actor, "treasury.cash-receipt.verify");
    const receipt = await this.repository.findReceipt(actor.legalEntityId, receiptId);
    assertReceiptStatus(receipt, "COUNTED", "verify this receipt");
    assertTreasury(
      receipt.submittedForVerificationAt !== undefined,
      "TREASURY_RECEIPT_NOT_VERIFIED",
      "The cashier has not submitted this receipt for verification"
    );
    const count = receipt.physicalCashCountId === undefined
      ? undefined
      : await this.repository.findCount(actor.legalEntityId, receipt.physicalCashCountId);
    assertIndependentVerifier(actor, receipt, count);
    assertCountCoversReceipt(count.countedAmount, receipt.amount.amount);
    await this.repository.verifyReceipt(actor, receiptId, count.id);
  }

  async voidReceipt(actor: TreasuryActor, receiptId: CashReceiptId, reason: string): Promise<void> {
    const receipt = await this.repository.findReceipt(actor.legalEntityId, receiptId);
    assertTreasury(receipt, "NOT_FOUND", "The cash receipt does not exist");
    assertTreasury(
      receipt.status === "DRAFT" || receipt.status === "COUNTED",
      "POSTED_RECORD_IMMUTABLE",
      `A ${receipt.status} receipt cannot be voided`
    );
    const isCashier = receipt.receivedByUserAccountId === actor.userAccountId;
    assertTreasury(
      isCashier || actor.treasuryPermissions.includes("treasury.cash-receipt.verify"),
      "PERMISSION_DENIED",
      "Only the receiving cashier or a Treasury verifier can void a receipt"
    );
    assertTreasury(reason.trim().length >= 5, "EVIDENCE_REQUIRED", "A void needs a stated reason");
    await this.repository.voidReceipt(actor, receiptId, reason.trim());
  }

  /**
   * Step 7: hand the verified receipt to Finance. This records the shareholder intent as
   * TREASURY_VERIFIED and writes the handoff, in one transaction. It does not create a posting
   * intent, an approval or a journal - those are Finance's, and Finance may still refuse.
   */
  async handOffToFinance(actor: TreasuryActor, input: {
    readonly receiptId: CashReceiptId;
    readonly correlationId?: string;
  }): Promise<string> {
    requirePermission(actor, "treasury.handoff.create");
    const receipt = await this.repository.findReceipt(actor.legalEntityId, input.receiptId);
    assertReceiptStatus(receipt, "VERIFIED", "hand this receipt to Finance");
    const existing = await this.repository.findHandoff(actor.legalEntityId, receipt.id);
    assertTreasury(!existing, "IDEMPOTENCY_CONFLICT", "This receipt has already been handed to Finance");
    const count = receipt.physicalCashCountId === undefined
      ? undefined
      : await this.repository.findCount(actor.legalEntityId, receipt.physicalCashCountId);
    assertTreasury(count?.status === "CONFIRMED", "EVIDENCE_REQUIRED", "The receipt's count is not confirmed");
    const source = await this.repository.findSource(actor.legalEntityId, receipt.capitalReceiptIntentId);
    assertTreasury(source?.status === "ELIGIBLE", "CAPITAL_AGREEMENT_REQUIRED", "The shareholder intent is no longer ELIGIBLE");
    const id = this.newId();
    await this.repository.handOffToFinance(actor, {
      id, receipt, count, correlationId: input.correlationId ?? this.newId()
    });
    return id;
  }

  async trace(actor: TreasuryActor, receiptId: CashReceiptId) {
    requirePermission(actor, "treasury.read");
    const trace = await this.repository.trace(actor.legalEntityId, receiptId);
    assertTreasury(trace, "NOT_FOUND", "The cash receipt does not exist");
    return trace;
  }
}

export type { TreasuryReceipt };
