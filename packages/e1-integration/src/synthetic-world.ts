import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "@abos/database";

/**
 * A complete synthetic E1 world, built from nothing.
 *
 * Every identifier, name and amount here is invented. None of it represents a real AL-BERUNIY
 * company, shareholder, agreement, safe, ledger account or opening balance, and the ledger mapping
 * below is a test-only mapping, not the client's Chart of Accounts.
 *
 * The world is deliberately built in dependency order and with distinct people in every control
 * role, because the schema refuses anything else:
 *
 *   intent creator != approver != cashier != cash counter, and the poster is the approver.
 */

export interface SyntheticWorld {
  readonly companyId: string;
  readonly legalEntityId: string;
  readonly runtimeMarker: string;
  readonly policyVersionId: string;

  readonly bootstrapUserId: string;
  readonly intentCreatorId: string;
  readonly approverId: string;
  readonly cashierId: string;
  readonly counterId: string;
  readonly countConfirmerId: string;
  readonly reverserId: string;

  readonly accountingPeriodId: string;
  readonly cashLedgerAccountId: string;
  readonly capitalLedgerAccountId: string;
  readonly cashLocationId: string;
  readonly cashAccountId: string;

  readonly businessPartyId: string;
  readonly shareholderProfileId: string;
  readonly agreementId: string;
  readonly installmentId: string;

  readonly registrationEvidenceId: string;
  readonly agreementDocumentEvidenceId: string;
  readonly receiptEvidenceId: string;
  readonly countEvidenceId: string;
  readonly approvalEvidenceId: string;
  readonly reversalEvidenceId: string;
  readonly openingEvidenceId: string;

  readonly committedAmount: string;
  readonly installmentAmount: string;
  readonly accountingEffectiveDate: string;
}

export interface SeedOptions {
  readonly runtimeMarker?: string;
  /** Skip the sandbox authorization, to prove that finance mutation is impossible without it. */
  readonly withoutSandboxAuthorization?: boolean;
  /** Skip the funding decision, to prove that nothing is fundable without one. */
  readonly withoutFundingPolicy?: boolean;
  readonly committedAmount?: string;
  readonly installmentAmount?: string;
  readonly partialInstallmentsAllowed?: boolean;
  /** Which canonical statuses the recorded decision makes fundable. */
  readonly fundableStatuses?: readonly string[];
  readonly agreementStatus?: string;
}

const DEFAULT_MARKER = "synthetic-e1-sandbox-marker";

