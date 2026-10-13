import { createHash, randomUUID } from "node:crypto";

import type {
  CapitalBridgeAuditEntry,
  CapitalContributionDeclaration,
  CapitalContributionFinanceSummary,
  CapitalReceiptPostingConfiguration,
  CapitalReceiptPostingIntentRecord,
  CapitalReceiptRecord,
  CorrelationId,
  DecimalString,
  EvidenceReference,
  IdempotencyKey,
  JournalId,
  JournalLineDraft,
  LedgerAccountId,
  LegalEntityId,
  PostedJournal,
  ServerActorContext,
  UserAccountId
} from "@abos/contracts";

import { ExactDecimal } from "./decimal.ts";
import { assertFinance } from "./errors.ts";
import type { LedgerAccountPolicy } from "./journal.ts";
import { validateJournalLines } from "./journal.ts";

export interface CapitalBridgeRequestMetadata {
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: CorrelationId;
}

export interface RecordCapitalReceiptCommand {
  readonly actor: ServerActorContext;
  readonly contributionId: string;
  readonly amount: CapitalReceiptRecord["amount"];
  readonly receiptDate: string;
  readonly treasuryDestinationId: string;
  readonly paymentReference?: string | null;
  readonly evidenceReferenceId?: string | null;
  readonly metadata: CapitalBridgeRequestMetadata;
}

export interface DecideCapitalReceiptCommand {
  readonly actor: ServerActorContext;
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly metadata: CapitalBridgeRequestMetadata;
  readonly decision: "APPROVE" | "REJECT";
  readonly reason?: string;
}

export interface PostCapitalContributionReceiptCommand {
  readonly actor: ServerActorContext;
  readonly receiptId: string;
  readonly accountingEffectiveDate: string;
  readonly configuration: CapitalReceiptPostingConfiguration;
  readonly ledgerAccounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
  readonly metadata: CapitalBridgeRequestMetadata;
}

export interface ReverseCapitalContributionReceiptCommand {
  readonly actor: ServerActorContext;
  readonly receiptId: string;
  readonly accountingEffectiveDate: string;
  readonly configuration: CapitalReceiptPostingConfiguration;
  readonly ledgerAccounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
  readonly reversalRequestId: string;
  readonly metadata: CapitalBridgeRequestMetadata;
}

export interface BridgeDestination {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly currency: "USD" | "AFN";
  readonly status: "ACTIVE" | "INACTIVE";
  readonly ledgerAccountId: LedgerAccountId;
  readonly openingPositionApproved: boolean;
  readonly destinationType: "CASH_LOCATION";
}

export interface BridgeLedgerAccount extends LedgerAccountPolicy {
  readonly currency: "USD" | "AFN";
  readonly accountType: "ASSET" | "EQUITY" | "LIABILITY" | "EXPENSE";
  readonly controlType: "CASH" | "SHAREHOLDER_CAPITAL" | "OTHER";
}

export interface BridgeReversalDecision {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly originalJournalId: JournalId;
  readonly requestedBy: UserAccountId;
  readonly approvedBy: UserAccountId;
  readonly status: "APPROVED" | "PENDING" | "REJECTED";
  readonly reason: string;
  readonly evidenceReferenceId: string;
  readonly accountingPeriodId: CapitalReceiptPostingConfiguration["accountingPeriodId"];
  readonly accountingEffectiveDate: string;
}

export type BridgeOperation = "RECORD" | "DECIDE" | "CANCEL" | "POST" | "REVERSE";
interface IdempotencyResult<T> { readonly requestHash: string; readonly value: T; }

/**
 * Review-only kernel boundary. Only the memory adapter exists. No API/runtime uses this kernel.
 * The schema proposal describes future transaction/row-lock equivalents; those need independent
 * review and separate migration authorization. Caller actor/configuration are assertions only;
 * the repository must independently resolve current identity, policy and source configuration.
 */
