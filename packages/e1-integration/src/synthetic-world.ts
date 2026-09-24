import { randomUUID } from "node:crypto";
import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashReceiptId,
  LegalEntityId,
  UserAccountId
} from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresTreasuryRepository } from "@abos/persistence";
import { SandboxAuthenticator, type SandboxAuthConfiguration } from "@abos/sandbox-auth";
import { TreasuryService, type TreasuryActor } from "@abos/treasury";

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
 *
 * Treasury is not stood in for. The safe, its USD and AFN accounts, the cashier assignment and the
 * opening reconciliation are created through `TreasuryService` against migration 0006, by separate
 * synthetic people, exactly as the real workflow requires. The USD account is activated; the AFN
 * account is opened and deliberately left DRAFT, to show the two are independent.
 *
 * The opening count of the synthetic safe is recorded as 0.00: a new, empty synthetic safe. It is
 * not, and must not be read as, any real opening position.
 */

/** Synthetic sandbox credentials shared by the seed and the suites. Test-only; never deployed. */
export const SYNTHETIC_AUTH_CONFIGURATION: SandboxAuthConfiguration = {
  runtimeMarker: "synthetic-e1-sandbox-marker",
  signingSecret: "synthetic-e1-signing-secret-at-least-32-chars",
  environment: "test",
  maxSessionSeconds: 900
};

export interface SyntheticWorld {
  readonly companyId: string;
  readonly legalEntityId: string;
  readonly runtimeMarker: string;
  readonly policyVersionId: string;
  /** The sandbox configuration this world was authorized for; sessions are issued against it. */
  readonly authConfiguration: SandboxAuthConfiguration;

  readonly bootstrapUserId: string;
  readonly intentCreatorId: string;
  readonly approverId: string;
  readonly cashierId: string;
  readonly counterId: string;
  readonly countConfirmerId: string;
  readonly reverserId: string;
  readonly treasuryManagerId: string;
  readonly treasuryReconcilerId: string;
  readonly treasuryApproverId: string;

  readonly accountingPeriodId: string;
  readonly cashLedgerAccountId: string;
  readonly capitalLedgerAccountId: string;
  readonly cashLocationId: string;
  readonly cashAccountId: string;
  /** Opened, never activated: the AFN account of the same safe stays DRAFT. */
  readonly afnCashAccountId: string;
  readonly afnCashLedgerAccountId: string;

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
  readonly openingCountEvidenceId: string;

  readonly committedAmount: string;
  readonly installmentAmount: string;
  readonly accountingEffectiveDate: string;
}

