import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntent,
  CapitalReceiptIntentId,
  IdempotencyKey,
  LegalEntityId
} from "@abos/contracts";
import type { ShareholderRepository, StoredIntentResult } from "./repository.ts";
import type {
  CapitalAgreementRecord,
  CapitalInstallmentRecord,
  ContributionHistoryEntry,
  ControlledDocumentReference,
  RegistrationEvidenceRecord,
  ShareholderProfile
} from "./types.ts";

/**
 * Synthetic in-memory adapter for E1 development and tests.
 *
 * It is NOT the durable adapter: that depends on `abos.capital_receipt_intents`, which Codex has not
 * created yet (Finance review F-2). Seeded state is synthetic by construction.
 */
export class InMemoryShareholderRepository implements ShareholderRepository {
  private readonly profiles = new Map<string, ShareholderProfile>();
  private readonly agreements = new Map<string, CapitalAgreementRecord>();
  private readonly registrations = new Map<string, RegistrationEvidenceRecord>();
  private readonly installments = new Map<string, CapitalInstallmentRecord>();
  private readonly documents = new Map<string, ControlledDocumentReference[]>();
  private readonly intents = new Map<string, CapitalReceiptIntent>();
  private readonly byIdempotency = new Map<string, StoredIntentResult>();
  private readonly byInstallment = new Map<string, CapitalReceiptIntent>();
  private readonly contributions = new Map<string, ContributionHistoryEntry[]>();

  seedProfile(profile: ShareholderProfile): void {
    this.profiles.set(key(profile.legalEntityId, profile.businessPartyId), profile);
  }
  seedAgreement(agreement: CapitalAgreementRecord): void {
    this.agreements.set(key(agreement.legalEntityId, agreement.id), agreement);
  }
  seedRegistration(registration: RegistrationEvidenceRecord): void {
    this.registrations.set(key(registration.legalEntityId, registration.agreementId), registration);
  }
  seedInstallment(installment: CapitalInstallmentRecord): void {
    this.installments.set(key(installment.legalEntityId, installment.id), installment);
  }
  seedDocument(document: ControlledDocumentReference, agreementId: CapitalAgreementId): void {
    const mapKey = key(document.legalEntityId, agreementId);
    this.documents.set(mapKey, [...(this.documents.get(mapKey) ?? []), document]);
  }
  seedContribution(entry: ContributionHistoryEntry): void {
    const mapKey = key(entry.legalEntityId, entry.agreementId);
    this.contributions.set(mapKey, [...(this.contributions.get(mapKey) ?? []), entry]);
  }

  async findShareholderProfile(
    legalEntityId: LegalEntityId,
    partyId: ShareholderProfile["businessPartyId"]
  ): Promise<ShareholderProfile | undefined> {
    return this.profiles.get(key(legalEntityId, partyId));
  }
  async findAgreement(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<CapitalAgreementRecord | undefined> {
    return this.agreements.get(key(legalEntityId, agreementId));
  }
  async findRegistrationEvidence(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<RegistrationEvidenceRecord | undefined> {
    return this.registrations.get(key(legalEntityId, agreementId));
  }
  async findInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalInstallmentRecord | undefined> {
    return this.installments.get(key(legalEntityId, installmentId));
  }
  async listContributions(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ContributionHistoryEntry[]> {
    return this.contributions.get(key(legalEntityId, agreementId)) ?? [];
  }
  async listDocuments(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ControlledDocumentReference[]> {
    return this.documents.get(key(legalEntityId, agreementId)) ?? [];
  }
  async findIntentByIdempotencyKey(
    legalEntityId: LegalEntityId,
    idempotencyKey: IdempotencyKey
  ): Promise<StoredIntentResult | undefined> {
    return this.byIdempotency.get(key(legalEntityId, idempotencyKey));
  }
  async findIntentByInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalReceiptIntent | undefined> {
    return this.byInstallment.get(key(legalEntityId, installmentId));
  }
  async findIntentById(
    legalEntityId: LegalEntityId,
    intentId: CapitalReceiptIntentId
  ): Promise<CapitalReceiptIntent | undefined> {
    return this.intents.get(key(legalEntityId, intentId));
  }

  async saveIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly requestHash: string;
    readonly idempotencyKey: IdempotencyKey;
    readonly history: ContributionHistoryEntry;
  }): Promise<void> {
    const entity = input.intent.dimensions.legalEntityId;
    const idKey = key(entity, input.idempotencyKey);
    if (this.byIdempotency.has(idKey)) throw new Error("Duplicate idempotency key");
    const installmentKey = key(entity, input.intent.installmentId);
    if (this.byInstallment.has(installmentKey)) throw new Error("Duplicate installment intent");
    this.intents.set(key(entity, input.intent.id), input.intent);
    this.byIdempotency.set(idKey, { requestHash: input.requestHash, intent: input.intent });
    this.byInstallment.set(installmentKey, input.intent);
    this.appendHistory(input.history);
  }

  async updateIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly history: ContributionHistoryEntry;
  }): Promise<void> {
    const entity = input.intent.dimensions.legalEntityId;
    this.intents.set(key(entity, input.intent.id), input.intent);
    this.byInstallment.set(key(entity, input.intent.installmentId), input.intent);
    for (const [mapKey, stored] of this.byIdempotency) {
      if (stored.intent.id === input.intent.id) {
        this.byIdempotency.set(mapKey, { requestHash: stored.requestHash, intent: input.intent });
      }
    }
    this.appendHistory(input.history);
  }

  /** History is a ledger of states: the latest entry for an intent supersedes earlier ones. */
  private appendHistory(entry: ContributionHistoryEntry): void {
    const mapKey = key(entry.legalEntityId, entry.agreementId);
    const existing = this.contributions.get(mapKey) ?? [];
    this.contributions.set(mapKey, [
      ...existing.filter((item) => item.intentId !== entry.intentId),
      entry
    ]);
  }
}

function key(...parts: readonly string[]): string {
  return parts.join(":");
}