export interface ShareholderCapitalBridgeRepository {
  readonly mode: "ISOLATED_MEMORY_REVIEW";
  exclusive<T>(action: () => Promise<T>): Promise<T>;
  authorize(actor: ServerActorContext, permission: string, legalEntityId: LegalEntityId, now: string): Promise<ServerActorContext>;
  findContribution(id: string): Promise<CapitalContributionDeclaration | undefined>;
  listReceipts(contributionId: string): Promise<readonly CapitalReceiptRecord[]>;
  findReceipt(id: string): Promise<CapitalReceiptRecord | undefined>;
  findDestination(id: string): Promise<BridgeDestination | undefined>;
  findEvidence(id: string): Promise<{ readonly legalEntityId: LegalEntityId; readonly reference: EvidenceReference } | undefined>;
  findConfiguration(entity: LegalEntityId, destinationId: string, periodId: CapitalReceiptPostingConfiguration["accountingPeriodId"]): Promise<CapitalReceiptPostingConfiguration | undefined>;
  findLedgerAccounts(entity: LegalEntityId): Promise<ReadonlyMap<LedgerAccountId, BridgeLedgerAccount>>;
  findReversalDecision(id: string): Promise<BridgeReversalDecision | undefined>;
  findJournal(id: JournalId): Promise<PostedJournal | undefined>;
  findJournalByReceipt(receiptId: string): Promise<PostedJournal | undefined>;
  findReversal(originalJournalId: JournalId): Promise<PostedJournal | undefined>;
  postingEffectiveDate(journalId: JournalId): Promise<string | undefined>;
  findIdempotency<T>(legalEntityId: string, operation: BridgeOperation, key: IdempotencyKey): Promise<IdempotencyResult<T> | undefined>;
  saveReceipt(receipt: CapitalReceiptRecord, audit: CapitalBridgeAuditEntry, idempotency: IdempotencyResult<CapitalReceiptRecord> & { readonly operation: BridgeOperation; readonly key: IdempotencyKey }): Promise<void>;
  replaceReceipt(receipt: CapitalReceiptRecord, expectedVersion: number, audit: CapitalBridgeAuditEntry, idempotency: IdempotencyResult<CapitalReceiptRecord> & { readonly operation: BridgeOperation; readonly key: IdempotencyKey }): Promise<void>;
  commitPosting(input: {
    readonly receipt: CapitalReceiptRecord;
    readonly expectedReceiptVersion: number;
    readonly postingIntent: CapitalReceiptPostingIntentRecord;
    readonly journal: PostedJournal;
    readonly accountingEffectiveDate: string;
    readonly audit: CapitalBridgeAuditEntry;
    readonly idempotency: IdempotencyResult<PostedJournal> & { readonly operation: "POST"; readonly key: IdempotencyKey };
  }): Promise<void>;
  commitReversal(input: {
    readonly receipt: CapitalReceiptRecord;
    readonly expectedReceiptVersion: number;
    readonly reversal: PostedJournal;
    readonly originalJournalId: JournalId;
    readonly accountingEffectiveDate: string;
    readonly decision: BridgeReversalDecision;
    readonly audit: CapitalBridgeAuditEntry;
    readonly idempotency: IdempotencyResult<PostedJournal> & { readonly operation: "REVERSE"; readonly key: IdempotencyKey };
  }): Promise<void>;
}