export interface SeedOptions {
  /** Defaults to SYNTHETIC_AUTH_CONFIGURATION (environment "test"). The dev sandbox passes its own. */
  readonly authConfiguration?: SandboxAuthConfiguration;
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
  const authConfiguration = options.authConfiguration ?? SYNTHETIC_AUTH_CONFIGURATION;
  const world: SyntheticWorld = {
    authConfiguration,
    companyId: randomUUID(),
    legalEntityId: randomUUID(),
    runtimeMarker: options.runtimeMarker ?? authConfiguration.runtimeMarker ?? DEFAULT_MARKER,
    policyVersionId: "synthetic-e1-policy-v1",
    bootstrapUserId: randomUUID(),
    intentCreatorId: randomUUID(),
    approverId: randomUUID(),
    cashierId: randomUUID(),
    counterId: randomUUID(),
    countConfirmerId: randomUUID(),
    reverserId: randomUUID(),
    treasuryManagerId: randomUUID(),
    treasuryReconcilerId: randomUUID(),
    treasuryApproverId: randomUUID(),
    accountingPeriodId: randomUUID(),
    cashLedgerAccountId: randomUUID(),
    capitalLedgerAccountId: randomUUID(),
    cashLocationId: randomUUID(),
    cashAccountId: randomUUID(),
    afnCashAccountId: randomUUID(),
    afnCashLedgerAccountId: randomUUID(),
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
    openingCountEvidenceId: randomUUID(),
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
    [world.reverserId, "Synthetic Reversal Approver"],
    [world.treasuryManagerId, "Synthetic Treasury Manager"],
    [world.treasuryReconcilerId, "Synthetic Treasury Reconciler"],
    [world.treasuryApproverId, "Synthetic Treasury Approver"]
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
       VALUES (true, $4, 'SYNTHETIC_TEST_ONLY', $1, $2, $3,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [world.policyVersionId, world.runtimeMarker, world.bootstrapUserId, authConfiguration.environment]
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
    // Treasury roles. The cashier receives and counts; the verifier confirms and hands off.
    [world.cashierId, ["treasury.read", "treasury.cash-receipt.record", "treasury.cash-count.record"]],
    [world.counterId, ["treasury.read", "treasury.cash-count.record"]],
    [world.countConfirmerId, ["treasury.read", "treasury.cash-receipt.verify", "treasury.handoff.create"]],
    [world.treasuryManagerId, ["treasury.read", "treasury.cash-location.manage"]],
    [world.treasuryReconcilerId, ["treasury.read", "treasury.cash-account.reconcile"]],
    [world.treasuryApproverId, ["treasury.read", "treasury.cash-account.approve"]],
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
     VALUES ($1, $2, '1011-AFN', 'Synthetic Office Cash - AFN', 'ASSET', 'CASH', true, 'AFN', 'ACTIVE')`,
    [world.afnCashLedgerAccountId, world.legalEntityId]
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
    [world.openingEvidenceId, "OPENING_RECONCILIATION"],
    [world.openingCountEvidenceId, "PHYSICAL_CASH_COUNT"]
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

  if (options.withoutSandboxAuthorization === true) {
    // No sandbox, so Treasury cannot open a safe at all. The identifiers stay unused placeholders.
    return world;
  }
  return openSyntheticSafe(database, world);
}

/** A Treasury service acting as one synthetic person, with that person's own sandbox session. */
export async function treasuryAs(
  database: SqlExecutor,
  world: SyntheticWorld,
  userAccountId: string
): Promise<{ readonly service: TreasuryService; readonly actor: TreasuryActor; readonly token: string }> {
  const authenticator = new SandboxAuthenticator(database, world.authConfiguration);
  const session = await authenticator.issueSession({
    userAccountId: userAccountId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId
  });
  const context = await authenticator.authenticate(session.token);
  const actor: TreasuryActor = {
    userAccountId: context.userAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId,
    treasuryPermissions: context.treasuryPermissions ?? [],
    sessionId: session.sessionId
  };
  const repository = new PostgresTreasuryRepository(database, { authenticator, bearerToken: session.token });
  return { service: new TreasuryService(repository), actor, token: session.token };
}

/**
 * Opens the synthetic safe through the real Treasury workflow:
 * manager creates the safe and both currency accounts and assigns the cashier; the counter counts
 * the (empty) safe; the approver confirms that count; the reconciler reconciles the opening; the
 * approver approves it and activates USD. AFN is left DRAFT.
 */
async function openSyntheticSafe(database: SqlExecutor, world: SyntheticWorld): Promise<SyntheticWorld> {
  const manager = await treasuryAs(database, world, world.treasuryManagerId);
  const counter = await treasuryAs(database, world, world.counterId);
  const reconciler = await treasuryAs(database, world, world.treasuryReconcilerId);
  const approver = await treasuryAs(database, world, world.treasuryApproverId);

  const cashLocationId = await manager.service.createOfficeSafe(manager.actor, {
    name: "Synthetic Head Office Safe",
    responsibleCashierUserAccountId: world.cashierId as UserAccountId
  });
  await manager.service.activateSafe(manager.actor, cashLocationId);
  const cashAccountId = await manager.service.openCurrencyAccount(manager.actor, { cashLocationId, currency: "USD" });
  const afnCashAccountId = await manager.service.openCurrencyAccount(manager.actor, { cashLocationId, currency: "AFN" });
  await manager.service.assignCashier(manager.actor, { cashLocationId, userAccountId: world.cashierId as UserAccountId });

  const openingCount = await counter.service.recordOpeningCount(counter.actor, {
    cashAccountId,
    countedAmount: "0.00",
    evidenceReferenceId: world.openingCountEvidenceId
  });
  await approver.service.confirmOpeningCount(approver.actor, openingCount);
  await reconciler.service.reconcileOpening(reconciler.actor, {
    cashAccountId,
    physicalCashCountId: openingCount,
    reconciliationEvidenceReferenceId: world.openingEvidenceId
  });
  await approver.service.approveOpening(approver.actor, cashAccountId);
  await approver.service.activateAccount(approver.actor, cashAccountId);

  return { ...world, cashLocationId, cashAccountId, afnCashAccountId };
}

/**
 * Treasury's part of the workflow, through the real Treasury services:
 * the assigned cashier records the receipt, counts it and submits it; an independent verifier
 * confirms the count and verifies the receipt. It stops short of the handoff to Finance, which is
 * `handOffSyntheticReceipt`, so tests can exercise the gap between verification and handoff.
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
  const cashier = await treasuryAs(database, world, world.cashierId);
  const verifier = await treasuryAs(database, world, world.countConfirmerId);

  const cashReceiptId = await cashier.service.recordReceipt(cashier.actor, {
    capitalReceiptIntentId: input.capitalReceiptIntentId as CapitalReceiptIntentId,
    receiptReference: `RCPT-SYN-${randomUUID().slice(0, 8)}`,
    businessEventAt: "2026-09-22T07:10:00.000Z"
  });
  const physicalCashCountId = await cashier.service.countReceipt(cashier.actor, {
    receiptId: cashReceiptId,
    countedAmount: input.countedAmount ?? input.amount,
    countEvidenceReferenceId: world.countEvidenceId,
    receiptEvidenceReferenceId: world.receiptEvidenceId
  });
  await cashier.service.submitForVerification(cashier.actor, cashReceiptId);
  await verifier.service.verifyReceipt(verifier.actor, cashReceiptId);
  return { cashReceiptId, physicalCashCountId };
}

/** Step 7: the independent verifier hands the verified receipt to Finance. */
export async function handOffSyntheticReceipt(
  database: SqlExecutor,
  world: SyntheticWorld,
  cashReceiptId: string
): Promise<string> {
  const verifier = await treasuryAs(database, world, world.countConfirmerId);
  return verifier.service.handOffToFinance(verifier.actor, { receiptId: cashReceiptId as CashReceiptId });
}

export type { CashLocationCurrencyAccountId };

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