export async function seedSyntheticWorld(
  database: SqlExecutor,
  options: SeedOptions = {}
): Promise<SyntheticWorld> {
  const world: SyntheticWorld = {
    companyId: randomUUID(),
    legalEntityId: randomUUID(),
    runtimeMarker: options.runtimeMarker ?? DEFAULT_MARKER,
    policyVersionId: "synthetic-e1-policy-v1",
    bootstrapUserId: randomUUID(),
    intentCreatorId: randomUUID(),
    approverId: randomUUID(),
    cashierId: randomUUID(),
    counterId: randomUUID(),
    countConfirmerId: randomUUID(),
    reverserId: randomUUID(),
    accountingPeriodId: randomUUID(),
    cashLedgerAccountId: randomUUID(),
    capitalLedgerAccountId: randomUUID(),
    cashLocationId: randomUUID(),
    cashAccountId: randomUUID(),
    businessPartyId: randomUUID(),
    shareholderProfileId: randomUUID(),
    agreementId: randomUUID(),
    installmentId: randomUUID(),
    registrationEvidenceId: randomUUID(),
    agreementDocumentEvidenceId: randomUUID(),
    receiptEvidenceId: randomUUID(),
    countEvidenceId: randomUUID(),
    approvalEvidenceId: randomUUID(),
    reversalEvidenceId: randomUUID(),
    openingEvidenceId: randomUUID(),
    committedAmount: options.committedAmount ?? "100000.00",
    installmentAmount: options.installmentAmount ?? "25000.00",
    accountingEffectiveDate: "2026-09-22"
  };

  const q = (sql: string, parameters: readonly unknown[] = []) => database.query(sql, parameters);

  await q(
    `INSERT INTO abos.currencies (code, name, enabled) VALUES ('USD', 'US Dollar', true)
     ON CONFLICT (code) DO NOTHING`
  );
  await q(
    `INSERT INTO abos.currencies (code, name, enabled) VALUES ('AFN', 'Afghan Afghani', true)
     ON CONFLICT (code) DO NOTHING`
  );

  await q(
    `INSERT INTO abos.companies (id, code, name, status) VALUES ($1, $2, 'Synthetic Holding', 'ACTIVE')`,
    [world.companyId, `SYN-${world.companyId.slice(0, 8)}`]
  );
  await q(
    `INSERT INTO abos.legal_entities
       (id, company_id, code, name, base_currency_code, currency_policy_status)
     VALUES ($1, $2, $3, 'Synthetic Legal Entity', 'USD', 'APPROVED')`,
    [world.legalEntityId, world.companyId, `SLE-${world.legalEntityId.slice(0, 8)}`]
  );

  const people: readonly (readonly [string, string])[] = [
    [world.bootstrapUserId, "Sandbox Bootstrap"],
    [world.intentCreatorId, "Synthetic Intent Creator"],
    [world.approverId, "Synthetic Finance Approver"],
    [world.cashierId, "Synthetic Cashier"],
    [world.counterId, "Synthetic Cash Counter"],
    [world.countConfirmerId, "Synthetic Count Confirmer"],
    [world.reverserId, "Synthetic Reversal Approver"]
  ];
  for (const [userId, name] of people) {
    await q(
      `INSERT INTO abos.user_accounts (id, login_identifier, display_name, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [userId, `${name.toLowerCase().replace(/\s+/g, ".")}.${userId.slice(0, 8)}@synthetic.invalid`, name]
    );
  }

  if (options.withoutSandboxAuthorization !== true) {
    await q(
      `INSERT INTO abos.sandbox_authorizations
         (singleton, environment, configuration_state, policy_version_id, runtime_marker,
          authorized_by_user_account_id, authorized_at, expires_at)
       VALUES (true, 'test', 'SYNTHETIC_TEST_ONLY', $1, $2, $3,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [world.policyVersionId, world.runtimeMarker, world.bootstrapUserId]
    );
    await q(
      `INSERT INTO abos.sandbox_legal_entity_scopes
         (legal_entity_id, base_currency_code, authorized_by_user_account_id)
       VALUES ($1, 'USD', $2)`,
      [world.legalEntityId, world.bootstrapUserId]
    );
  }

  const grants: readonly (readonly [string, readonly string[]])[] = [
    [world.intentCreatorId, ["shareholder.capital-intent.create"]],
    [world.approverId, ["finance.posting-intent.approve", "finance.journal.post"]],
    [world.cashierId, ["treasury.cash-receipt.verify"]],
    [world.counterId, ["treasury.cash-count.record"]],
    [world.countConfirmerId, ["treasury.cash-receipt.verify"]],
    [world.reverserId, ["finance.journal.reverse"]]
  ];
  for (const [userId, permissions] of grants) {
    for (const permission of permissions) {
      await q(
        `INSERT INTO abos.user_permission_grants
           (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, world.legalEntityId, permission, world.bootstrapUserId]
      );
    }
  }

  await q(
    `INSERT INTO abos.accounting_periods
       (id, legal_entity_id, period_name, starts_on, ends_on, status,
        opened_by_user_account_id, opened_at)
     VALUES ($1, $2, '2026-09', '2026-09-01', '2026-09-30', 'OPEN', $3, clock_timestamp())`,
    [world.accountingPeriodId, world.legalEntityId, world.bootstrapUserId]
  );

  await q(
    `INSERT INTO abos.ledger_accounts
       (id, legal_entity_id, account_code, account_name, account_type, control_account_type,
        posting_allowed, account_currency_code, status)
     VALUES ($1, $2, '1010-USD', 'Synthetic Office Cash - USD', 'ASSET', 'CASH', true, 'USD', 'ACTIVE')`,
    [world.cashLedgerAccountId, world.legalEntityId]
  );
  await q(
    `INSERT INTO abos.ledger_accounts
       (id, legal_entity_id, account_code, account_name, account_type, control_account_type,
        posting_allowed, account_currency_code, status)
     VALUES ($1, $2, '3010-USD', 'Synthetic Paid-in Share Capital', 'EQUITY', 'SHAREHOLDER_CAPITAL',
             true, 'USD', 'ACTIVE')`,
    [world.capitalLedgerAccountId, world.legalEntityId]
  );

  const evidence: readonly (readonly [string, string])[] = [
    [world.registrationEvidenceId, "FORMAL_REGISTRATION"],
    [world.agreementDocumentEvidenceId, "CAPITAL_AGREEMENT"],
    [world.receiptEvidenceId, "CASH_RECEIPT"],
    [world.countEvidenceId, "PHYSICAL_CASH_COUNT"],
    [world.approvalEvidenceId, "FINANCE_APPROVAL"],
    [world.reversalEvidenceId, "REVERSAL_REASON"],
    [world.openingEvidenceId, "OPENING_RECONCILIATION"]
  ];
  for (const [evidenceId, kind] of evidence) {
    await q(
      `INSERT INTO abos.evidence_references
         (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
       VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp())`,
      [evidenceId, world.legalEntityId, randomUUID(), kind, sha256Of(evidenceId)]
    );
  }

  await q(
    `INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
     VALUES ($1, $2, 'Synthetic Shareholder One', $3, 'ACTIVE')`,
    [world.businessPartyId, world.legalEntityId, `SH-${world.businessPartyId.slice(0, 8)}`]
  );
  await q(
    `INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from)
     VALUES ($1, 'SHAREHOLDER', current_date - 30)`,
    [world.businessPartyId]
  );
  await q(
    `INSERT INTO abos.shareholder_profiles (id, legal_entity_id, business_party_id, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [world.shareholderProfileId, world.legalEntityId, world.businessPartyId]
  );

  await q(
    `INSERT INTO abos.capital_agreements
       (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind,
        committed_amount, currency_code, effective_on, status, partial_installments_allowed,
        created_by_user_account_id)
     VALUES ($1, $2, $3, $4, 'CAPITAL_CONTRIBUTION', $5::numeric, 'USD', '2026-09-01', $6, $7, $8)`,
    [
      world.agreementId,
      world.legalEntityId,
      world.shareholderProfileId,
      `SYN-CAP-${world.agreementId.slice(0, 8)}`,
      world.committedAmount,
      options.agreementStatus ?? "ELIGIBLE",
      options.partialInstallmentsAllowed ?? true,
      world.bootstrapUserId
    ]
  );
  await q(
    `INSERT INTO abos.registration_evidence
       (id, legal_entity_id, capital_agreement_id, evidence_reference_id, status,
        verified_by_user_account_id, verified_at)
     VALUES ($1, $2, $3, $4, 'VERIFIED', $5, clock_timestamp())`,
    [
      randomUUID(),
      world.legalEntityId,
      world.agreementId,
      world.registrationEvidenceId,
      world.bootstrapUserId
    ]
  );
  await q(
    `INSERT INTO abos.capital_installments
       (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code,
        due_on, business_event_at, status, created_by_user_account_id)
     VALUES ($1, $2, $3, 1, $4::numeric, 'USD', '2026-09-22', '2026-09-22T07:00:00Z',
             'PENDING_RECEIPT', $5)`,
    [
      world.installmentId,
      world.legalEntityId,
      world.agreementId,
      world.installmentAmount,
      world.bootstrapUserId
    ]
  );

  if (options.withoutFundingPolicy !== true) {
    await q(
      `INSERT INTO abos.capital_agreement_funding_policies
         (legal_entity_id, vocabulary_version, decision_reference, decided_by, fundable_statuses,
          decided_at)
       VALUES ($1, 'stage1-e0-v2', $2, 'SANDBOX_SYNTHETIC', $3::text[], clock_timestamp())`,
      [
        world.legalEntityId,
        "SANDBOX-SYNTHETIC-E1 (not a client Finance decision)",
        options.fundableStatuses ?? ["ELIGIBLE"]
      ]
    );
  }

  await q(
    `INSERT INTO abos.cash_locations
       (id, legal_entity_id, location_name, responsible_cashier_user_account_id, status)
     VALUES ($1, $2, 'Synthetic Head Office Safe', $3, 'ACTIVE')`,
    [world.cashLocationId, world.legalEntityId, world.cashierId]
  );
  await q(
    `INSERT INTO abos.cash_location_currency_accounts
       (id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status,
        reconciliation_evidence_reference_id, activated_by_user_account_id, activated_at)
     VALUES ($1, $2, $3, 'USD', $4, 'ACTIVE', $5, $6, clock_timestamp())`,
    [
      world.cashAccountId,
      world.legalEntityId,
      world.cashLocationId,
      world.cashLedgerAccountId,
      world.openingEvidenceId,
      world.bootstrapUserId
    ]
  );

  return world;
}

/**
 * Treasury's part of the workflow, stood in for until Antigravity's domain is available.
 *
 * This is explicitly a stand-in and not a Treasury implementation: it writes the two rows the
 * schema requires so the rest of the chain can be exercised, and it does not claim to be
 * Antigravity's logic. When `agent/antigravity/stage-1-e1-treasury` appears, its records replace
 * these and `assertHandoffPreservesSource` is what they must satisfy.
 */
export async function recordSyntheticTreasuryReceipt(
  database: SqlExecutor,
  world: SyntheticWorld,
  input: {
    readonly capitalReceiptIntentId: string;
    readonly amount: string;
    readonly countedAmount?: string;
  }
): Promise<{ readonly cashReceiptId: string; readonly physicalCashCountId: string }> {
  const physicalCashCountId = randomUUID();
  const cashReceiptId = randomUUID();

  await database.query(
    `INSERT INTO abos.physical_cash_counts
       (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
        counted_at, counted_by_user_account_id, evidence_reference_id, status,
        confirmed_by_user_account_id, confirmed_at)
     VALUES ($1, $2, $3, 'USD', $4::numeric, clock_timestamp(), $5, $6, 'CONFIRMED', $7,
             clock_timestamp())`,
    [
      physicalCashCountId,
      world.legalEntityId,
      world.cashAccountId,
      input.countedAmount ?? input.amount,
      world.counterId,
      world.countEvidenceId,
      world.countConfirmerId
    ]
  );

  await database.query(
    `INSERT INTO abos.cash_receipts
       (id, legal_entity_id, capital_installment_id, cash_location_currency_account_id,
        physical_cash_count_id, receipt_reference, amount, currency_code, business_event_at,
        received_by_user_account_id, evidence_reference_id, status, verified_by_user_account_id,
        verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, 'USD', '2026-09-22T07:10:00Z', $8, $9,
             'VERIFIED', $10, clock_timestamp())`,
    [
      cashReceiptId,
      world.legalEntityId,
      world.installmentId,
      world.cashAccountId,
      physicalCashCountId,
      `RCPT-${cashReceiptId.slice(0, 8)}`,
      input.amount,
      world.cashierId,
      world.receiptEvidenceId,
      world.countConfirmerId
    ]
  );

  // Deliberately does NOT touch abos.capital_receipt_intents. Treasury writes Treasury's rows; the
  // link from the intent to this receipt is written by the shareholder domain's own transition to
  // TREASURY_VERIFIED, which is also what advances the intent's version. An earlier draft of this
  // helper updated the intent directly and was refused by the immutability trigger, correctly.
  return { cashReceiptId, physicalCashCountId };
}

/** Finance's posting intent and its independent approval. */
export async function recordCapitalPostingIntent(
  database: SqlExecutor,
  world: SyntheticWorld,
  input: {
    readonly capitalReceiptIntentId: string;
    readonly cashReceiptId: string;
    readonly amount: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }
): Promise<string> {
  const postingIntentId = randomUUID();
  await database.query(
    `INSERT INTO abos.posting_intents
       (id, legal_entity_id, source_type, source_id, treasury_cash_receipt_id, intent_kind,
        original_amount, original_currency_code, base_amount, base_currency_code,
        accounting_effective_date, correlation_id, idempotency_key, status,
        created_by_user_account_id, capital_receipt_intent_id)
     VALUES ($1, $2, 'SHAREHOLDER_CAPITAL_INSTALLMENT', $3, $4, 'SHAREHOLDER_CAPITAL_RECEIPT',
             $5::numeric, 'USD', $5::numeric, 'USD', $6, $7, $8, 'DRAFT', $9, $3)`,
    [
      postingIntentId,
      world.legalEntityId,
      input.capitalReceiptIntentId,
      input.cashReceiptId,
      input.amount,
      world.accountingEffectiveDate,
      input.correlationId,
      input.idempotencyKey,
      world.intentCreatorId
    ]
  );
  await database.query("UPDATE abos.posting_intents SET status = 'APPROVED' WHERE id = $1", [
    postingIntentId
  ]);
  await database.query(
    `INSERT INTO abos.posting_approvals
       (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id,
        evidence_reference_id, approved_at)
     VALUES ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
    [
      randomUUID(),
      world.legalEntityId,
      postingIntentId,
      world.approverId,
      world.approvalEvidenceId
    ]
  );
  return postingIntentId;
}

function sha256Of(seed: string): string {
  return seed.replace(/-/g, "").padEnd(64, "0").slice(0, 64);
}

/** An extra installment on the same agreement, for concurrency tests. */
export async function addInstallment(
  database: SqlExecutor,
  world: SyntheticWorld,
  input: { readonly sequenceNumber: number; readonly expectedAmount: string }
): Promise<string> {
  const installmentId = randomUUID();
  await database.query(
    `INSERT INTO abos.capital_installments
       (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code,
        due_on, business_event_at, status, created_by_user_account_id)
     VALUES ($1, $2, $3, $4, $5::numeric, 'USD', '2026-09-22', '2026-09-22T07:00:00Z',
             'PENDING_RECEIPT', $6)`,
    [
      installmentId,
      world.legalEntityId,
      world.agreementId,
      input.sequenceNumber,
      input.expectedAmount,
      world.bootstrapUserId
    ]
  );
  return installmentId;
}