export class ShareholderCapitalBridgeService {
  private readonly repository: ShareholderCapitalBridgeRepository;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    repository: ShareholderCapitalBridgeRepository,
    now: () => string = () => new Date().toISOString(),
    newId: () => string = () => randomUUID()
  ) {
    assertFinance(repository.mode === "ISOLATED_MEMORY_REVIEW", "POLICY_CONFIGURATION_PENDING", "Bridge has no approved persistent runtime adapter");
    this.repository = repository;
    this.now = now;
    this.newId = newId;
  }

  async recordReceipt(command: RecordCapitalReceiptCommand): Promise<CapitalReceiptRecord> {
    return this.repository.exclusive(async () => {
      const contribution = await this.requiredContribution(command.contributionId);
      const actor = await this.authorize(command, "treasury.cash-receipt.record", contribution.legalEntityId);
      const normalizedAmount = { amount: positive(command.amount.amount).toString() as DecimalString, currency: command.amount.currency };
      const requestHash = hash({ contributionId: contribution.id, amount: normalizedAmount,
        receiptDate: command.receiptDate, treasuryDestinationId: command.treasuryDestinationId,
        paymentReference: clean(command.paymentReference), evidenceReferenceId: clean(command.evidenceReferenceId), actorId: actor.userAccountId });
      const replay = await this.repository.findIdempotency<CapitalReceiptRecord>(
        contribution.legalEntityId,
        "RECORD",
        command.metadata.idempotencyKey
      );
      if (replay) return replayValue(replay, requestHash);

      assertFinance(contribution.sourceModel === "CONTRIBUTION_0035", "SCOPE_MISMATCH", "Only a 0035 contribution declaration may enter this bridge");
      assertFinance(contribution.contributionType === "CASH", "POLICY_CONFIGURATION_PENDING", "Only CASH contributions have an approved receipt design");
      assertFinance(contribution.recordStatus === "DECLARED", "POSTED_RECORD_IMMUTABLE", `Contribution is ${contribution.recordStatus}, not DECLARED`);
      assertFinance(contribution.amount !== null, "POLICY_CONFIGURATION_PENDING", "The declaration has no cash amount");
      assertFinance(command.amount.currency === "USD" || command.amount.currency === "AFN", "CURRENCY_MISMATCH", "Currency is not supported");
      assertFinance(command.amount.currency === contribution.amount.currency, "CURRENCY_MISMATCH", "Receipt currency differs from the declaration");
      const proposed = positive(command.amount.amount);
      const received = sum((await this.repository.listReceipts(contribution.id)).filter(countsAsReceived).map((item) => item.amount.amount));
      assertFinance(received.add(proposed).compare(ExactDecimal.parse(contribution.amount.amount)) <= 0,
        "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Receipt exceeds the declaration's outstanding amount");
      assertFinance(validDate(command.receiptDate) && command.receiptDate <= this.now().slice(0, 10),
        "EVIDENCE_REQUIRED", "Receipt date must be valid and not in the future");
      await this.destination(command.treasuryDestinationId, contribution.legalEntityId, command.amount.currency);
      await this.validateEvidence(clean(command.evidenceReferenceId), contribution.legalEntityId, "CASH_RECEIPT");

      const at = this.now();
      const receipt: CapitalReceiptRecord = deepFreeze({
        id: this.newId(),
        legalEntityId: contribution.legalEntityId,
        contributionId: contribution.id,
        sourceFingerprint: sourceFingerprint(contribution),
        amount: normalizedAmount,
        receiptDate: command.receiptDate,
        treasuryDestinationId: command.treasuryDestinationId,
        paymentReference: command.paymentReference?.trim() || null,
        evidenceReferenceId: command.evidenceReferenceId?.trim() || null,
        receiptState: "RECORDED",
        approvalState: "PENDING",
        postingState: "NOT_POSTED",
        recordedBy: actor.userAccountId,
        recordedAt: at,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        journalId: null,
        reversedByJournalId: null,
        version: 1
      });
      await this.repository.saveReceipt(receipt, audit(receipt, actor.userAccountId, command.metadata.correlationId,
        "CAPITAL_RECEIPT_RECORDED", at, { amount: receipt.amount.amount, currency: receipt.amount.currency }),
      { operation: "RECORD", key: command.metadata.idempotencyKey, requestHash, value: receipt });
      return receipt;
    });
  }

  async decideReceipt(command: DecideCapitalReceiptCommand): Promise<CapitalReceiptRecord> {
    return this.repository.exclusive(async () => {
      const current = await this.requiredReceipt(command.receiptId);
      const actor = await this.authorize(command, "finance.posting-intent.approve", current.legalEntityId);
      assertFinance(actor.userAccountId !== current.recordedBy, "SEGREGATION_OF_DUTIES_VIOLATION", "The recorder cannot decide their receipt");
      assertFinance(command.decision === "APPROVE" || command.decision === "REJECT", "POLICY_CONFIGURATION_PENDING", "Unknown approval decision");
      const requestHash = hash({ receiptId: current.id, decision: command.decision, reason: clean(command.reason), actorId: actor.userAccountId });
      const replay = await this.repository.findIdempotency<CapitalReceiptRecord>(current.legalEntityId, "DECIDE", command.metadata.idempotencyKey);
      if (replay) return replayValue(replay, requestHash);
      assertFinance(current.version === command.expectedVersion, "IDEMPOTENCY_CONFLICT", "Receipt version changed; reload before deciding");
      assertFinance(current.receiptState === "RECORDED" && current.postingState === "NOT_POSTED", "POSTED_RECORD_IMMUTABLE", "Receipt can no longer be decided");
      assertFinance(current.approvalState === "PENDING", "POSTED_RECORD_IMMUTABLE", `Receipt approval is already ${current.approvalState}`);
      const source = await this.requiredContribution(current.contributionId);
      await this.assertSourceStillReceivable(source, current);
      assertFinance(command.actor.userAccountId !== current.recordedBy, "SEGREGATION_OF_DUTIES_VIOLATION", "The receipt recorder cannot approve or reject the same receipt");
      const at = this.now();
      if (command.decision === "REJECT") assertFinance((command.reason ?? "").trim().length >= 3, "EVIDENCE_REQUIRED", "A rejection reason is required");
      const next: CapitalReceiptRecord = deepFreeze({
        ...current,
        approvalState: command.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        approvedBy: command.decision === "APPROVE" ? actor.userAccountId : null,
        approvedAt: command.decision === "APPROVE" ? at : null,
        rejectedBy: command.decision === "REJECT" ? actor.userAccountId : null,
        rejectedAt: command.decision === "REJECT" ? at : null,
        rejectionReason: command.decision === "REJECT" ? command.reason!.trim() : null,
        version: current.version + 1
      });
      const action = command.decision === "APPROVE" ? "CAPITAL_RECEIPT_APPROVED" : "CAPITAL_RECEIPT_REJECTED";
      await this.repository.replaceReceipt(next, current.version,
        audit(next, actor.userAccountId, command.metadata.correlationId, action, at,
          command.decision === "REJECT" ? { reason: command.reason!.trim() } : {}),
        { operation: "DECIDE", key: command.metadata.idempotencyKey, requestHash, value: next });
      return next;
    });
  }

  async cancelReceipt(command: Omit<DecideCapitalReceiptCommand, "decision"> & { readonly reason: string }): Promise<CapitalReceiptRecord> {
    return this.repository.exclusive(async () => {
      const current = await this.requiredReceipt(command.receiptId);
      const actor = await this.authorize(command, "treasury.cash-receipt.record", current.legalEntityId);
      const requestHash = hash({ receiptId: current.id, reason: clean(command.reason), actorId: actor.userAccountId });
      const replay = await this.repository.findIdempotency<CapitalReceiptRecord>(current.legalEntityId, "CANCEL", command.metadata.idempotencyKey);
      if (replay) return replayValue(replay, requestHash);
      assertFinance(actor.userAccountId === current.recordedBy, "PERMISSION_DENIED", "Only the recorder may cancel an unapproved receipt");
      assertFinance(current.version === command.expectedVersion, "IDEMPOTENCY_CONFLICT", "Receipt version changed; reload before cancelling");
      assertFinance(current.receiptState === "RECORDED" && current.approvalState === "PENDING" && current.postingState === "NOT_POSTED", "POSTED_RECORD_IMMUTABLE", "Only a pending, unposted receipt can be cancelled");
      assertFinance(command.reason.trim().length >= 3, "EVIDENCE_REQUIRED", "A cancellation reason is required");
      const at = this.now();
      const next = deepFreeze<CapitalReceiptRecord>({ ...current, receiptState: "CANCELLED", version: current.version + 1 });
      await this.repository.replaceReceipt(next, current.version,
        audit(next, actor.userAccountId, command.metadata.correlationId, "CAPITAL_RECEIPT_CANCELLED", at, { reason: command.reason.trim() }),
        { operation: "CANCEL", key: command.metadata.idempotencyKey, requestHash, value: next });
      return next;
    });
  }

  async postReceipt(command: PostCapitalContributionReceiptCommand): Promise<PostedJournal> {
    return this.repository.exclusive(async () => {
      const receipt = await this.requiredReceipt(command.receiptId);
      const actor = await this.authorize(command, "finance.journal.post", receipt.legalEntityId);
      await this.repository.authorize(actor, "finance.posting-intent.approve", receipt.legalEntityId, this.now());
      assertFinance(receipt.approvedBy === actor.userAccountId, "PERMISSION_DENIED", "The designated approver must initiate posting");
      assertFinance(actor.userAccountId !== receipt.recordedBy, "SEGREGATION_OF_DUTIES_VIOLATION", "The recorder cannot post their receipt");
      assertFinance(receipt.postingState !== "REVERSED", "POSTED_RECORD_IMMUTABLE", "Reversed receipts cannot be reposted, including old-key retries");
      await this.assertSourceStillReceivable(await this.requiredContribution(receipt.contributionId), receipt);
      const requestHash = hash({ receiptId: receipt.id, accountingEffectiveDate: command.accountingEffectiveDate,
        accountingPeriodId: command.configuration.accountingPeriodId, actorId: actor.userAccountId });
      const replay = await this.repository.findIdempotency<PostedJournal>(receipt.legalEntityId, "POST", command.metadata.idempotencyKey);
      if (replay) return replayValue(replay, requestHash);
      const existing = await this.repository.findJournalByReceipt(receipt.id);
      if (existing) {
        assertFinance(existing.accountingPeriodId === command.configuration.accountingPeriodId
          && await this.repository.postingEffectiveDate(existing.id) === command.accountingEffectiveDate,
        "IDEMPOTENCY_CONFLICT", "Receipt already posted with a different date or period");
        return existing;
      }
      assertFinance(receipt.receiptState === "RECORDED" && receipt.approvalState === "APPROVED" && receipt.postingState === "NOT_POSTED",
        "POLICY_CONFIGURATION_PENDING", "Only an approved, unposted receipt may post");
      assertFinance(receipt.approvedBy === command.actor.userAccountId,
        "PERMISSION_DENIED", "The designated Finance approver must initiate posting");
      assertFinance(command.actor.userAccountId !== receipt.recordedBy,
        "SEGREGATION_OF_DUTIES_VIOLATION", "The Treasury recorder cannot post the same receipt");
      const source = await this.requiredContribution(receipt.contributionId);
      await this.assertSourceStillReceivable(source, receipt);
      const { configuration, accounts } = await this.postingConfiguration(receipt, command);
      assertFinance(configuration.paidInEquityRecognitionApproved, "POLICY_CONFIGURATION_PENDING", "Paid-in equity recognition policy is required; declaration or upload alone is insufficient");
      assertFinance(!configuration.receiptEvidenceRequired || receipt.evidenceReferenceId !== null,
        "EVIDENCE_REQUIRED", "Receipt evidence is required by the approved policy");
      await this.validateEvidence(receipt.evidenceReferenceId, receipt.legalEntityId, "CASH_RECEIPT");
      const debit = configuration.receivingLedgerAccountId;
      const credit = configuration.paidInCapitalLedgerAccountId;
      assertFinance(debit !== null && credit !== null, "POLICY_CONFIGURATION_PENDING", "Approved cash and paid-in-capital ledger mappings are required");
      const amount = positive(receipt.amount.amount).toString();
      const journalId = this.newId() as JournalId;
      const lines: readonly JournalLineDraft[] = [
        { id: this.newId() as JournalLineDraft["id"], ledgerAccountId: debit, dimensions: companyDimensions(receipt), originalAmount: receipt.amount,
          debitBase: amount as DecimalString, subledgerType: "CASH_LOCATION", subledgerId: receipt.treasuryDestinationId },
        { id: this.newId() as JournalLineDraft["id"], ledgerAccountId: credit, dimensions: companyDimensions(receipt), originalAmount: receipt.amount,
          creditBase: amount as DecimalString, subledgerType: "SHAREHOLDER_CAPITAL", subledgerId: receipt.contributionId }
      ];
      validateJournalLines({ lines, legalEntityId: receipt.legalEntityId, baseCurrency: configuration.baseCurrency, accounts });
      const at = this.now();
      const journal = deepFreeze<PostedJournal>({ id: journalId, legalEntityId: receipt.legalEntityId,
        accountingPeriodId: configuration.accountingPeriodId, baseCurrency: configuration.baseCurrency,
        sourceType: "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT", sourceId: receipt.id,
        postedByUserAccountId: actor.userAccountId, postedAt: at, lines, status: "POSTED" });
      const intent: CapitalReceiptPostingIntentRecord = deepFreeze({ id: this.newId(), legalEntityId: receipt.legalEntityId,
        sourceType: "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT", sourceReceiptId: receipt.id,
        contributionId: receipt.contributionId, originalAmount: receipt.amount, baseAmount: receipt.amount,
        treasuryDestinationId: receipt.treasuryDestinationId, debitLedgerAccountId: debit,
        creditLedgerAccountId: credit, accountingPeriodId: configuration.accountingPeriodId,
        policyVersionId: configuration.policyVersionId, status: "POSTED" });
      const postedReceipt = deepFreeze<CapitalReceiptRecord>({ ...receipt, postingState: "POSTED", journalId,
        version: receipt.version + 1 });
      await this.repository.commitPosting({ receipt: postedReceipt, expectedReceiptVersion: receipt.version,
        postingIntent: intent, journal,
        accountingEffectiveDate: command.accountingEffectiveDate,
        audit: audit(postedReceipt, actor.userAccountId, command.metadata.correlationId,
          "CAPITAL_RECEIPT_POSTED", at, { journalId }),
        idempotency: { operation: "POST", key: command.metadata.idempotencyKey, requestHash, value: journal } });
      return journal;
    });
  }

  async reverseReceipt(command: ReverseCapitalContributionReceiptCommand): Promise<PostedJournal> {
    return this.repository.exclusive(async () => {
      const receipt = await this.requiredReceipt(command.receiptId);
      const actor = await this.authorize(command, "finance.journal.reverse", receipt.legalEntityId);
      const decision = await this.repository.findReversalDecision(command.reversalRequestId);
      assertFinance(decision && decision.legalEntityId === receipt.legalEntityId && decision.originalJournalId === receipt.journalId,
        "SCOPE_MISMATCH", "Reversal decision must belong to this entity and original posting");
      assertFinance(decision.status === "APPROVED" && decision.approvedBy === actor.userAccountId,
        "PERMISSION_DENIED", "A persisted independent reversal approval is required");
      assertFinance(decision.requestedBy !== decision.approvedBy, "SEGREGATION_OF_DUTIES_VIOLATION", "Requester cannot approve their reversal");
      assertFinance(decision.accountingPeriodId === command.configuration.accountingPeriodId
        && decision.accountingEffectiveDate === command.accountingEffectiveDate, "SCOPE_MISMATCH", "Reversal date/period differ from the approved decision");
      const requestHash = hash({ receiptId: receipt.id, reversalRequestId: decision.id,
        accountingEffectiveDate: command.accountingEffectiveDate, accountingPeriodId: command.configuration.accountingPeriodId, actorId: actor.userAccountId });
      const replay = await this.repository.findIdempotency<PostedJournal>(receipt.legalEntityId, "REVERSE", command.metadata.idempotencyKey);
      if (replay) return replayValue(replay, requestHash);
      assertFinance(receipt.journalId !== null, "POSTED_RECORD_IMMUTABLE", "Only a posted receipt may be reversed");
      const original = await this.repository.findJournal(receipt.journalId);
      assertFinance(original, "NOT_FOUND", "Original journal was not found");
      const existing = await this.repository.findReversal(original.id);
      if (existing) {
        assertFinance(existing.accountingPeriodId === decision.accountingPeriodId
          && await this.repository.postingEffectiveDate(existing.id) === decision.accountingEffectiveDate,
        "IDEMPOTENCY_CONFLICT", "Original journal was already reversed with different approved details");
        return existing;
      }
      assertFinance(receipt.postingState === "POSTED", "POSTED_RECORD_IMMUTABLE", "Only a posted receipt may be reversed");
      assertFinance(decision.reason.trim().length >= 3 && decision.evidenceReferenceId.trim().length > 0,
        "EVIDENCE_REQUIRED", "A reversal reason and evidence are required");
      assertFinance(actor.userAccountId !== original.postedByUserAccountId && actor.userAccountId !== receipt.recordedBy
        && decision.requestedBy !== original.postedByUserAccountId && decision.requestedBy !== receipt.recordedBy,
        "SEGREGATION_OF_DUTIES_VIOLATION", "Original receipt/posting participants cannot request or approve its reversal");
      await this.validateEvidence(decision.evidenceReferenceId, receipt.legalEntityId, "REVERSAL_REASON");
      const { configuration, accounts } = await this.postingConfiguration(receipt, command);
      assertFinance(configuration.reversalPostingEnabled, "POLICY_CONFIGURATION_PENDING", "Reversal posting policy remains pending");
      assertFinance(original.baseCurrency === configuration.baseCurrency, "CURRENCY_MISMATCH", "Reversal must preserve the original accounting currency");
      const lines = original.lines.map<JournalLineDraft>((line) => {
        const common = {
          id: this.newId() as JournalLineDraft["id"],
          ledgerAccountId: line.ledgerAccountId,
          dimensions: structuredClone(line.dimensions),
          originalAmount: structuredClone(line.originalAmount),
          ...(line.subledgerType === undefined ? {} : { subledgerType: line.subledgerType }),
          ...(line.subledgerId === undefined ? {} : { subledgerId: line.subledgerId })
        };
        return line.debitBase === undefined
          ? { ...common, debitBase: line.creditBase as DecimalString }
          : { ...common, creditBase: line.debitBase };
      });
      validateJournalLines({ lines, legalEntityId: receipt.legalEntityId, baseCurrency: original.baseCurrency, accounts });
      const at = this.now();
      const reversal = deepFreeze<PostedJournal>({ id: this.newId() as JournalId, legalEntityId: receipt.legalEntityId,
        accountingPeriodId: configuration.accountingPeriodId, baseCurrency: original.baseCurrency,
        sourceType: "REVERSAL", sourceId: original.id, postedByUserAccountId: actor.userAccountId,
        postedAt: at, lines, reversalOfJournalId: original.id, status: "POSTED" });
      const reversedReceipt = deepFreeze<CapitalReceiptRecord>({ ...receipt, postingState: "REVERSED",
        reversedByJournalId: reversal.id, version: receipt.version + 1 });
      await this.repository.commitReversal({ receipt: reversedReceipt, expectedReceiptVersion: receipt.version,
        reversal, originalJournalId: original.id,
        accountingEffectiveDate: command.accountingEffectiveDate, decision,
        audit: audit(reversedReceipt, actor.userAccountId, command.metadata.correlationId,
          "CAPITAL_RECEIPT_REVERSED", at, { originalJournalId: original.id, reversalJournalId: reversal.id,
            reversalRequestId: decision.id, reason: decision.reason.trim(), evidenceReferenceId: decision.evidenceReferenceId }),
        idempotency: { operation: "REVERSE", key: command.metadata.idempotencyKey, requestHash, value: reversal } });
      return reversal;
    });
  }

  async summary(contributionId: string, actor: ServerActorContext): Promise<CapitalContributionFinanceSummary> {
    return this.repository.exclusive(async () => {
    const contribution = await this.requiredContribution(contributionId);
    await this.repository.authorize(actor, "finance.report.operational.read", contribution.legalEntityId, this.now());
    assertFinance(contribution.contributionType === "CASH" && contribution.amount !== null, "POLICY_CONFIGURATION_PENDING", "Only CASH declarations have a receipt summary");
    const receipts = (await this.repository.listReceipts(contributionId)).filter(countsAsReceived);
    const receivedAmount = sum(receipts.map((item) => item.amount.amount));
    const declared = ExactDecimal.parse(contribution.amount.amount);
    const received = receivedAmount.toString();
    assertFinance(receivedAmount.compare(declared) <= 0, "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Receipt history exceeds the declaration");
    const posted = sum(receipts.filter(item => item.postingState === "POSTED").map(item => item.amount.amount)).toString();
    const outstanding = declared.subtract(receivedAmount).toString();
    const approvalState = receipts.length === 0 ? "NOT_RECEIVED"
      : receipts.some((item) => item.approvalState === "PENDING") ? "PENDING"
      : receipts.every((item) => item.approvalState === "APPROVED") ? "APPROVED" : "REJECTED";
    const postingState = receipts.some((item) => item.postingState === "POSTED") ? "POSTED"
      : receipts.some((item) => item.postingState === "REVERSED") ? "REVERSED" : "NOT_POSTED";
    return { contributionId, declared: contribution.amount,
      received: { amount: received as CapitalReceiptRecord["amount"]["amount"], currency: contribution.amount.currency },
      outstanding: { amount: outstanding as CapitalReceiptRecord["amount"]["amount"], currency: contribution.amount.currency },
      posted: { amount: posted as DecimalString, currency: contribution.amount.currency },
      receiptCount: receipts.length, approvalState, postingState };
    });
  }

  private async authorize(command: { readonly actor: ServerActorContext; readonly metadata: CapitalBridgeRequestMetadata }, permission: string, entity: LegalEntityId) {
    assertFinance(command.metadata.idempotencyKey.trim().length > 0 && command.metadata.idempotencyKey.length <= 200
      && command.metadata.correlationId.trim().length > 0, "IDEMPOTENCY_CONFLICT", "Stable idempotency key and correlation ID are required");
    return this.repository.authorize(command.actor, permission, entity, this.now());
  }

  private async assertSourceStillReceivable(source: CapitalContributionDeclaration, receipt: CapitalReceiptRecord) {
    assertFinance(source.sourceModel === "CONTRIBUTION_0035" && source.legalEntityId === receipt.legalEntityId
      && source.recordStatus === "DECLARED" && source.contributionType === "CASH" && source.amount !== null,
    "POSTED_RECORD_IMMUTABLE", "Source declaration is no longer eligible for this receipt");
    assertFinance(source.amount.currency === receipt.amount.currency, "CURRENCY_MISMATCH", "Source declaration currency changed");
    assertFinance(sourceFingerprint(source) === receipt.sourceFingerprint, "POSTED_RECORD_IMMUTABLE", "Source declaration facts changed after receipt recording");
    const received = sum((await this.repository.listReceipts(source.id)).filter(countsAsReceived).map(item => item.amount.amount));
    assertFinance(received.compare(positive(source.amount.amount)) <= 0,
      "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Source declaration was reduced below recorded receipts");
  }

  private async destination(id: string, entity: LegalEntityId, currency: string) {
    const destination = await this.repository.findDestination(id);
    assertFinance(destination && destination.legalEntityId === entity, "SCOPE_MISMATCH", "Treasury destination is unavailable or belongs to another entity");
    assertFinance(destination.currency === currency, "CURRENCY_MISMATCH", "Treasury destination currency differs from receipt");
    assertFinance(destination.status === "ACTIVE", "CASH_ACCOUNT_INACTIVE", "Treasury destination is inactive");
    assertFinance(destination.openingPositionApproved, "OPENING_POSITION_NOT_APPROVED", "Destination opening is not approved");
    return destination;
  }

  private async validateEvidence(id: string | null, entity: LegalEntityId, kind: EvidenceReference["kind"]) {
    if (id === null) return;
    const evidence = await this.repository.findEvidence(id);
    assertFinance(evidence && evidence.legalEntityId === entity && evidence.reference.kind === kind,
      "EVIDENCE_REQUIRED", "Evidence is unavailable, foreign or of the wrong kind");
    assertFinance(/^[0-9a-f]{64}$/i.test(evidence.reference.sha256) && Number.isSafeInteger(evidence.reference.version)
      && evidence.reference.version > 0, "EVIDENCE_REQUIRED", "Evidence integrity metadata is invalid");
  }

  private async postingConfiguration(receipt: CapitalReceiptRecord, command: PostCapitalContributionReceiptCommand | ReverseCapitalContributionReceiptCommand) {
    const configuration = await this.repository.findConfiguration(receipt.legalEntityId, receipt.treasuryDestinationId, command.configuration.accountingPeriodId);
    assertFinance(configuration && configuration.policyVersionId.trim().length > 0, "POLICY_CONFIGURATION_PENDING", "Approved accounting configuration is required");
    assertFinance(hash(configuration) === hash(command.configuration), "POLICY_CONFIGURATION_PENDING", "Caller configuration differs from authoritative accounting state");
    validatePostingConfiguration(configuration, receipt, command.accountingEffectiveDate);
    const destination = await this.destination(receipt.treasuryDestinationId, receipt.legalEntityId, receipt.amount.currency);
    const debit = configuration.receivingLedgerAccountId, credit = configuration.paidInCapitalLedgerAccountId;
    assertFinance(debit !== null && credit !== null && debit !== credit, "POLICY_CONFIGURATION_PENDING", "Distinct approved cash and capital accounts are required");
    assertFinance(configuration.treasuryDestinationId === destination.id && debit === destination.ledgerAccountId, "SCOPE_MISMATCH", "Cash mapping differs from the receipt destination");
    const accounts = await this.repository.findLedgerAccounts(receipt.legalEntityId);
    const cash = accounts.get(debit), capital = accounts.get(credit);
    assertFinance(cash && cash.accountType === "ASSET" && cash.controlType === "CASH"
      && capital && capital.accountType === "EQUITY" && capital.controlType === "SHAREHOLDER_CAPITAL",
    "POLICY_CONFIGURATION_PENDING", "Cash-asset and shareholder-capital-equity controls are required");
    assertFinance(cash.currency === receipt.amount.currency && capital.currency === configuration.baseCurrency, "CURRENCY_MISMATCH", "Ledger currency differs from the posting");
    return { configuration, accounts };
  }

  private async requiredContribution(id: string): Promise<CapitalContributionDeclaration> {
    const contribution = await this.repository.findContribution(id);
    assertFinance(contribution, "NOT_FOUND", "Contribution declaration was not found");
    return contribution;
  }
  private async requiredReceipt(id: string): Promise<CapitalReceiptRecord> {
    const receipt = await this.repository.findReceipt(id);
    assertFinance(receipt, "NOT_FOUND", "Capital receipt was not found");
    return receipt;
  }
}

