import { createHash, randomUUID } from "node:crypto";
import type {
  CapitalReceiptIntent,
  CapitalReceiptIntentId,
  LegalEntityId,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import { assertAmountIsAuthorized, assessInstallmentEligibility } from "./eligibility.ts";
import type { EligibilityAssessment } from "./eligibility.ts";
import { assertShareholder } from "./errors.ts";
import type { ShareholderRepository } from "./repository.ts";
import type {
  ContributionClassification,
  ContributionHistoryEntry,
  ContributionState,
  CreateCapitalReceiptIntentCommand
} from "./types.ts";

/**
 * Source-side service for "a shareholder pays an eligible USD capital installment into a company
 * office safe".
 *
 * What this service does: validates the shareholder, agreement, registration evidence, installment
 * authorisation, amount, currency, destination and source identity, then emits a
 * `CapitalReceiptIntent` for Treasury.
 *
 * What this service must never do, and structurally cannot:
 *  - increase a safe balance (no Treasury write port exists on `ShareholderRepository`)
 *  - post to the General Ledger (`@abos/finance` is not a dependency of this package)
 *  - infer that cash was received because an intent was created (`markTreasuryVerified` is the only
 *    path to `TREASURY_VERIFIED`, and it requires a `VerifiedTreasuryReceipt` from Treasury)
 */
export class CapitalReceiptIntentService {
  private readonly repository: ShareholderRepository;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    repository: ShareholderRepository,
    now: () => string = () => new Date().toISOString(),
    newId: () => string = () => randomUUID()
  ) {
    this.repository = repository;
    this.now = now;
    this.newId = newId;
  }

  /** E1 slice: the first connected happy path accepts USD only. */
  static readonly SUPPORTED_CURRENCY = "USD" as const;

  async createCapitalReceiptIntent(
    command: CreateCapitalReceiptIntentCommand
  ): Promise<CapitalReceiptIntent> {
    const assessment = await this.validate(command);

    const requestHash = fingerprint(command);
    const replay = await this.repository.findIntentByIdempotencyKey(
      command.legalEntityId,
      command.source.idempotencyKey
    );
    if (replay) {
      assertShareholder(
        replay.requestHash === requestHash,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was reused with a different capital receipt request"
      );
      return replay.intent;
    }

    const duplicate = await this.repository.findIntentByInstallment(
      command.legalEntityId,
      command.installmentId
    );
    assertShareholder(
      !duplicate,
      "IDEMPOTENCY_CONFLICT",
      "This installment already has a capital receipt intent"
    );

    const intent: CapitalReceiptIntent = deepFreeze({
      id: this.newId() as CapitalReceiptIntentId,
      shareholderPartyId: command.shareholderPartyId,
      agreementId: command.agreementId,
      installmentId: command.installmentId,
      dimensions: structuredClone(assessmentDimensions(assessment, command)),
      expectedDestinationAccountId: command.expectedDestinationAccountId,
      amount: structuredClone(command.amount),
      // ELIGIBLE means "validated and handed to Treasury". It does NOT mean cash was received.
      status: "ELIGIBLE",
      evidence: Object.freeze([...command.evidence]),
      businessEventAt: command.businessEventAt,
      version: 1
    });

    await this.repository.saveIntent({
      intent,
      requestHash,
      idempotencyKey: command.source.idempotencyKey,
      history: history(intent, "PENDING", classify(assessment))
    });
    return intent;
  }

  /**
   * Records that Treasury verified a physical receipt against this intent.
   * Called from the application boundary after Antigravity's Treasury domain produces the receipt;
   * the shareholder domain never creates a `VerifiedTreasuryReceipt` itself.
   */
  async markTreasuryVerified(input: {
    readonly legalEntityId: LegalEntityId;
    readonly intentId: CapitalReceiptIntentId;
    readonly receipt: VerifiedTreasuryReceipt;
  }): Promise<CapitalReceiptIntent> {
    const current = await this.repository.findIntentById(input.legalEntityId, input.intentId);
    assertShareholder(current, "NOT_FOUND", "Capital receipt intent was not found");
    assertShareholder(
      current.status === "ELIGIBLE",
      "POSTED_RECORD_IMMUTABLE",
      `Cannot verify an intent in status ${current.status}`
    );
    assertHandoffPreservesSource(current, input.receipt);

    const next = deepFreeze<CapitalReceiptIntent>({
      ...current,
      status: "TREASURY_VERIFIED",
      version: current.version + 1
    });
    const assessment = await this.reassess(input.legalEntityId, current);
    await this.repository.updateIntent({
      intent: next,
      history: { ...history(next, "VERIFIED", classify(assessment)), treasuryReceiptId: input.receipt.id }
    });
    return next;
  }

  /**
   * Records that Finance posted this contribution. Traceability only: the journal is created by the
   * Finance service, and the journal id is accepted here purely as a reference.
   */
  async markPosted(input: {
    readonly legalEntityId: LegalEntityId;
    readonly intentId: CapitalReceiptIntentId;
    readonly treasuryReceiptId: string;
    readonly journalId: string;
  }): Promise<CapitalReceiptIntent> {
    const current = await this.repository.findIntentById(input.legalEntityId, input.intentId);
    assertShareholder(current, "NOT_FOUND", "Capital receipt intent was not found");
    assertShareholder(
      current.status === "TREASURY_VERIFIED",
      "POSTED_RECORD_IMMUTABLE",
      `Only a treasury-verified intent can be posted, not ${current.status}`
    );
    const next = deepFreeze<CapitalReceiptIntent>({
      ...current,
      status: "POSTED",
      version: current.version + 1
    });
    const assessment = await this.reassess(input.legalEntityId, current);
    await this.repository.updateIntent({
      intent: next,
      history: {
        ...history(next, "POSTED", classify(assessment)),
        treasuryReceiptId: input.treasuryReceiptId,
        journalId: input.journalId
      }
    });
    return next;
  }

  /** Full contribution history for an agreement, with pending/verified/approved/posted distinct. */
  async contributionHistory(
    legalEntityId: LegalEntityId,
    agreementId: CreateCapitalReceiptIntentCommand["agreementId"]
  ): Promise<readonly ContributionHistoryEntry[]> {
    return this.repository.listContributions(legalEntityId, agreementId);
  }

  private async validate(
    command: CreateCapitalReceiptIntentCommand
  ): Promise<EligibilityAssessment> {
    assertShareholder(
      command.amount.currency === CapitalReceiptIntentService.SUPPORTED_CURRENCY,
      "CURRENCY_MISMATCH",
      "The first E1 capital-receipt slice accepts USD only"
    );
    assertShareholder(
      command.source.idempotencyKey.trim().length > 0,
      "EVIDENCE_REQUIRED",
      "A stable idempotency key is required for the source transaction"
    );
    assertShareholder(
      command.expectedDestinationAccountId.trim().length > 0,
      "SCOPE_MISMATCH",
      "The intended Treasury destination must be identified"
    );

    const profile = await this.repository.findShareholderProfile(
      command.legalEntityId,
      command.shareholderPartyId
    );
    assertShareholder(profile, "NOT_FOUND", "Shareholder is not registered in this legal entity");
    assertShareholder(
      profile.legalEntityId === command.legalEntityId,
      "SCOPE_MISMATCH",
      "Shareholder belongs to a different legal entity"
    );
    assertShareholder(
      profile.status === "ACTIVE",
      "CAPITAL_AGREEMENT_REQUIRED",
      `Shareholder profile is ${profile.status}`
    );

    const agreement = await this.repository.findAgreement(command.legalEntityId, command.agreementId);
    assertShareholder(agreement, "CAPITAL_AGREEMENT_REQUIRED", "Capital agreement was not found");
    assertShareholder(
      agreement.legalEntityId === command.legalEntityId,
      "SCOPE_MISMATCH",
      "Capital agreement belongs to a different legal entity"
    );
    assertShareholder(
      agreement.shareholderPartyId === command.shareholderPartyId,
      "SCOPE_MISMATCH",
      "Capital agreement belongs to a different shareholder"
    );
    assertShareholder(
      agreement.agreementKind === "CAPITAL_CONTRIBUTION",
      "CAPITAL_AGREEMENT_REQUIRED",
      "A shareholder loan cannot be received as a capital contribution"
    );
    assertShareholder(
      agreement.status === "APPROVED",
      "CAPITAL_AGREEMENT_REQUIRED",
      `Capital agreement is ${agreement.status} and cannot fund an installment`
    );
    assertShareholder(
      agreement.denominationCurrency === command.amount.currency,
      "CURRENCY_MISMATCH",
      "Amount currency differs from the agreement denomination currency"
    );

    const registration = await this.repository.findRegistrationEvidence(
      command.legalEntityId,
      command.agreementId
    );
    assertShareholder(
      registration && registration.status === "VERIFIED",
      "REGISTRATION_EVIDENCE_REQUIRED",
      "Formal capital-registration evidence is required before an eligible capital receipt"
    );
    assertShareholder(
      registration.evidence.kind === "FORMAL_REGISTRATION",
      "REGISTRATION_EVIDENCE_REQUIRED",
      "Registration evidence must be of kind FORMAL_REGISTRATION"
    );

    const documents = await this.repository.listDocuments(command.legalEntityId, command.agreementId);
    assertShareholder(
      documents.some((document) => document.evidence.kind === "CAPITAL_AGREEMENT"),
      "EVIDENCE_REQUIRED",
      "A controlled CAPITAL_AGREEMENT document is required"
    );
    assertShareholder(
      command.evidence.length > 0,
      "EVIDENCE_REQUIRED",
      "The capital receipt intent requires at least one evidence reference"
    );

    const installment = await this.repository.findInstallment(
      command.legalEntityId,
      command.installmentId
    );
    assertShareholder(installment, "NOT_FOUND", "Capital installment was not found");
    assertShareholder(
      installment.status === "DRAFT" || installment.status === "PENDING_RECEIPT",
      "POSTED_RECORD_IMMUTABLE",
      `Installment is ${installment.status} and cannot accept a new receipt intent`
    );

    const contributions = await this.repository.listContributions(
      command.legalEntityId,
      command.agreementId
    );
    const assessment = assessInstallmentEligibility({
      agreement,
      installment,
      registration,
      contributions
    });
    assertAmountIsAuthorized(assessment, command.amount, installment);
    return assessment;
  }

  private async reassess(
    legalEntityId: LegalEntityId,
    intent: CapitalReceiptIntent
  ): Promise<EligibilityAssessment> {
    const agreement = await this.repository.findAgreement(legalEntityId, intent.agreementId);
    const installment = await this.repository.findInstallment(legalEntityId, intent.installmentId);
    const registration = await this.repository.findRegistrationEvidence(
      legalEntityId,
      intent.agreementId
    );
    assertShareholder(agreement && installment, "NOT_FOUND", "Agreement or installment disappeared");
    return assessInstallmentEligibility({
      agreement,
      installment,
      registration,
      contributions: await this.repository.listContributions(legalEntityId, intent.agreementId),
      excludeIntentId: intent.id
    });
  }
}

