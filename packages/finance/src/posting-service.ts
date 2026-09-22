import { createHash, randomUUID } from "node:crypto";
import type {
  AccountingPeriodId,
  AuditRecordId,
  CapitalInstallmentEligibility,
  CapitalPostingIntent,
  CashLocationCurrencyAccount,
  EvidenceReference,
  FinanceApproval,
  JournalId,
  JournalLineDraft,
  LedgerAccountId,
  PostedJournal,
  RequestMetadata,
  ServerActorContext,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import { ExactDecimal } from "./decimal.ts";
import { assertFinance } from "./errors.ts";
import type { LedgerAccountPolicy } from "./journal.ts";
import { validateJournalLines } from "./journal.ts";
import type { FinancePostingRepository, PostingCommit } from "./repository.ts";

export interface AccountingPeriodPolicy {
  readonly id: AccountingPeriodId;
  readonly legalEntityId: CapitalPostingIntent["dimensions"]["legalEntityId"];
  readonly status: "OPEN" | "CLOSED";
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface CapitalPostingIntentPolicy {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly configurationState: "SYNTHETIC_TEST_ONLY" | "OWNER_PROVISIONAL" | "CLIENT_FINANCE_APPROVED";
  readonly policyVersionId: string;
  readonly baseCurrency: "USD" | "AFN";
  readonly realPostingEnabled: boolean;
}

export interface PostingConfiguration {
  readonly policy: CapitalPostingIntentPolicy;
  readonly accountingPeriod: AccountingPeriodPolicy;
  readonly ledgerAccounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
  readonly cashLocationAccount: CashLocationCurrencyAccount;
  readonly configuredCashLedgerAccountId: LedgerAccountId;
  readonly configuredPaidInCapitalLedgerAccountId: LedgerAccountId;
}

export interface PostCapitalReceiptCommand {
  readonly intent: CapitalPostingIntent;
  readonly eligibility: CapitalInstallmentEligibility;
  readonly treasuryReceipt: VerifiedTreasuryReceipt;
  readonly approval: FinanceApproval;
  readonly actor: ServerActorContext;
  readonly metadata: RequestMetadata;
  readonly accountingEffectiveDate: string;
  readonly configuration: PostingConfiguration;
}

export interface ReverseJournalCommand {
  readonly originalJournalId: JournalId;
  readonly accountingPeriod: AccountingPeriodPolicy;
  readonly actor: ServerActorContext;
  readonly metadata: RequestMetadata;
  readonly reason: string;
  readonly evidence: readonly EvidenceReference[];
  readonly policy: CapitalPostingIntentPolicy;
  readonly ledgerAccounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
}

export class FinancePostingService {
  private readonly repository: FinancePostingRepository;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    repository: FinancePostingRepository,
    now: () => string = () => new Date().toISOString(),
    newId: () => string = () => randomUUID()
  ) {
    this.repository = repository;
    this.now = now;
    this.newId = newId;
  }

  async postCapitalReceipt(command: PostCapitalReceiptCommand): Promise<PostedJournal> {
    await this.assertPostable(command);
    const requestHash = hashRequest(capitalReceiptFingerprint(command));
    const existing = await this.repository.findIdempotencyResult(
      command.intent.dimensions.legalEntityId,
      "POST_CAPITAL_RECEIPT",
      command.metadata.idempotencyKey
    );
    if (existing) {
      assertFinance(existing.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
      return existing.journal;
    }

    const duplicateSource = await this.repository.findJournalBySource(command.intent.sourceType, command.intent.sourceIntentId);
    assertFinance(!duplicateSource, "IDEMPOTENCY_CONFLICT", "This capital receipt intent is already posted");

    const amount = command.intent.baseAmount.amount;
    const lines: readonly JournalLineDraft[] = [
      {
        id: this.newId() as JournalLineDraft["id"],
        ledgerAccountId: command.intent.debitLedgerAccountId,
        dimensions: structuredClone(command.intent.dimensions),
        originalAmount: structuredClone(command.intent.originalAmount),
        debitBase: amount,
        subledgerType: "CASH_LOCATION",
        subledgerId: command.intent.destinationAccountId
      },
      {
        id: this.newId() as JournalLineDraft["id"],
        ledgerAccountId: command.intent.creditLedgerAccountId,
        dimensions: structuredClone(command.intent.dimensions),
        originalAmount: structuredClone(command.intent.originalAmount),
        creditBase: amount,
        subledgerType: "SHAREHOLDER_CAPITAL",
        subledgerId: command.intent.installmentId
      }
    ];
    validateJournalLines({
      lines,
      legalEntityId: command.intent.dimensions.legalEntityId,
      baseCurrency: command.configuration.policy.baseCurrency,
      accounts: command.configuration.ledgerAccounts
    });

    const journal = deepFreezeJournal({
      id: this.newId() as JournalId,
      legalEntityId: command.intent.dimensions.legalEntityId,
      accountingPeriodId: command.intent.accountingPeriodId,
      baseCurrency: command.configuration.policy.baseCurrency,
      sourceType: command.intent.sourceType,
      sourceId: command.intent.sourceIntentId,
      postedByUserAccountId: command.actor.userAccountId,
      postedAt: this.now(),
      lines,
      status: "POSTED"
    });
    try {
      await this.repository.commit(createCommit(journal, command.metadata, requestHash, "POST_CAPITAL_RECEIPT", "FINANCE_JOURNAL_POSTED"));
      return journal;
    } catch (error) {
      const raced = await this.repository.findIdempotencyResult(
        command.intent.dimensions.legalEntityId,
        "POST_CAPITAL_RECEIPT",
        command.metadata.idempotencyKey
      );
      if (raced) {
        assertFinance(raced.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", "Concurrent idempotency key reuse had a different payload");
        return raced.journal;
      }
      assertFinance(false, "IDEMPOTENCY_CONFLICT", error instanceof Error ? error.message : "Concurrent posting conflict");
    }
  }

  async reverseJournal(command: ReverseJournalCommand): Promise<PostedJournal> {
    assertPolicyAllowsKernel(command.policy);
    assertPermission(command.actor, "finance.journal.reverse");
    assertFinance(command.reason.trim().length >= 3, "EVIDENCE_REQUIRED", "A reversal reason is required");
    assertFinance(command.evidence.some((item) => item.kind === "REVERSAL_REASON"), "EVIDENCE_REQUIRED", "Reversal evidence is required");
    const original = await this.repository.findJournalById(command.originalJournalId);
    assertFinance(original, "NOT_FOUND", "Original journal was not found");
    assertActorScope(command.actor, original.legalEntityId, original.lines[0]?.dimensions);
    assertPeriodOpen(command.accountingPeriod, original.legalEntityId, command.accountingPeriod.startsOn);
    const requestHash = hashRequest(reversalFingerprint(command));
    const existing = await this.repository.findIdempotencyResult(original.legalEntityId, "REVERSE_JOURNAL", command.metadata.idempotencyKey);
    if (existing) {
      assertFinance(existing.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
      return existing.journal;
    }
    assertFinance(!(await this.repository.findReversal(original.id)), "POSTED_RECORD_IMMUTABLE", "Journal already has a reversal");

    const lines = original.lines.map<JournalLineDraft>((line) => {
      const reversed: JournalLineDraft = {
        id: this.newId() as JournalLineDraft["id"],
        ledgerAccountId: line.ledgerAccountId,
        dimensions: structuredClone(line.dimensions),
        originalAmount: structuredClone(line.originalAmount),
        ...(line.subledgerType === undefined ? {} : { subledgerType: line.subledgerType }),
        ...(line.subledgerId === undefined ? {} : { subledgerId: line.subledgerId }),
        ...(line.creditBase === undefined ? {} : { debitBase: line.creditBase }),
        ...(line.debitBase === undefined ? {} : { creditBase: line.debitBase })
      };
      return reversed;
    });
    validateJournalLines({ lines, legalEntityId: original.legalEntityId, baseCurrency: original.baseCurrency, accounts: command.ledgerAccounts });
    const reversal = deepFreezeJournal({
      id: this.newId() as JournalId,
      legalEntityId: original.legalEntityId,
      accountingPeriodId: command.accountingPeriod.id,
      baseCurrency: original.baseCurrency,
      sourceType: "REVERSAL",
      sourceId: original.id,
      postedByUserAccountId: command.actor.userAccountId,
      postedAt: this.now(),
      lines,
      reversalOfJournalId: original.id,
      status: "POSTED"
    });
    const commit = createCommit(reversal, command.metadata, requestHash, "REVERSE_JOURNAL", "FINANCE_JOURNAL_REVERSED");
    try {
      await this.repository.commit({ ...commit, reversalOfJournalId: original.id });
      return reversal;
    } catch (error) {
      const raced = await this.repository.findIdempotencyResult(
        original.legalEntityId,
        "REVERSE_JOURNAL",
        command.metadata.idempotencyKey
      );
      if (raced) {
        assertFinance(raced.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", "Concurrent reversal key reuse had a different payload");
        return raced.journal;
      }
      assertFinance(false, "IDEMPOTENCY_CONFLICT", error instanceof Error ? error.message : "Concurrent reversal conflict");
    }
  }

  private async assertPostable(command: PostCapitalReceiptCommand): Promise<void> {
    const { configuration, intent, eligibility, treasuryReceipt, approval, actor } = command;
    assertPolicyAllowsKernel(configuration.policy);
    assertPermission(actor, "finance.journal.post");
    assertPermission(actor, "finance.posting-intent.approve");
    assertActorScope(actor, intent.dimensions.legalEntityId, intent.dimensions);
    assertFinance(intent.status === "APPROVED", "POLICY_CONFIGURATION_PENDING", "Posting intent must be approved");
    assertFinance(approval.status === "APPROVED", "POLICY_CONFIGURATION_PENDING", "Finance approval is required");
    assertFinance(approval.postingIntentId === intent.id, "SCOPE_MISMATCH", "Finance approval belongs to another posting intent");
    assertFinance(approval.approvedByUserAccountId === actor.userAccountId, "PERMISSION_DENIED", "Only the designated approver may initiate posting");
    assertFinance(actor.userAccountId !== intent.cashierUserAccountId, "SEGREGATION_OF_DUTIES_VIOLATION", "Cashier cannot approve or post the same receipt");
    assertFinance(approval.evidence.length > 0, "EVIDENCE_REQUIRED", "Finance approval evidence is required");

    assertFinance(eligibility.agreementId === intent.agreementId && eligibility.installmentId === intent.installmentId, "CAPITAL_AGREEMENT_REQUIRED", "Capital agreement or installment mismatch");
    assertFinance(eligibility.agreementStatus === "APPROVED", "CAPITAL_AGREEMENT_REQUIRED", "Capital agreement must be approved");
    assertFinance(eligibility.registrationEvidence, "REGISTRATION_EVIDENCE_REQUIRED", "Formal registration evidence is required");
    assertFinance(eligibility.eligibleAmount.currency === intent.originalAmount.currency, "CURRENCY_MISMATCH", "Eligibility currency differs from the posting intent");
    assertFinance(ExactDecimal.parse(intent.originalAmount.amount).compare(ExactDecimal.parse(eligibility.eligibleAmount.amount)) <= 0, "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Installment exceeds eligible capital amount");
    assertFinance(ExactDecimal.parse(intent.originalAmount.amount).isPositive(), "JOURNAL_UNBALANCED", "Installment must be positive");

    assertFinance(treasuryReceipt.status === "VERIFIED", "TREASURY_RECEIPT_NOT_VERIFIED", "Treasury receipt must be verified");
    assertFinance(treasuryReceipt.capitalReceiptIntentId === intent.sourceIntentId && treasuryReceipt.id === intent.treasuryReceiptId, "SCOPE_MISMATCH", "Treasury receipt mismatch");
    assertFinance(treasuryReceipt.cashierUserAccountId === intent.cashierUserAccountId, "SCOPE_MISMATCH", "Cashier identity mismatch");
    assertFinance(treasuryReceipt.destinationAccountId === intent.destinationAccountId, "SCOPE_MISMATCH", "Treasury destination mismatch");
    assertFinance(treasuryReceipt.amount.currency === "USD" && intent.originalAmount.currency === "USD", "CURRENCY_MISMATCH", "First capital receipt slice accepts USD only");
    assertFinance(ExactDecimal.parse(treasuryReceipt.amount.amount).compare(ExactDecimal.parse(intent.originalAmount.amount)) === 0, "SCOPE_MISMATCH", "Verified cash amount differs from intent");

    assertFinance(configuration.cashLocationAccount.id === intent.destinationAccountId, "SCOPE_MISMATCH", "Configured cash account mismatch");
    assertFinance(configuration.cashLocationAccount.currency === "USD", "CURRENCY_MISMATCH", "Receiving cash account must be USD");
    assertFinance(configuration.cashLocationAccount.status === "ACTIVE", "CASH_ACCOUNT_INACTIVE", "Receiving cash account is inactive");
    assertFinance(configuration.cashLocationAccount.openingPositionApproved, "OPENING_POSITION_NOT_APPROVED", "Cash account opening is not approved");
    assertFinance(intent.debitLedgerAccountId === configuration.configuredCashLedgerAccountId, "POLICY_CONFIGURATION_PENDING", "Cash ledger mapping is not approved configuration");
    assertFinance(intent.creditLedgerAccountId === configuration.configuredPaidInCapitalLedgerAccountId, "POLICY_CONFIGURATION_PENDING", "Capital ledger mapping is not approved configuration");
    assertFinance(intent.accountingPeriodId === configuration.accountingPeriod.id, "SCOPE_MISMATCH", "Accounting period mismatch");
    assertPeriodOpen(configuration.accountingPeriod, intent.dimensions.legalEntityId, command.accountingEffectiveDate);

    assertFinance(configuration.policy.baseCurrency === "USD", "CURRENCY_MISMATCH", "First slice requires the selected entity's provisional USD base policy");
    assertFinance(intent.baseAmount.currency === "USD" && ExactDecimal.parse(intent.baseAmount.amount).compare(ExactDecimal.parse(intent.originalAmount.amount)) === 0, "CURRENCY_MISMATCH", "USD original and base amount must match");
    assertFinance(!intent.fxRateSnapshotId, "CURRENCY_MISMATCH", "Same-currency slice must not invent an FX rate");
    assertFinance(intent.evidence.length > 0 && treasuryReceipt.evidence.length > 0, "EVIDENCE_REQUIRED", "Source and receipt evidence are required");
  }
}

function assertPolicyAllowsKernel(policy: CapitalPostingIntentPolicy): void {
  assertFinance(policy.environment === "development" || policy.environment === "test", "POLICY_CONFIGURATION_PENDING", "E0 posting is limited to development and test environments");
  assertFinance(policy.configurationState === "SYNTHETIC_TEST_ONLY", "POLICY_CONFIGURATION_PENDING", "E0 posting requires an isolated synthetic-test policy");
  assertFinance(!policy.realPostingEnabled, "POLICY_CONFIGURATION_PENDING", "E0 real posting must remain disabled");
}

function assertPermission(actor: ServerActorContext, permission: ServerActorContext["permissions"][number]): void {
  assertFinance(actor.permissions.includes(permission), "PERMISSION_DENIED", `Missing permission ${permission}`);
}

function assertActorScope(
  actor: ServerActorContext,
  legalEntityId: CapitalPostingIntent["dimensions"]["legalEntityId"],
  dimensions?: CapitalPostingIntent["dimensions"]
): void {
  assertFinance(actor.legalEntityIds.includes(legalEntityId), "SCOPE_MISMATCH", "Actor is outside the legal-entity scope");
  if (dimensions?.departmentId) {
    assertFinance(actor.departmentIds.includes(dimensions.departmentId), "SCOPE_MISMATCH", "Actor is outside the department scope");
  }
  if (dimensions?.scope === "PROJECT_LEVEL") {
    assertFinance(actor.projectIds.includes(dimensions.projectId), "SCOPE_MISMATCH", "Actor is outside the project scope");
  }
}

function assertPeriodOpen(period: AccountingPeriodPolicy, legalEntityId: CapitalPostingIntent["dimensions"]["legalEntityId"], effectiveDate: string): void {
  assertFinance(period.legalEntityId === legalEntityId, "SCOPE_MISMATCH", "Accounting period belongs to another legal entity");
  assertFinance(period.status === "OPEN", "ACCOUNTING_PERIOD_CLOSED", "Accounting period is closed");
  assertFinance(effectiveDate >= period.startsOn && effectiveDate <= period.endsOn, "ACCOUNTING_PERIOD_CLOSED", "Accounting date is outside the open period");
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function capitalReceiptFingerprint(command: PostCapitalReceiptCommand): unknown {
  return {
    intent: command.intent,
    eligibility: command.eligibility,
    treasuryReceipt: command.treasuryReceipt,
    approval: command.approval,
    accountingEffectiveDate: command.accountingEffectiveDate,
    policyVersionId: command.configuration.policy.policyVersionId,
    baseCurrency: command.configuration.policy.baseCurrency,
    accountingPeriodId: command.configuration.accountingPeriod.id,
    cashLocationAccountId: command.configuration.cashLocationAccount.id,
    configuredCashLedgerAccountId: command.configuration.configuredCashLedgerAccountId,
    configuredPaidInCapitalLedgerAccountId: command.configuration.configuredPaidInCapitalLedgerAccountId
  };
}

function reversalFingerprint(command: ReverseJournalCommand): unknown {
  return {
    originalJournalId: command.originalJournalId,
    accountingPeriodId: command.accountingPeriod.id,
    reason: command.reason,
    evidence: command.evidence,
    policyVersionId: command.policy.policyVersionId,
    baseCurrency: command.policy.baseCurrency
  };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, canonicalize(item)]);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function createCommit(journal: PostedJournal, metadata: RequestMetadata, requestHash: string, operation: PostingCommit["idempotency"]["operation"], action: PostingCommit["audit"]["action"]): PostingCommit {
  return {
    journal,
    idempotency: { legalEntityId: journal.legalEntityId, operation, key: metadata.idempotencyKey, requestHash },
    audit: {
      id: randomUUID() as AuditRecordId,
      actorUserAccountId: journal.postedByUserAccountId,
      correlationId: metadata.correlationId,
      action,
      payload: { journalId: journal.id, sourceType: journal.sourceType, sourceId: journal.sourceId }
    },
    outbox: {
      eventId: randomUUID(),
      eventType: action === "FINANCE_JOURNAL_POSTED" ? "finance.journal.posted" : "finance.journal.reversed",
      actorUserAccountId: journal.postedByUserAccountId,
      correlationId: metadata.correlationId
    }
  };
}

function deepFreezeJournal(journal: PostedJournal): PostedJournal {
  return deepFreeze(journal);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