function validatePostingConfiguration(configuration: CapitalReceiptPostingConfiguration, receipt: CapitalReceiptRecord, effectiveDate: string): void {
  assertFinance(configuration.legalEntityId === receipt.legalEntityId, "SCOPE_MISMATCH", "Posting configuration belongs to another legal entity");
  assertFinance(configuration.periodStatus === "OPEN", "ACCOUNTING_PERIOD_CLOSED", "Accounting period is closed");
  assertFinance(validDate(effectiveDate) && effectiveDate >= configuration.periodStartsOn && effectiveDate <= configuration.periodEndsOn,
    "ACCOUNTING_PERIOD_CLOSED", "Accounting date is outside the open period");
  assertFinance(receipt.amount.currency === configuration.baseCurrency, "CURRENCY_MISMATCH",
    "Cross-currency capital posting requires the still-unapproved FX policy and snapshot");
}

function companyDimensions(receipt: CapitalReceiptRecord) {
  return { scope: "COMPANY_LEVEL" as const, legalEntityId: receipt.legalEntityId, companyLevelReason: "CORPORATE_CAPITAL" as const };
}

function positive(value: string): ExactDecimal {
  let decimal: ExactDecimal;
  try { decimal = ExactDecimal.parse(value); } catch { assertFinance(false, "JOURNAL_UNBALANCED", "Amount must be an exact decimal string"); }
  assertFinance(decimal.isPositive(), "JOURNAL_UNBALANCED", "Amount must be positive");
  return decimal;
}