/**
 * The handoff contract with Antigravity's Treasury domain: a verified receipt must preserve every
 * identifying attribute of the source transaction it claims to verify.
 */
export function assertHandoffPreservesSource(
  intent: CapitalReceiptIntent,
  receipt: VerifiedTreasuryReceipt
): void {
  assertShareholder(
    receipt.capitalReceiptIntentId === intent.id,
    "SCOPE_MISMATCH",
    "Treasury receipt references a different capital receipt intent"
  );
  assertShareholder(
    receipt.status === "VERIFIED",
    "TREASURY_RECEIPT_NOT_VERIFIED",
    "Treasury receipt is not verified"
  );
  assertShareholder(
    receipt.destinationType === "CASH_LOCATION",
    "SCOPE_MISMATCH",
    "Capital receipts in this slice settle into a cash location only"
  );
  assertShareholder(
    receipt.destinationAccountId === intent.expectedDestinationAccountId,
    "SCOPE_MISMATCH",
    "Treasury receipt settled into a different cash account than the intent identified"
  );
  assertShareholder(
    receipt.amount.currency === intent.amount.currency,
    "CURRENCY_MISMATCH",
    "Treasury receipt currency differs from the intent currency"
  );
  assertShareholder(
    receipt.amount.amount === intent.amount.amount,
    "SCOPE_MISMATCH",
    "Verified cash amount differs from the intent amount"
  );
  assertShareholder(
    receipt.physicalCashCountId.trim().length > 0,
    "EVIDENCE_REQUIRED",
    "Treasury receipt must reference a physical cash count"
  );
  assertShareholder(
    receipt.evidence.length > 0,
    "EVIDENCE_REQUIRED",
    "Treasury receipt must carry evidence"
  );
}

