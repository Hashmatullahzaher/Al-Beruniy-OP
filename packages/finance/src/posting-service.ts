import { createHash, randomUUID } from "node:crypto";
import { checkAgreementMayFund } from "@abos/contracts";
import type {
  AccountingPeriodId,
  AuditRecordId,
  CapitalAgreementFundingPolicy,
  CapitalInstallmentEligibility,
  CapitalPostingIntent,
  CashLocationCurrencyAccount,
  EvidenceReference,
  FinanceApproval,
  JournalId,
  JournalLineDraft,
  LedgerAccountId,
  PhysicalCashCountId,
  PostedJournal,
  RequestMetadata,
  SandboxPostingGate,
  ServerActorContext,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import { ExactDecimal } from "./decimal.ts";
import { assertFinance, FinanceDomainError } from "./errors.ts";
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

/**
 * Declared posting policy.
 *
 * This is still supplied by the caller and is therefore NOT the authorization. Finding F-3: a
 * caller could previously declare any database to be a synthetic test environment. It is retained
 * because it carries the base currency and policy version the journal is stamped with, and it is
 * now cross-checked against the server-resolved `SandboxPostingGate`, which the caller cannot
 * forge and which the database independently enforces.
 */
export interface CapitalPostingIntentPolicy {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly configurationState: "SYNTHETIC_TEST_ONLY" | "OWNER_PROVISIONAL" | "CLIENT_FINANCE_APPROVED";
  readonly policyVersionId: string;
  readonly baseCurrency: "USD" | "AFN";
  readonly realPostingEnabled: boolean;
}

/**
 * Verifies that a `SandboxPostingGate` really was resolved from the target database by this
 * process. Supplied by `@abos/sandbox-auth`; the Finance package deliberately does not know how the
 * proof is constructed, only that it must be checked before anything is posted.
 */
export type SandboxGateVerifier = (gate: SandboxPostingGate) => void;

/**
 * A physical cash count as persisted by Treasury.
 *
 * Finding F-7: the kernel carried `physicalCashCountId` and never looked at it, so Finance was
 * trusting Treasury's assertion that a count existed and matched.
 */
export interface PhysicalCashCountRecord {
  readonly id: PhysicalCashCountId;
  readonly legalEntityId: CapitalPostingIntent["dimensions"]["legalEntityId"];
  readonly cashLocationCurrencyAccountId: CapitalPostingIntent["destinationAccountId"];
  readonly currency: "USD" | "AFN";
  readonly countedAmount: string;
  readonly countedAt: string;
  readonly countedByUserAccountId: ServerActorContext["userAccountId"];
  readonly status: "RECORDED" | "CONFIRMED" | "DISCREPANCY" | "VOIDED";
  readonly confirmedByUserAccountId?: ServerActorContext["userAccountId"];
}

export interface PostingConfiguration {
  readonly policy: CapitalPostingIntentPolicy;
  /** Resolved server-side from the target database. Without it nothing posts. */
  readonly gate: SandboxPostingGate;
  /**
   * The recorded decision on which canonical agreement statuses may fund an installment - finding
   * F-1. `undefined` means no decision is recorded, and nothing is fundable.
   */
  readonly fundingPolicy: CapitalAgreementFundingPolicy | undefined;
  /** The persisted count the Treasury receipt claims to be evidenced by - finding F-7. */
  readonly physicalCashCount: PhysicalCashCountRecord;
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
  readonly gate: SandboxPostingGate;
  /**
   * The date the reversal takes accounting effect - finding F-6.
   *
   * Previously the period check was handed the period's own `startsOn`, which made it vacuous: any
   * reversal passed whatever date it actually belonged to. The caller must now state the date, and
   * it is validated against the open period like any other posting.
   */
  readonly accountingEffectiveDate: string;
  readonly ledgerAccounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
}

export class FinancePostingService {
  private readonly repository: FinancePostingRepository;
  private readonly verifyGate: SandboxGateVerifier;
  private readonly now: () => string;
  private readonly newId: () => string;

  /**
   * `verifyGate` is required and has no default. A service constructed without a way to prove that
   * the sandbox gate came from the database cannot post anything, which is the point of F-3.
   */
  constructor(
    repository: FinancePostingRepository,
    verifyGate: SandboxGateVerifier,
    now: () => string = () => new Date().toISOString(),
    newId: () => string = () => randomUUID()
  ) {
    this.repository = repository;
    if (typeof verifyGate !== "function") {
      throw new FinanceDomainError(
        "POLICY_CONFIGURATION_PENDING",
        "FinancePostingService requires a sandbox gate verifier"
      );
    }
    this.verifyGate = verifyGate;
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
    this.assertGateAuthorizes(command.gate, command.policy, command.actor);
    assertPermission(command.actor, "finance.journal.reverse");
    assertFinance(command.reason.trim().length >= 3, "EVIDENCE_REQUIRED", "A reversal reason is required");
    assertFinance(command.evidence.some((item) => item.kind === "REVERSAL_REASON"), "EVIDENCE_REQUIRED", "Reversal evidence is required");
    const original = await this.repository.findJournalById(command.originalJournalId);
    assertFinance(original, "NOT_FOUND", "Original journal was not found");
    assertActorScope(command.actor, original.legalEntityId, original.lines[0]?.dimensions);
    assertFinance(
      command.gate.scope.legalEntityId === original.legalEntityId,
      "SCOPE_MISMATCH",
      "The sandbox gate was resolved for another legal entity"
    );
    // F-5. Migration 0001 keeps the poster apart from the intent creator, the cashier and the
    // counter, but left the poster free to reverse their own journal. The database now refuses that
    // too; this is the same refusal raised before any work is done.
    assertFinance(
      command.actor.userAccountId !== original.postedByUserAccountId,
      "SEGREGATION_OF_DUTIES_VIOLATION",
      "The actor who posted a journal cannot reverse it"
    );
    // F-6. The reversal's own accounting date, not the period's start date.
    assertFinance(
      ISO_DATE.test(command.accountingEffectiveDate),
      "ACCOUNTING_PERIOD_CLOSED",
      "A reversal requires an explicit accounting effective date (YYYY-MM-DD)"
    );
    assertPeriodOpen(command.accountingPeriod, original.legalEntityId, command.accountingEffectiveDate);
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
      const reversalEvidence = command.evidence.find((item) => item.kind === "REVERSAL_REASON");
      assertFinance(reversalEvidence, "EVIDENCE_REQUIRED", "Reversal evidence is required");
      await this.repository.commit({
        ...commit,
        reversalOfJournalId: original.id,
        reversal: {
          originalJournalId: original.id,
          reason: command.reason,
          approvedByUserAccountId: command.actor.userAccountId,
          evidenceReferenceId: reversalEvidence.id
        }
      });
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

  /**
   * Finding F-3. The authorization to mutate finance comes from the database, not from the request.
   *
   * `policy` is still whatever the caller declared; it is accepted only where it agrees with the
   * server-resolved gate. `verifyGate` proves the gate was produced by this process from the target
   * database, so a hand-built gate object is refused. The database enforces the same rule again on
   * every write, and that enforcement does not depend on anything in this file.
   */
  private assertGateAuthorizes(
    gate: SandboxPostingGate,
    policy: CapitalPostingIntentPolicy,
    actor: ServerActorContext
  ): void {
    this.verifyGate(gate);
    assertFinance(
      gate.authorization.configurationState === "SYNTHETIC_TEST_ONLY",
      "POLICY_CONFIGURATION_PENDING",
      "E1 posting requires an isolated synthetic-test authorization"
    );
    assertFinance(
      gate.authorization.environment === "development" || gate.authorization.environment === "test",
      "POLICY_CONFIGURATION_PENDING",
      "E1 posting is limited to development and test environments"
    );
    assertFinance(
      !gate.authorization.realPostingEnabled,
      "POLICY_CONFIGURATION_PENDING",
      "Real posting must remain disabled"
    );
    assertFinance(
      new Date(gate.authorization.expiresAt).getTime() > new Date(this.now()).getTime(),
      "POLICY_CONFIGURATION_PENDING",
      "The sandbox authorization has expired"
    );

    // The declared policy may not claim more than the gate allows.
    assertFinance(
      policy.configurationState === gate.authorization.configurationState,
      "POLICY_CONFIGURATION_PENDING",
      `Declared configuration state ${policy.configurationState} contradicts the database authorization`
    );
    assertFinance(
      policy.environment === gate.authorization.environment,
      "POLICY_CONFIGURATION_PENDING",
      `Declared environment ${policy.environment} contradicts the database authorization`
    );
    assertFinance(
      !policy.realPostingEnabled,
      "POLICY_CONFIGURATION_PENDING",
      "Real posting must remain disabled"
    );
    assertFinance(
      policy.policyVersionId === gate.authorization.policyVersionId,
      "POLICY_CONFIGURATION_PENDING",
      "Declared policy version differs from the authorized one"
    );

    // The actor must hold a server-issued session; a context assembled from a payload has none.
    assertFinance(
      actor.sessionId !== undefined && actor.sessionId.trim().length > 0,
      "AUTHENTICATION_REQUIRED",
      "The actor context did not come from a server-side sandbox session"
    );
    assertFinance(
      actor.expiresAt === undefined || new Date(actor.expiresAt).getTime() > new Date(this.now()).getTime(),
      "AUTHENTICATION_REQUIRED",
      "The actor's sandbox session has expired"
    );
  }

  private async assertPostable(command: PostCapitalReceiptCommand): Promise<void> {
    const { configuration, intent, eligibility, treasuryReceipt, approval, actor } = command;
    this.assertGateAuthorizes(configuration.gate, configuration.policy, actor);
    assertFinance(
      configuration.gate.scope.legalEntityId === intent.dimensions.legalEntityId,
      "SCOPE_MISMATCH",
      "The sandbox gate was resolved for another legal entity"
    );
    assertFinance(
      configuration.gate.scope.baseCurrency === configuration.policy.baseCurrency,
      "CURRENCY_MISMATCH",
      "The declared base currency differs from the authorized sandbox base currency"
    );
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
    // F-1. Fundability is read from the recorded decision, never inferred from a status name. With
    // no decision recorded nothing is fundable, so the kernel no longer asserts a value (APPROVED)
    // that the database was never able to store.
    const fundingViolation = checkAgreementMayFund(
      eligibility.canonicalAgreementStatus,
      configuration.fundingPolicy
    );
    assertFinance(
      fundingViolation === undefined,
      fundingViolation?.code ?? "CAPITAL_AGREEMENT_REQUIRED",
      fundingViolation?.message ?? ""
    );
    assertFinance(eligibility.registrationEvidence, "REGISTRATION_EVIDENCE_REQUIRED", "Formal registration evidence is required");
    assertFinance(eligibility.eligibleAmount.currency === intent.originalAmount.currency, "CURRENCY_MISMATCH", "Eligibility currency differs from the posting intent");
    assertFinance(eligibility.remainingEligibleAmount.currency === intent.originalAmount.currency, "CURRENCY_MISMATCH", "Remaining-eligibility currency differs from the posting intent");
    const proposed = ExactDecimal.parse(intent.originalAmount.amount);
    assertFinance(proposed.compare(ExactDecimal.parse(eligibility.eligibleAmount.amount)) <= 0, "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Installment exceeds eligible capital amount");
    // F-4. The commitment ceiling, not just this installment's expected amount. The authoritative
    // guarantee is the row-locked database trigger in migration 0002; this refuses the same case
    // earlier, with a domain error rather than a constraint violation.
    assertFinance(proposed.compare(ExactDecimal.parse(eligibility.remainingEligibleAmount.amount)) <= 0, "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Installment exceeds the remaining capital commitment");
    assertFinance(proposed.isPositive(), "JOURNAL_UNBALANCED", "Installment must be positive");

    assertFinance(treasuryReceipt.status === "VERIFIED", "TREASURY_RECEIPT_NOT_VERIFIED", "Treasury receipt must be verified");
    assertFinance(treasuryReceipt.capitalReceiptIntentId === intent.sourceIntentId && treasuryReceipt.id === intent.treasuryReceiptId, "SCOPE_MISMATCH", "Treasury receipt mismatch");
    assertFinance(treasuryReceipt.cashierUserAccountId === intent.cashierUserAccountId, "SCOPE_MISMATCH", "Cashier identity mismatch");
    assertFinance(treasuryReceipt.destinationAccountId === intent.destinationAccountId, "SCOPE_MISMATCH", "Treasury destination mismatch");
    assertFinance(treasuryReceipt.amount.currency === "USD" && intent.originalAmount.currency === "USD", "CURRENCY_MISMATCH", "First capital receipt slice accepts USD only");
    assertFinance(ExactDecimal.parse(treasuryReceipt.amount.amount).compare(ExactDecimal.parse(intent.originalAmount.amount)) === 0, "SCOPE_MISMATCH", "Verified cash amount differs from intent");
    assertPhysicalCashCount(configuration.physicalCashCount, treasuryReceipt, intent);

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Finding F-7. Finance must not take Treasury's word that a physical count backs the receipt.
 *
 * The amount comparison is deliberately >= rather than ===: whether countedAmount is a count of the
 * cash received or of the whole safe after receipt is an unresolved Treasury question, and >= is
 * the reading that holds either way. Recorded for the Finance Manager in the handoff.
 */
function assertPhysicalCashCount(
  count: PhysicalCashCountRecord,
  receipt: VerifiedTreasuryReceipt,
  intent: CapitalPostingIntent
): void {
  assertFinance(count.id === receipt.physicalCashCountId, "EVIDENCE_REQUIRED", "The supplied physical cash count is not the one the receipt references");
  assertFinance(count.status === "CONFIRMED", "EVIDENCE_REQUIRED", `Physical cash count is ${count.status} and has not been confirmed`);
  assertFinance(count.legalEntityId === intent.dimensions.legalEntityId, "SCOPE_MISMATCH", "Physical cash count belongs to another legal entity");
  assertFinance(count.cashLocationCurrencyAccountId === intent.destinationAccountId, "SCOPE_MISMATCH", "Physical cash count belongs to another cash account");
  assertFinance(count.currency === receipt.amount.currency, "CURRENCY_MISMATCH", "Physical cash count currency differs from the receipt currency");
  assertFinance(count.confirmedByUserAccountId !== undefined, "EVIDENCE_REQUIRED", "A confirmed physical cash count must record its confirming actor");
  assertFinance(count.confirmedByUserAccountId !== count.countedByUserAccountId, "SEGREGATION_OF_DUTIES_VIOLATION", "The actor who counted the cash cannot confirm the count");
  assertFinance(ExactDecimal.parse(count.countedAmount).compare(ExactDecimal.parse(receipt.amount.amount)) >= 0, "EVIDENCE_REQUIRED", "The physical cash count is below the received amount");
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
  // F-8. A cost-centre-scoped transaction requires cost-centre authority. An actor with no
  // cost-centre grants has none, so this fails closed rather than being skipped.
  if (dimensions?.costCenterId !== undefined) {
    assertFinance(
      (actor.costCenterIds ?? []).includes(dimensions.costCenterId),
      "SCOPE_MISMATCH",
      "Actor is outside the cost-centre scope"
    );
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
    accountingEffectiveDate: command.accountingEffectiveDate,
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