function sum(values: readonly string[]): ExactDecimal {
  return values.reduce((total, value) => total.add(ExactDecimal.parse(value)), ExactDecimal.parse("0"));
}

function countsAsReceived(receipt: CapitalReceiptRecord): boolean { return receipt.receiptState === "RECORDED"; }

function clean(value: string | null | undefined) { return value?.trim() || null; }

function sourceFingerprint(source: CapitalContributionDeclaration) {
  return hash({ id: source.id, legalEntityId: source.legalEntityId, shareholderProfileId: source.shareholderProfileId,
    contributionType: source.contributionType, businessDate: source.businessDate, amount: source.amount, sourceModel: source.sourceModel });
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function replayValue<T>(stored: IdempotencyResult<T>, requestHash: string): T {
  assertFinance(stored.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different details");
  return stored.value;
}

function audit(receipt: CapitalReceiptRecord, actor: UserAccountId, correlationId: CorrelationId,
  action: CapitalBridgeAuditEntry["action"], occurredAt: string, details: Readonly<Record<string, string>>): CapitalBridgeAuditEntry {
  return Object.freeze({ id: randomUUID(), legalEntityId: receipt.legalEntityId, contributionId: receipt.contributionId,
    receiptId: receipt.id, actorUserAccountId: actor, action, occurredAt, correlationId, details });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (value instanceof Map) return [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, item]) => [key, canonical(item)]);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