/**
 * Accounting classification of a received contribution.
 *
 * Verified formal registration → paid-in share capital.
 * Otherwise `UNDETERMINED_PENDING_POLICY`: the domain does NOT classify a pending contribution as a
 * refundable liability, because that treatment depends on the applicable agreement and an approved
 * accounting policy that does not exist yet.
 */
function classify(assessment: EligibilityAssessment): ContributionClassification {
  return assessment.registrationEvidence ? "PAID_IN_SHARE_CAPITAL" : "UNDETERMINED_PENDING_POLICY";
}

function assessmentDimensions(
  _assessment: EligibilityAssessment,
  command: CreateCapitalReceiptIntentCommand
): CapitalReceiptIntent["dimensions"] {
  return {
    scope: "COMPANY_LEVEL",
    legalEntityId: command.legalEntityId,
    companyLevelReason: "CORPORATE_CAPITAL"
  };
}

function history(
  intent: CapitalReceiptIntent,
  state: ContributionState,
  classification: ContributionClassification
): ContributionHistoryEntry {
  return {
    intentId: intent.id,
    agreementId: intent.agreementId,
    installmentId: intent.installmentId,
    shareholderPartyId: intent.shareholderPartyId,
    legalEntityId: intent.dimensions.legalEntityId,
    amount: intent.amount,
    state,
    classification,
    businessEventAt: intent.businessEventAt
  };
}

function fingerprint(command: CreateCapitalReceiptIntentCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          legalEntityId: command.legalEntityId,
          shareholderPartyId: command.shareholderPartyId,
          agreementId: command.agreementId,
          installmentId: command.installmentId,
          amount: command.amount,
          expectedDestinationAccountId: command.expectedDestinationAccountId,
          businessEventAt: command.businessEventAt,
          evidence: command.evidence
        })
      )
    )
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
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

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
