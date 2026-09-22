import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntent,
  CapitalReceiptIntentId,
  IdempotencyKey,
  LegalEntityId
} from "@abos/contracts";
import type {
  CapitalAgreementRecord,
  CapitalInstallmentRecord,
  ContributionHistoryEntry,
  ControlledDocumentReference,
  RegistrationEvidenceRecord,
  ShareholderProfile
} from "./types.ts";

/** Idempotent replay of a source transaction, mirroring the Finance kernel's pattern. */
export interface StoredIntentResult {
  readonly requestHash: string;
  readonly intent: CapitalReceiptIntent;
}

/**
 * Persistence port for the shareholder domain.
 *
 * Deliberately narrow: there is no method that writes a journal, a ledger balance, a cash balance or a
 * treasury receipt. The domain physically cannot post.
 *
 * Codex: the durable adapter for this port depends on `abos.capital_receipt_intents`, which does not
 * exist yet — finding F-2 of the Finance review. The shape below is what that table needs to support.
 */
export interface ShareholderRepository {
  findShareholderProfile(
    legalEntityId: LegalEntityId,
    partyId: ShareholderProfile["businessPartyId"]
  ): Promise<ShareholderProfile | undefined>;

  findAgreement(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<CapitalAgreementRecord | undefined>;

  findRegistrationEvidence(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<RegistrationEvidenceRecord | undefined>;

  findInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalInstallmentRecord | undefined>;

  /** Contributions already recorded against an agreement, used to compute remaining eligibility. */
  listContributions(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ContributionHistoryEntry[]>;

  listDocuments(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ControlledDocumentReference[]>;

  findIntentByIdempotencyKey(
    legalEntityId: LegalEntityId,
    key: IdempotencyKey
  ): Promise<StoredIntentResult | undefined>;

  /** One intent per installment — the source-side counterpart of Finance's source uniqueness. */
  findIntentByInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalReceiptIntent | undefined>;

  findIntentById(
    legalEntityId: LegalEntityId,
    intentId: CapitalReceiptIntentId
  ): Promise<CapitalReceiptIntent | undefined>;

  /** Persists a new intent and its history entry atomically. Must reject a duplicate key. */
  saveIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly requestHash: string;
    readonly idempotencyKey: IdempotencyKey;
    readonly history: ContributionHistoryEntry;
  }): Promise<void>;

  /** Replaces an intent and its history entry after a legal state transition. */
  updateIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly history: ContributionHistoryEntry;
  }): Promise<void>;
}
