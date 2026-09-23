import type { SqlExecutor } from "@abos/database";
import type {
  CanonicalCapitalAgreementStatus,
  CapitalAgreementFundingPolicy,
  CapitalAgreementId,
  CorrelationId,
  CapitalInstallmentId,
  CapitalReceiptIntent,
  CapitalReceiptIntentId,
  EvidenceReference,
  IdempotencyKey,
  LegalEntityId,
  Money,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";
import type {
  CapitalAgreementRecord,
  CapitalInstallmentRecord,
  ContributionHistoryEntry,
  ControlledDocumentReference,
  RegistrationEvidenceRecord,
  ShareholderProfile,
  ShareholderRepository,
  StoredIntentResult
} from "@abos/shareholder";

/**
 * Durable adapter for the shareholder domain - the one finding F-2 said could not exist.
 *
 * It writes `abos.capital_receipt_intents` and `abos.capital_receipt_intent_history`, created by
 * migration 0002. It still has no way to write a journal, a ledger balance or a cash balance,
 * because `ShareholderRepository` has no such method: the boundary is the port, and persistence
 * does not widen it.
 *
 * Every write goes through the caller's transaction, so an intent and its history entry either
 * both land or neither does.
 */
export class PostgresShareholderRepository implements ShareholderRepository {
  private readonly database: SqlExecutor;
  private readonly actorUserAccountId: UserAccountId;
  private readonly newId: () => string;

  /**
   * `actorUserAccountId` is the authenticated creator, resolved server-side by
   * `@abos/sandbox-auth`. It is stamped on every intent, so a row always names who created it.
   */
  constructor(
    database: SqlExecutor,
    actorUserAccountId: UserAccountId,
    newId: () => string = () => crypto.randomUUID()
  ) {
    this.database = database;
    this.actorUserAccountId = actorUserAccountId;
    this.newId = newId;
  }

  async findShareholderProfile(
    legalEntityId: LegalEntityId,
    partyId: ShareholderProfile["businessPartyId"]
  ): Promise<ShareholderProfile | undefined> {
    const result = await this.database.query<{
      readonly id: string;
      readonly business_party_id: string;
      readonly legal_entity_id: LegalEntityId;
      readonly display_name: string;
      readonly status: ShareholderProfile["status"];
    }>(
      `SELECT sp.id, sp.business_party_id, sp.legal_entity_id, bp.display_name, sp.status
         FROM abos.shareholder_profiles sp
         JOIN abos.business_parties bp
           ON bp.id = sp.business_party_id AND bp.legal_entity_id = sp.legal_entity_id
        WHERE sp.legal_entity_id = $1 AND sp.business_party_id = $2`,
      [legalEntityId, partyId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id as ShareholderProfile["id"],
      businessPartyId: row.business_party_id as ShareholderProfile["businessPartyId"],
      legalEntityId: row.legal_entity_id,
      displayName: row.display_name,
      status: row.status,
      version: 1
    };
  }

  async findAgreement(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<CapitalAgreementRecord | undefined> {
    const result = await this.database.query<{
      readonly id: CapitalAgreementId;
      readonly legal_entity_id: LegalEntityId;
      readonly business_party_id: string;
      readonly agreement_kind: CapitalAgreementRecord["agreementKind"];
      readonly agreement_reference: string;
      readonly currency_code: SupportedCurrency;
      readonly committed_amount: string;
      readonly partial_installments_allowed: boolean;
      readonly status: CanonicalCapitalAgreementStatus;
    }>(
      `SELECT ca.id, ca.legal_entity_id, sp.business_party_id, ca.agreement_kind,
              ca.agreement_reference, ca.currency_code, ca.committed_amount::text AS committed_amount,
              ca.partial_installments_allowed, ca.status
         FROM abos.capital_agreements ca
         JOIN abos.shareholder_profiles sp
           ON sp.id = ca.shareholder_profile_id AND sp.legal_entity_id = ca.legal_entity_id
        WHERE ca.legal_entity_id = $1 AND ca.id = $2`,
      [legalEntityId, agreementId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      legalEntityId: row.legal_entity_id,
      shareholderPartyId: row.business_party_id as CapitalAgreementRecord["shareholderPartyId"],
      agreementKind: row.agreement_kind,
      agreementReference: row.agreement_reference,
      dimensions: {
        scope: "COMPANY_LEVEL",
        legalEntityId: row.legal_entity_id,
        companyLevelReason: "CORPORATE_CAPITAL"
      },
      denominationCurrency: row.currency_code,
      committedAmount: money(row.committed_amount, row.currency_code),
      partialInstallmentsAllowed: row.partial_installments_allowed,
      status: row.status,
      version: 1
    };
  }

  async findFundingPolicy(
    legalEntityId: LegalEntityId
  ): Promise<CapitalAgreementFundingPolicy | undefined> {
    const result = await this.database.query<{
      readonly vocabulary_version: "stage1-e0-v2";
      readonly decision_reference: string;
      readonly decided_by: CapitalAgreementFundingPolicy["decidedBy"];
      readonly fundable_statuses: readonly CanonicalCapitalAgreementStatus[];
      readonly decided_at: Date | string;
    }>(
      `SELECT vocabulary_version, decision_reference, decided_by, fundable_statuses, decided_at
         FROM abos.capital_agreement_funding_policies
        WHERE legal_entity_id = $1`,
      [legalEntityId]
    );
    const row = result.rows[0];
    // No row means no decision, which means nothing is fundable. This is the fail-closed path.
    if (row === undefined) return undefined;
    return {
      vocabularyVersion: row.vocabulary_version,
      decisionReference: row.decision_reference,
      decidedBy: row.decided_by,
      fundableStatuses: row.fundable_statuses,
      decidedAt: iso(row.decided_at)
    };
  }

  async findRegistrationEvidence(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<RegistrationEvidenceRecord | undefined> {
    const result = await this.database.query<{
      readonly status: RegistrationEvidenceRecord["status"];
      readonly verified_by_user_account_id: UserAccountId | null;
      readonly verified_at: Date | string | null;
      readonly evidence_id: string;
      readonly document_id: string;
      readonly evidence_kind: EvidenceReference["kind"];
      readonly evidence_version: number;
      readonly sha256: string;
      readonly completed_at: Date | string;
    }>(
      `SELECT re.status, re.verified_by_user_account_id, re.verified_at,
              er.id AS evidence_id, er.document_id, er.evidence_kind, er.evidence_version,
              er.sha256, er.completed_at
         FROM abos.registration_evidence re
         JOIN abos.evidence_references er
           ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
        WHERE re.legal_entity_id = $1 AND re.capital_agreement_id = $2
        ORDER BY (re.status = 'VERIFIED') DESC, re.created_at DESC
        LIMIT 1`,
      [legalEntityId, agreementId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      agreementId,
      legalEntityId,
      evidence: evidenceOf(row),
      status: row.status,
      ...(row.verified_by_user_account_id === null
        ? {}
        : { verifiedByUserAccountId: row.verified_by_user_account_id }),
      ...(row.verified_at === null ? {} : { verifiedAt: iso(row.verified_at) })
    };
  }

  async findInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalInstallmentRecord | undefined> {
    const result = await this.database.query<{
      readonly id: CapitalInstallmentId;
      readonly capital_agreement_id: CapitalAgreementId;
      readonly legal_entity_id: LegalEntityId;
      readonly sequence_number: number;
      readonly expected_amount: string;
      readonly currency_code: SupportedCurrency;
      readonly status: CapitalInstallmentRecord["status"];
    }>(
      `SELECT id, capital_agreement_id, legal_entity_id, sequence_number,
              expected_amount::text AS expected_amount, currency_code, status
         FROM abos.capital_installments
        WHERE legal_entity_id = $1 AND id = $2`,
      [legalEntityId, installmentId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      agreementId: row.capital_agreement_id,
      legalEntityId: row.legal_entity_id,
      sequenceNumber: row.sequence_number,
      expectedAmount: money(row.expected_amount, row.currency_code),
      status: row.status,
      version: 1
    };
  }

  async listContributions(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ContributionHistoryEntry[]> {
    const result = await this.database.query<IntentRow>(
      `${INTENT_COLUMNS}
        WHERE cri.legal_entity_id = $1 AND cri.capital_agreement_id = $2
        ORDER BY cri.created_at`,
      [legalEntityId, agreementId]
    );
    return result.rows.map(historyOf);
  }

  async listDocuments(
    legalEntityId: LegalEntityId,
    agreementId: CapitalAgreementId
  ): Promise<readonly ControlledDocumentReference[]> {
    const result = await this.database.query<{
      readonly evidence_id: string;
      readonly document_id: string;
      readonly evidence_kind: EvidenceReference["kind"];
      readonly evidence_version: number;
      readonly sha256: string;
      readonly completed_at: Date | string;
    }>(
      `SELECT er.id AS evidence_id, er.document_id, er.evidence_kind, er.evidence_version,
              er.sha256, er.completed_at
         FROM abos.evidence_references er
         JOIN abos.registration_evidence re
           ON re.evidence_reference_id = er.id AND re.legal_entity_id = er.legal_entity_id
        WHERE er.legal_entity_id = $1 AND re.capital_agreement_id = $2
        UNION
       SELECT er.id, er.document_id, er.evidence_kind, er.evidence_version, er.sha256, er.completed_at
         FROM abos.evidence_references er
        WHERE er.legal_entity_id = $1
          AND er.evidence_kind = 'CAPITAL_AGREEMENT'
          AND EXISTS (SELECT 1 FROM abos.capital_agreements ca
                       WHERE ca.id = $2 AND ca.legal_entity_id = $1)`,
      [legalEntityId, agreementId]
    );
    return result.rows.map((row) => ({
      documentId: row.document_id as ControlledDocumentReference["documentId"],
      evidence: evidenceOf(row),
      legalEntityId
    }));
  }

  async findIntentByIdempotencyKey(
    legalEntityId: LegalEntityId,
    key: IdempotencyKey
  ): Promise<StoredIntentResult | undefined> {
    const result = await this.database.query<IntentRow>(
      `${INTENT_COLUMNS} WHERE cri.legal_entity_id = $1 AND cri.idempotency_key = $2`,
      [legalEntityId, key]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { requestHash: row.request_fingerprint, intent: intentOf(row) };
  }

  async findIntentByInstallment(
    legalEntityId: LegalEntityId,
    installmentId: CapitalInstallmentId
  ): Promise<CapitalReceiptIntent | undefined> {
    const result = await this.database.query<IntentRow>(
      `${INTENT_COLUMNS} WHERE cri.legal_entity_id = $1 AND cri.capital_installment_id = $2`,
      [legalEntityId, installmentId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : intentOf(row);
  }

  async findIntentById(
    legalEntityId: LegalEntityId,
    intentId: CapitalReceiptIntentId
  ): Promise<CapitalReceiptIntent | undefined> {
    const result = await this.database.query<IntentRow>(
      `${INTENT_COLUMNS} WHERE cri.legal_entity_id = $1 AND cri.id = $2`,
      [legalEntityId, intentId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : intentOf(row);
  }

  async saveIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly requestHash: string;
    readonly idempotencyKey: IdempotencyKey;
    readonly correlationId: CorrelationId;
    readonly history: ContributionHistoryEntry;
  }): Promise<void> {
    const { intent } = input;
    const legalEntityId = intent.dimensions.legalEntityId;
    const evidenceReferenceId = firstEvidenceId(intent);

    await this.database.transaction(async (transaction) => {
      // The commitment ceiling is enforced by a row-locked trigger on this INSERT (F-4), and the
      // one-intent-per-installment rule by a unique constraint. Neither is re-implemented here.
      await transaction.query(
        `INSERT INTO abos.capital_receipt_intents
           (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id,
            capital_installment_id, amount, currency_code, destination_cash_account_id,
            evidence_reference_id, correlation_id, idempotency_key, request_fingerprint,
            business_event_at, status, classification, contribution_state, version,
            created_by_user_account_id)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          intent.id,
          legalEntityId,
          intent.shareholderPartyId,
          intent.agreementId,
          intent.installmentId,
          intent.amount.amount,
          intent.amount.currency,
          intent.expectedDestinationAccountId,
          evidenceReferenceId,
          input.correlationId,
          input.idempotencyKey,
          input.requestHash,
          intent.businessEventAt,
          intent.status,
          input.history.classification,
          input.history.state,
          intent.version,
          this.actorUserAccountId
        ]
      );
      await this.appendHistory(transaction, intent, input.history);
    });
  }

  async updateIntent(input: {
    readonly intent: CapitalReceiptIntent;
    readonly history: ContributionHistoryEntry;
  }): Promise<void> {
    const { intent, history } = input;
    const legalEntityId = intent.dimensions.legalEntityId;

    await this.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE abos.capital_receipt_intents
            SET status = $3,
                contribution_state = $4,
                classification = $5,
                treasury_cash_receipt_id = $6,
                journal_id = $7,
                version = $8,
                updated_at = clock_timestamp()
          WHERE legal_entity_id = $1
            AND id = $2
            AND version < $8`,
        [
          legalEntityId,
          intent.id,
          intent.status,
          history.state,
          history.classification,
          history.treasuryReceiptId ?? null,
          history.journalId ?? null,
          intent.version
        ]
      );
      if (updated.rowCount === 0) {
        // Either the intent is gone or another writer already advanced it. Both are conflicts the
        // caller must see; silently succeeding would lose a transition.
        throw new Error(
          `Capital receipt intent ${intent.id} was not advanced to version ${intent.version}; ` +
            "it is missing or was concurrently modified"
        );
      }
      await this.appendHistory(transaction, intent, history);
    });
  }

  private async appendHistory(
    transaction: SqlExecutor,
    intent: CapitalReceiptIntent,
    history: ContributionHistoryEntry
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO abos.capital_receipt_intent_history
         (id, capital_receipt_intent_id, legal_entity_id, version, status, contribution_state,
          classification, amount, currency_code, treasury_cash_receipt_id, journal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11)`,
      [
        this.newId(),
        intent.id,
        intent.dimensions.legalEntityId,
        intent.version,
        intent.status,
        history.state,
        history.classification,
        intent.amount.amount,
        intent.amount.currency,
        history.treasuryReceiptId ?? null,
        history.journalId ?? null
      ]
    );
  }
}

const INTENT_COLUMNS = `
  SELECT cri.id, cri.legal_entity_id, cri.shareholder_business_party_id, cri.capital_agreement_id,
         cri.capital_installment_id, cri.amount::text AS amount, cri.currency_code,
         cri.destination_cash_account_id, cri.evidence_reference_id, cri.correlation_id,
         cri.idempotency_key, cri.request_fingerprint, cri.business_event_at, cri.status,
         cri.classification, cri.contribution_state, cri.treasury_cash_receipt_id, cri.journal_id,
         cri.version, cri.created_at,
         er.id AS evidence_id, er.document_id, er.evidence_kind, er.evidence_version,
         er.sha256, er.completed_at
    FROM abos.capital_receipt_intents cri
    JOIN abos.evidence_references er
      ON er.id = cri.evidence_reference_id AND er.legal_entity_id = cri.legal_entity_id`;

interface IntentRow {
  readonly id: CapitalReceiptIntentId;
  readonly legal_entity_id: LegalEntityId;
  readonly shareholder_business_party_id: string;
  readonly capital_agreement_id: CapitalAgreementId;
  readonly capital_installment_id: CapitalInstallmentId;
  readonly amount: string;
  readonly currency_code: SupportedCurrency;
  readonly destination_cash_account_id: string;
  readonly evidence_reference_id: string;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly business_event_at: Date | string;
  readonly status: CapitalReceiptIntent["status"];
  readonly classification: ContributionHistoryEntry["classification"];
  readonly contribution_state: ContributionHistoryEntry["state"];
  readonly treasury_cash_receipt_id: string | null;
  readonly journal_id: string | null;
  readonly version: number;
  readonly evidence_id: string;
  readonly document_id: string;
  readonly evidence_kind: EvidenceReference["kind"];
  readonly evidence_version: number;
  readonly sha256: string;
  readonly completed_at: Date | string;
}

function intentOf(row: IntentRow): CapitalReceiptIntent {
  return {
    id: row.id,
    shareholderPartyId: row.shareholder_business_party_id as CapitalReceiptIntent["shareholderPartyId"],
    agreementId: row.capital_agreement_id,
    installmentId: row.capital_installment_id,
    dimensions: {
      scope: "COMPANY_LEVEL",
      legalEntityId: row.legal_entity_id,
      companyLevelReason: "CORPORATE_CAPITAL"
    },
    expectedDestinationAccountId:
      row.destination_cash_account_id as CapitalReceiptIntent["expectedDestinationAccountId"],
    amount: money(row.amount, row.currency_code),
    status: row.status,
    evidence: [evidenceOf(row)],
    businessEventAt: iso(row.business_event_at),
    version: row.version
  };
}

function historyOf(row: IntentRow): ContributionHistoryEntry {
  return {
    intentId: row.id,
    agreementId: row.capital_agreement_id,
    installmentId: row.capital_installment_id,
    shareholderPartyId: row.shareholder_business_party_id as ContributionHistoryEntry["shareholderPartyId"],
    legalEntityId: row.legal_entity_id,
    amount: money(row.amount, row.currency_code),
    state: row.contribution_state,
    classification: row.classification,
    businessEventAt: iso(row.business_event_at),
    ...(row.treasury_cash_receipt_id === null
      ? {}
      : { treasuryReceiptId: row.treasury_cash_receipt_id }),
    ...(row.journal_id === null ? {} : { journalId: row.journal_id })
  };
}

function evidenceOf(row: {
  readonly evidence_id: string;
  readonly document_id: string;
  readonly evidence_kind: EvidenceReference["kind"];
  readonly evidence_version: number;
  readonly sha256: string;
  readonly completed_at: Date | string;
}): EvidenceReference {
  return {
    id: row.evidence_id as EvidenceReference["id"],
    documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind,
    version: row.evidence_version,
    sha256: row.sha256,
    completedAt: iso(row.completed_at)
  };
}

function firstEvidenceId(intent: CapitalReceiptIntent): string {
  const reference = intent.evidence[0];
  if (reference === undefined) {
    throw new Error("A capital receipt intent must carry at least one evidence reference");
  }
  return reference.id;
}

function money(amount: string, currency: SupportedCurrency): Money {
  return { amount: amount as Money["amount"], currency };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
