import type { SqlExecutor } from "@abos/database";
import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  EvidenceReference,
  LegalEntityId,
  Money,
  PhysicalCashCountId,
  SupportedCurrency,
  TreasuryPermission,
  UserAccountId,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import type { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import {
  TreasuryDomainError,
  type CapitalReceiptSource,
  type CashAccountOpeningRecord,
  type CashAccountRecord,
  type CashLocationRecord,
  type CashierAssignmentRecord,
  type PhysicalCashCountRecord,
  type ReceiptTrace,
  type TreasuryActor,
  type TreasuryEventRecord,
  type TreasuryHandoffRecord,
  type TreasuryReceipt,
  type TreasuryRepository
} from "@abos/treasury";
import { PostgresShareholderRepository } from "./shareholder-repository.ts";

/** The request's credential, rechecked inside every Treasury write transaction. */
export interface TreasuryWriteAuthority {
  readonly authenticator: SandboxAuthenticator;
  readonly bearerToken: string;
}

/**
 * Durable Treasury adapter.
 *
 * Each write is one transaction that (1) names the acting user in `abos.actor_user_account_id`,
 * (2) rechecks the bearer session, the sandbox gate and the specific Treasury grant with row locks,
 * and then (3) issues plain SQL whose rules are enforced by migration 0006's triggers. The adapter
 * does not restate those rules - the service states them for early, typed refusals, and the
 * database states them authoritatively.
 *
 * Reads never need the credential. Writes without one are refused rather than attempted.
 *
 * Nothing here writes a journal, a journal line, a subledger entry or a ledger account.
 */
export class PostgresTreasuryRepository implements TreasuryRepository {
  private readonly database: SqlExecutor;
  private readonly authority: TreasuryWriteAuthority | undefined;
  private readonly newId: () => string;

  constructor(
    database: SqlExecutor,
    authority?: TreasuryWriteAuthority,
    newId: () => string = () => crypto.randomUUID()
  ) {
    this.database = database;
    this.authority = authority;
    this.newId = newId;
  }

  // ------------------------------------------------------------------------- reads

  async listLocations(legalEntityId: LegalEntityId): Promise<readonly CashLocationRecord[]> {
    const result = await this.database.query<LocationRow>(
      `${LOCATION_SQL} WHERE legal_entity_id = $1 ORDER BY location_name`, [legalEntityId]);
    return result.rows.map(locationOf);
  }

  async findLocation(legalEntityId: LegalEntityId, id: CashLocationId): Promise<CashLocationRecord | undefined> {
    const result = await this.database.query<LocationRow>(
      `${LOCATION_SQL} WHERE legal_entity_id = $1 AND id = $2`, [legalEntityId, id]);
    const row = result.rows[0];
    return row === undefined ? undefined : locationOf(row);
  }

  async listAccounts(legalEntityId: LegalEntityId, locationId?: CashLocationId): Promise<readonly CashAccountRecord[]> {
    const result = await this.database.query<AccountRow>(
      `${ACCOUNT_SQL} WHERE legal_entity_id = $1 AND ($2::uuid IS NULL OR cash_location_id = $2)
        ORDER BY cash_location_id, currency_code DESC`,
      [legalEntityId, locationId ?? null]);
    return result.rows.map(accountOf);
  }

  async findAccount(legalEntityId: LegalEntityId, id: CashLocationCurrencyAccountId): Promise<CashAccountRecord | undefined> {
    const result = await this.database.query<AccountRow>(
      `${ACCOUNT_SQL} WHERE legal_entity_id = $1 AND id = $2`, [legalEntityId, id]);
    const row = result.rows[0];
    return row === undefined ? undefined : accountOf(row);
  }

  async listAssignments(legalEntityId: LegalEntityId, locationId: CashLocationId): Promise<readonly CashierAssignmentRecord[]> {
    const result = await this.database.query<{
      readonly id: string; readonly legal_entity_id: LegalEntityId; readonly cash_location_id: CashLocationId;
      readonly user_account_id: UserAccountId; readonly assigned_by_user_account_id: UserAccountId;
      readonly assigned_at: Date | string; readonly revoked_at: Date | string | null;
    }>(
      `SELECT id, legal_entity_id, cash_location_id, user_account_id, assigned_by_user_account_id,
              assigned_at, revoked_at
         FROM abos.cash_location_cashier_assignments
        WHERE legal_entity_id = $1 AND cash_location_id = $2
        ORDER BY assigned_at`, [legalEntityId, locationId]);
    return result.rows.map((row) => ({
      id: row.id, legalEntityId: row.legal_entity_id, cashLocationId: row.cash_location_id,
      userAccountId: row.user_account_id, assignedByUserAccountId: row.assigned_by_user_account_id,
      assignedAt: iso(row.assigned_at), ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) })
    }));
  }

  async findOpening(legalEntityId: LegalEntityId, accountId: CashLocationCurrencyAccountId): Promise<CashAccountOpeningRecord | undefined> {
    const result = await this.database.query<{
      readonly cash_location_currency_account_id: CashLocationCurrencyAccountId; readonly legal_entity_id: LegalEntityId;
      readonly currency_code: SupportedCurrency; readonly opening_counted_amount: string;
      readonly physical_cash_count_id: PhysicalCashCountId; readonly reconciliation_evidence_reference_id: string;
      readonly reconciled_by_user_account_id: UserAccountId; readonly approved_by_user_account_id: UserAccountId | null;
      readonly status: "RECONCILED" | "APPROVED";
    }>(
      `SELECT cash_location_currency_account_id, legal_entity_id, currency_code,
              opening_counted_amount::text AS opening_counted_amount, physical_cash_count_id,
              reconciliation_evidence_reference_id, reconciled_by_user_account_id,
              approved_by_user_account_id, status
         FROM abos.cash_account_openings
        WHERE legal_entity_id = $1 AND cash_location_currency_account_id = $2`, [legalEntityId, accountId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      cashAccountId: row.cash_location_currency_account_id, legalEntityId: row.legal_entity_id,
      currency: row.currency_code, openingCountedAmount: row.opening_counted_amount,
      physicalCashCountId: row.physical_cash_count_id,
      reconciliationEvidenceReferenceId: row.reconciliation_evidence_reference_id,
      reconciledByUserAccountId: row.reconciled_by_user_account_id,
      ...(row.approved_by_user_account_id === null ? {} : { approvedByUserAccountId: row.approved_by_user_account_id }),
      status: row.status
    };
  }

  async findCount(legalEntityId: LegalEntityId, id: PhysicalCashCountId): Promise<PhysicalCashCountRecord | undefined> {
    const result = await this.database.query<CountRow>(
      `${COUNT_SQL} WHERE legal_entity_id = $1 AND id = $2`, [legalEntityId, id]);
    const row = result.rows[0];
    return row === undefined ? undefined : countOf(row);
  }

  async listSources(legalEntityId: LegalEntityId): Promise<readonly CapitalReceiptSource[]> {
    const result = await this.database.query<SourceRow>(
      `${SOURCE_SQL} WHERE cri.legal_entity_id = $1 ORDER BY cri.created_at DESC`, [legalEntityId]);
    return result.rows.map(sourceOf);
  }

  async findSource(legalEntityId: LegalEntityId, id: CapitalReceiptIntentId): Promise<CapitalReceiptSource | undefined> {
    const result = await this.database.query<SourceRow>(
      `${SOURCE_SQL} WHERE cri.legal_entity_id = $1 AND cri.id = $2`, [legalEntityId, id]);
    const row = result.rows[0];
    return row === undefined ? undefined : sourceOf(row);
  }

  async listReceipts(legalEntityId: LegalEntityId): Promise<readonly TreasuryReceipt[]> {
    const result = await this.database.query<ReceiptRow>(
      `${RECEIPT_SQL} WHERE cr.legal_entity_id = $1 AND cr.capital_receipt_intent_id IS NOT NULL
        ORDER BY cr.created_at DESC`, [legalEntityId]);
    return result.rows.map(receiptOf);
  }

  async findReceipt(legalEntityId: LegalEntityId, id: CashReceiptId): Promise<TreasuryReceipt | undefined> {
    const result = await this.database.query<ReceiptRow>(
      `${RECEIPT_SQL} WHERE cr.legal_entity_id = $1 AND cr.id = $2`, [legalEntityId, id]);
    const row = result.rows[0];
    return row === undefined ? undefined : receiptOf(row);
  }

  async findHandoff(legalEntityId: LegalEntityId, receiptId: CashReceiptId): Promise<TreasuryHandoffRecord | undefined> {
    const result = await this.database.query<{
      readonly id: string; readonly legal_entity_id: LegalEntityId; readonly cash_receipt_id: CashReceiptId;
      readonly capital_receipt_intent_id: CapitalReceiptIntentId; readonly handed_off_by_user_account_id: UserAccountId;
      readonly handed_off_at: Date | string;
    }>(
      `SELECT id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id,
              handed_off_by_user_account_id, handed_off_at
         FROM abos.treasury_finance_handoffs
        WHERE legal_entity_id = $1 AND cash_receipt_id = $2`, [legalEntityId, receiptId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id, legalEntityId: row.legal_entity_id, cashReceiptId: row.cash_receipt_id,
      capitalReceiptIntentId: row.capital_receipt_intent_id,
      handedOffByUserAccountId: row.handed_off_by_user_account_id, handedOffAt: iso(row.handed_off_at),
      status: "READY_FOR_FINANCE"
    };
  }

  async findFinanceCashLedgerAccount(legalEntityId: LegalEntityId, currency: SupportedCurrency): Promise<string | undefined> {
    // Exactly one active, postable CASH ledger account in the currency. Zero or several means
    // Finance has not made the mapping unambiguous, and Treasury will not guess.
    const result = await this.database.query<{ readonly id: string }>(
      `SELECT id FROM abos.ledger_accounts
        WHERE legal_entity_id = $1 AND control_account_type = 'CASH' AND account_currency_code = $2
          AND status = 'ACTIVE' AND posting_allowed`, [legalEntityId, currency]);
    return result.rows.length === 1 ? result.rows[0]?.id : undefined;
  }

  async trace(legalEntityId: LegalEntityId, receiptId: CashReceiptId): Promise<ReceiptTrace | undefined> {
    const receipt = await this.findReceipt(legalEntityId, receiptId);
    if (receipt === undefined) return undefined;
    const source = await this.findSource(legalEntityId, receipt.capitalReceiptIntentId);
    if (source === undefined) return undefined;
    const count = receipt.physicalCashCountId === undefined
      ? undefined : await this.findCount(legalEntityId, receipt.physicalCashCountId);
    const handoff = await this.findHandoff(legalEntityId, receipt.id);
    const aggregates = [receipt.id, ...(count ? [count.id] : []), ...(handoff ? [handoff.id] : [])];
    const events = await this.database.query<{
      readonly id: string; readonly aggregate_type: string; readonly aggregate_id: string;
      readonly operation: "INSERT" | "UPDATE"; readonly from_status: string | null; readonly to_status: string | null;
      readonly actor_user_account_id: UserAccountId; readonly display_name: string; readonly occurred_at: Date | string;
    }>(
      `SELECT e.id, e.aggregate_type, e.aggregate_id, e.operation, e.from_status, e.to_status,
              e.actor_user_account_id, u.display_name, e.occurred_at
         FROM abos.treasury_events e
         JOIN abos.user_accounts u ON u.id = e.actor_user_account_id
        WHERE e.legal_entity_id = $1 AND e.aggregate_id = ANY($2::uuid[])
        ORDER BY e.occurred_at, e.id`, [legalEntityId, aggregates]);
    const eventRecords: TreasuryEventRecord[] = events.rows.map((row) => ({
      id: row.id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, operation: row.operation,
      ...(row.from_status === null ? {} : { fromStatus: row.from_status }),
      ...(row.to_status === null ? {} : { toStatus: row.to_status }),
      actorUserAccountId: row.actor_user_account_id, actorDisplayName: row.display_name,
      occurredAt: iso(row.occurred_at)
    }));
    return {
      receipt, source,
      ...(count === undefined ? {} : { count }),
      ...(handoff === undefined ? {} : { handoff }),
      ...(source.journalId === undefined || source.status !== "POSTED" ? {} : { postedJournalId: source.journalId }),
      events: eventRecords
    };
  }

  // ------------------------------------------------------------------------- writes

  async createLocation(actor: TreasuryActor, input: {
    readonly id: CashLocationId; readonly name: string; readonly responsibleCashierUserAccountId: UserAccountId;
  }): Promise<void> {
    await this.write(actor, "treasury.cash-location.manage", (tx) => tx.query(
      `INSERT INTO abos.cash_locations
         (id, legal_entity_id, location_name, responsible_cashier_user_account_id, status, location_kind)
       VALUES ($1, $2, $3, $4, 'DRAFT', 'OFFICE_SAFE')`,
      [input.id, actor.legalEntityId, input.name, input.responsibleCashierUserAccountId]));
  }

  async setLocationStatus(actor: TreasuryActor, id: CashLocationId, status: CashLocationRecord["status"]): Promise<void> {
    await this.write(actor, "treasury.cash-location.manage", (tx) => requireRow(tx.query(
      "UPDATE abos.cash_locations SET status = $3 WHERE legal_entity_id = $1 AND id = $2",
      [actor.legalEntityId, id, status]), "The cash location does not exist"));
  }

  async openAccount(actor: TreasuryActor, input: {
    readonly id: CashLocationCurrencyAccountId; readonly cashLocationId: CashLocationId;
    readonly currency: SupportedCurrency; readonly ledgerAccountId: string;
  }): Promise<void> {
    await this.write(actor, "treasury.cash-location.manage", (tx) => tx.query(
      `INSERT INTO abos.cash_location_currency_accounts
         (id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT')`,
      [input.id, actor.legalEntityId, input.cashLocationId, input.currency, input.ledgerAccountId]));
  }

  async assignCashier(actor: TreasuryActor, input: {
    readonly id: string; readonly cashLocationId: CashLocationId; readonly userAccountId: UserAccountId;
  }): Promise<void> {
    await this.write(actor, "treasury.cash-location.manage", (tx) => tx.query(
      `INSERT INTO abos.cash_location_cashier_assignments
         (id, legal_entity_id, cash_location_id, user_account_id, assigned_by_user_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.id, actor.legalEntityId, input.cashLocationId, input.userAccountId, actor.userAccountId]));
  }

  async revokeCashier(actor: TreasuryActor, assignmentId: string): Promise<void> {
    await this.write(actor, "treasury.cash-location.manage", (tx) => requireRow(tx.query(
      `UPDATE abos.cash_location_cashier_assignments
          SET revoked_at = clock_timestamp(), revoked_by_user_account_id = $3
        WHERE legal_entity_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [actor.legalEntityId, assignmentId, actor.userAccountId]), "No active assignment was found"));
  }

  async recordCount(actor: TreasuryActor, input: {
    readonly id: PhysicalCashCountId; readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly currency: SupportedCurrency; readonly countedAmount: string; readonly evidenceReferenceId: string;
    readonly purpose: "OPENING" | "RECEIPT";
  }): Promise<void> {
    await this.write(actor, "treasury.cash-count.record", (tx) => insertCount(tx, actor, input));
  }

  async confirmCount(actor: TreasuryActor, countId: PhysicalCashCountId): Promise<void> {
    await this.write(actor, "treasury.cash-account.approve", (tx) => requireRow(tx.query(
      `UPDATE abos.physical_cash_counts
          SET status = 'CONFIRMED', confirmed_by_user_account_id = $3, confirmed_at = clock_timestamp()
        WHERE legal_entity_id = $1 AND id = $2 AND status = 'RECORDED'`,
      [actor.legalEntityId, countId, actor.userAccountId]), "No RECORDED count was found"));
  }

  async reconcileOpening(actor: TreasuryActor, input: {
    readonly cashAccountId: CashLocationCurrencyAccountId; readonly currency: SupportedCurrency;
    readonly openingCountedAmount: string; readonly physicalCashCountId: PhysicalCashCountId;
    readonly reconciliationEvidenceReferenceId: string;
  }): Promise<void> {
    await this.write(actor, "treasury.cash-account.reconcile", async (tx) => {
      await tx.query(
        `INSERT INTO abos.cash_account_openings
           (cash_location_currency_account_id, legal_entity_id, currency_code, opening_counted_amount,
            physical_cash_count_id, reconciliation_evidence_reference_id, reconciled_by_user_account_id)
         VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)`,
        [input.cashAccountId, actor.legalEntityId, input.currency, input.openingCountedAmount,
         input.physicalCashCountId, input.reconciliationEvidenceReferenceId, actor.userAccountId]);
      await requireRow(tx.query(
        `UPDATE abos.cash_location_currency_accounts SET activation_status = 'RECONCILED'
          WHERE legal_entity_id = $1 AND id = $2 AND activation_status = 'DRAFT'`,
        [actor.legalEntityId, input.cashAccountId]), "The account is not DRAFT");
    });
  }

  async approveOpening(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId): Promise<void> {
    await this.write(actor, "treasury.cash-account.approve", async (tx) => {
      await requireRow(tx.query(
        `UPDATE abos.cash_account_openings
            SET status = 'APPROVED', approved_by_user_account_id = $3, approved_at = clock_timestamp()
          WHERE legal_entity_id = $1 AND cash_location_currency_account_id = $2 AND status = 'RECONCILED'`,
        [actor.legalEntityId, accountId, actor.userAccountId]), "No reconciled opening position was found");
      await requireRow(tx.query(
        `UPDATE abos.cash_location_currency_accounts SET activation_status = 'APPROVED'
          WHERE legal_entity_id = $1 AND id = $2 AND activation_status = 'RECONCILED'`,
        [actor.legalEntityId, accountId]), "The account is not RECONCILED");
    });
  }

  async activateAccount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId, evidenceReferenceId: string): Promise<void> {
    await this.write(actor, "treasury.cash-account.approve", (tx) => requireRow(tx.query(
      `UPDATE abos.cash_location_currency_accounts
          SET activation_status = 'ACTIVE', activated_by_user_account_id = $3, activated_at = clock_timestamp(),
              reconciliation_evidence_reference_id = $4
        WHERE legal_entity_id = $1 AND id = $2 AND activation_status = 'APPROVED'`,
      [actor.legalEntityId, accountId, actor.userAccountId, evidenceReferenceId]), "The account is not APPROVED"));
  }

  async recordReceipt(actor: TreasuryActor, input: {
    readonly id: CashReceiptId; readonly source: CapitalReceiptSource;
    readonly receiptReference: string; readonly businessEventAt: string;
  }): Promise<void> {
    const { source } = input;
    await this.write(actor, "treasury.cash-receipt.record", (tx) => tx.query(
      `INSERT INTO abos.cash_receipts
         (id, legal_entity_id, capital_installment_id, capital_receipt_intent_id,
          cash_location_currency_account_id, receipt_reference, amount, currency_code,
          business_event_at, received_by_user_account_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, 'DRAFT')`,
      [input.id, actor.legalEntityId, source.capitalInstallmentId, source.id,
       source.destinationCashAccountId, input.receiptReference, source.amount.amount,
       source.amount.currency, input.businessEventAt, actor.userAccountId]));
  }

  async countReceipt(actor: TreasuryActor, input: {
    readonly receiptId: CashReceiptId;
    readonly count: {
      readonly id: PhysicalCashCountId; readonly cashAccountId: CashLocationCurrencyAccountId;
      readonly currency: SupportedCurrency; readonly countedAmount: string; readonly evidenceReferenceId: string;
    };
    readonly receiptEvidenceReferenceId: string;
  }): Promise<void> {
    await this.write(actor, "treasury.cash-count.record", async (tx) => {
      await insertCount(tx, actor, { ...input.count, purpose: "RECEIPT" });
      await requireRow(tx.query(
        `UPDATE abos.cash_receipts
            SET status = 'COUNTED', physical_cash_count_id = $3, evidence_reference_id = $4
          WHERE legal_entity_id = $1 AND id = $2 AND status = 'DRAFT'`,
        [actor.legalEntityId, input.receiptId, input.count.id, input.receiptEvidenceReferenceId]),
        "The receipt is not DRAFT");
    });
  }

  async submitForVerification(actor: TreasuryActor, receiptId: CashReceiptId): Promise<void> {
    await this.write(actor, "treasury.cash-receipt.record", (tx) => requireRow(tx.query(
      `UPDATE abos.cash_receipts SET submitted_for_verification_at = clock_timestamp()
        WHERE legal_entity_id = $1 AND id = $2 AND status = 'COUNTED'
          AND submitted_for_verification_at IS NULL`,
      [actor.legalEntityId, receiptId]), "The receipt is not awaiting submission"));
  }

  async verifyReceipt(actor: TreasuryActor, receiptId: CashReceiptId, countId: PhysicalCashCountId): Promise<void> {
    await this.write(actor, "treasury.cash-receipt.verify", async (tx) => {
      // The same independent person confirms the physical count and verifies the receipt.
      await requireRow(tx.query(
        `UPDATE abos.physical_cash_counts
            SET status = 'CONFIRMED', confirmed_by_user_account_id = $3, confirmed_at = clock_timestamp()
          WHERE legal_entity_id = $1 AND id = $2 AND status = 'RECORDED'`,
        [actor.legalEntityId, countId, actor.userAccountId]), "The receipt's count is not RECORDED");
      await requireRow(tx.query(
        `UPDATE abos.cash_receipts
            SET status = 'VERIFIED', verified_by_user_account_id = $3, verified_at = clock_timestamp()
          WHERE legal_entity_id = $1 AND id = $2 AND status = 'COUNTED'`,
        [actor.legalEntityId, receiptId, actor.userAccountId]), "The receipt is not COUNTED");
    });
  }

  async voidReceipt(actor: TreasuryActor, receiptId: CashReceiptId, reason: string): Promise<void> {
    const permission: TreasuryPermission = actor.treasuryPermissions.includes("treasury.cash-receipt.verify")
      ? "treasury.cash-receipt.verify" : "treasury.cash-receipt.record";
    await this.write(actor, permission, (tx) => requireRow(tx.query(
      `UPDATE abos.cash_receipts
          SET status = 'VOIDED', voided_by_user_account_id = $3, voided_at = clock_timestamp(), void_reason = $4
        WHERE legal_entity_id = $1 AND id = $2 AND status IN ('DRAFT', 'COUNTED')`,
      [actor.legalEntityId, receiptId, actor.userAccountId, reason]), "The receipt cannot be voided"));
  }

  async handOffToFinance(actor: TreasuryActor, input: {
    readonly id: string; readonly receipt: TreasuryReceipt; readonly count: PhysicalCashCountRecord;
    readonly correlationId: string;
  }): Promise<void> {
    const { receipt, count } = input;
    await this.write(actor, "treasury.handoff.create", async (tx) => {
      const evidence = await loadEvidence(tx, receipt.evidenceReferenceId);
      const verified: VerifiedTreasuryReceipt = {
        id: receipt.id,
        capitalReceiptIntentId: receipt.capitalReceiptIntentId,
        destinationType: "CASH_LOCATION",
        destinationAccountId: receipt.cashAccountId,
        physicalCashCountId: count.id,
        amount: receipt.amount,
        cashierUserAccountId: receipt.receivedByUserAccountId,
        evidence: [evidence],
        verifiedAt: receipt.verifiedAt ?? new Date().toISOString(),
        status: "VERIFIED"
      };
      // The shareholder transition is the shareholder domain's own, run on this same transaction:
      // it re-checks `assertHandoffPreservesSource` and advances the intent's version.
      const shareholder = new CapitalReceiptIntentService(
        new PostgresShareholderRepository(tx, actor.userAccountId, this.newId));
      await shareholder.markTreasuryVerified({
        legalEntityId: actor.legalEntityId,
        intentId: receipt.capitalReceiptIntentId,
        receipt: verified
      });
      await tx.query(
        `INSERT INTO abos.treasury_finance_handoffs
           (id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id,
            handed_off_by_user_account_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.id, actor.legalEntityId, receipt.id, receipt.capitalReceiptIntentId,
         actor.userAccountId, input.correlationId]);
    });
  }

  private async write(
    actor: TreasuryActor,
    permission: TreasuryPermission,
    work: (transaction: SqlExecutor) => Promise<unknown>
  ): Promise<void> {
    const authority = this.authority;
    if (authority === undefined) {
      throw new TreasuryDomainError(
        "AUTHENTICATION_REQUIRED",
        "Treasury writes require the request's sandbox credential; this repository was opened read-only"
      );
    }
    await this.database.transaction(async (transaction) => {
      await transaction.query("SELECT set_config('abos.actor_user_account_id', $1, true)", [actor.userAccountId]);
      await authority.authenticator.revalidateTreasuryAuthority(transaction, {
        bearerToken: authority.bearerToken,
        userAccountId: actor.userAccountId,
        sessionId: actor.sessionId,
        legalEntityId: actor.legalEntityId,
        permission
      });
      await work(transaction);
    });
  }
}

// ---------------------------------------------------------------------------- helpers

async function insertCount(tx: SqlExecutor, actor: TreasuryActor, input: {
  readonly id: PhysicalCashCountId; readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly currency: SupportedCurrency; readonly countedAmount: string; readonly evidenceReferenceId: string;
  readonly purpose: "OPENING" | "RECEIPT";
}): Promise<void> {
  await tx.query(
    `INSERT INTO abos.physical_cash_counts
       (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
        counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
     VALUES ($1, $2, $3, $4, $5::numeric, clock_timestamp(), $6, $7, 'RECORDED', $8)`,
    [input.id, actor.legalEntityId, input.cashAccountId, input.currency, input.countedAmount,
     actor.userAccountId, input.evidenceReferenceId, input.purpose]);
}

async function requireRow(query: Promise<{ readonly rowCount: number }>, message: string): Promise<void> {
  const result = await query;
  if (result.rowCount !== 1) throw new TreasuryDomainError("NOT_FOUND", message);
}

async function loadEvidence(tx: SqlExecutor, id: string | undefined): Promise<EvidenceReference> {
  if (id === undefined) throw new TreasuryDomainError("EVIDENCE_REQUIRED", "The receipt has no evidence");
  const result = await tx.query<{
    readonly id: string; readonly document_id: string; readonly evidence_kind: EvidenceReference["kind"];
    readonly evidence_version: number; readonly sha256: string; readonly completed_at: Date | string;
  }>(
    `SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at
       FROM abos.evidence_references WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (row === undefined) throw new TreasuryDomainError("EVIDENCE_REQUIRED", "The receipt evidence is missing");
  return {
    id: row.id as EvidenceReference["id"], documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256, completedAt: iso(row.completed_at)
  };
}

const LOCATION_SQL = `
  SELECT id, legal_entity_id, location_name, location_kind, status, responsible_cashier_user_account_id
    FROM abos.cash_locations`;
interface LocationRow {
  readonly id: CashLocationId; readonly legal_entity_id: LegalEntityId; readonly location_name: string;
  readonly location_kind: "OFFICE_SAFE"; readonly status: CashLocationRecord["status"];
  readonly responsible_cashier_user_account_id: UserAccountId;
}
function locationOf(row: LocationRow): CashLocationRecord {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, name: row.location_name, kind: row.location_kind,
    status: row.status, responsibleCashierUserAccountId: row.responsible_cashier_user_account_id
  };
}

const ACCOUNT_SQL = `
  SELECT id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status,
         activated_by_user_account_id, activated_at
    FROM abos.cash_location_currency_accounts`;
interface AccountRow {
  readonly id: CashLocationCurrencyAccountId; readonly legal_entity_id: LegalEntityId;
  readonly cash_location_id: CashLocationId; readonly currency_code: SupportedCurrency;
  readonly ledger_account_id: string; readonly activation_status: CashAccountRecord["status"];
  readonly activated_by_user_account_id: UserAccountId | null; readonly activated_at: Date | string | null;
}
function accountOf(row: AccountRow): CashAccountRecord {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, cashLocationId: row.cash_location_id,
    currency: row.currency_code, ledgerAccountId: row.ledger_account_id, status: row.activation_status,
    ...(row.activated_by_user_account_id === null ? {} : { activatedByUserAccountId: row.activated_by_user_account_id }),
    ...(row.activated_at === null ? {} : { activatedAt: iso(row.activated_at) })
  };
}

const COUNT_SQL = `
  SELECT id, legal_entity_id, cash_location_currency_account_id, currency_code,
         counted_amount::text AS counted_amount, counted_at, counted_by_user_account_id,
         evidence_reference_id, count_purpose, status, confirmed_by_user_account_id, confirmed_at
    FROM abos.physical_cash_counts`;
interface CountRow {
  readonly id: PhysicalCashCountId; readonly legal_entity_id: LegalEntityId;
  readonly cash_location_currency_account_id: CashLocationCurrencyAccountId; readonly currency_code: SupportedCurrency;
  readonly counted_amount: string; readonly counted_at: Date | string; readonly counted_by_user_account_id: UserAccountId;
  readonly evidence_reference_id: string; readonly count_purpose: "OPENING" | "RECEIPT";
  readonly status: PhysicalCashCountRecord["status"]; readonly confirmed_by_user_account_id: UserAccountId | null;
  readonly confirmed_at: Date | string | null;
}
function countOf(row: CountRow): PhysicalCashCountRecord {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, cashAccountId: row.cash_location_currency_account_id,
    currency: row.currency_code, countedAmount: row.counted_amount, countedAt: iso(row.counted_at),
    countedByUserAccountId: row.counted_by_user_account_id, evidenceReferenceId: row.evidence_reference_id,
    purpose: row.count_purpose, status: row.status,
    ...(row.confirmed_by_user_account_id === null ? {} : { confirmedByUserAccountId: row.confirmed_by_user_account_id }),
    ...(row.confirmed_at === null ? {} : { confirmedAt: iso(row.confirmed_at) })
  };
}

const SOURCE_SQL = `
  SELECT cri.id, cri.legal_entity_id, cri.shareholder_business_party_id, bp.display_name,
         cri.capital_agreement_id, ca.agreement_reference, cri.capital_installment_id,
         ci.sequence_number, cri.amount::text AS amount, cri.currency_code,
         cri.destination_cash_account_id, cri.status, cri.treasury_cash_receipt_id, cri.journal_id,
         cri.business_event_at, cri.evidence_reference_id
    FROM abos.capital_receipt_intents cri
    JOIN abos.business_parties bp
      ON bp.id = cri.shareholder_business_party_id AND bp.legal_entity_id = cri.legal_entity_id
    JOIN abos.capital_agreements ca
      ON ca.id = cri.capital_agreement_id AND ca.legal_entity_id = cri.legal_entity_id
    JOIN abos.capital_installments ci
      ON ci.id = cri.capital_installment_id AND ci.legal_entity_id = cri.legal_entity_id`;
interface SourceRow {
  readonly id: CapitalReceiptIntentId; readonly legal_entity_id: LegalEntityId;
  readonly shareholder_business_party_id: string; readonly display_name: string;
  readonly capital_agreement_id: string; readonly agreement_reference: string;
  readonly capital_installment_id: string; readonly sequence_number: number; readonly amount: string;
  readonly currency_code: SupportedCurrency; readonly destination_cash_account_id: CashLocationCurrencyAccountId;
  readonly status: CapitalReceiptSource["status"]; readonly treasury_cash_receipt_id: CashReceiptId | null;
  readonly journal_id: string | null; readonly business_event_at: Date | string; readonly evidence_reference_id: string;
}
function sourceOf(row: SourceRow): CapitalReceiptSource {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, shareholderBusinessPartyId: row.shareholder_business_party_id,
    shareholderDisplayName: row.display_name, capitalAgreementId: row.capital_agreement_id,
    agreementReference: row.agreement_reference, capitalInstallmentId: row.capital_installment_id,
    installmentSequence: row.sequence_number, amount: money(row.amount, row.currency_code),
    destinationCashAccountId: row.destination_cash_account_id, status: row.status,
    ...(row.treasury_cash_receipt_id === null ? {} : { treasuryCashReceiptId: row.treasury_cash_receipt_id }),
    ...(row.journal_id === null ? {} : { journalId: row.journal_id }),
    businessEventAt: iso(row.business_event_at), evidenceReferenceId: row.evidence_reference_id
  };
}

const RECEIPT_SQL = `
  SELECT cr.id, cr.legal_entity_id, cr.capital_receipt_intent_id, cr.capital_installment_id,
         cr.cash_location_currency_account_id, account.cash_location_id, cr.receipt_reference,
         cr.amount::text AS amount, cr.currency_code, cr.business_event_at,
         cr.received_by_user_account_id, cr.physical_cash_count_id, cr.evidence_reference_id,
         cr.submitted_for_verification_at, cr.verified_by_user_account_id, cr.verified_at,
         cr.void_reason, cr.status
    FROM abos.cash_receipts cr
    JOIN abos.cash_location_currency_accounts account
      ON account.id = cr.cash_location_currency_account_id AND account.legal_entity_id = cr.legal_entity_id`;
interface ReceiptRow {
  readonly id: CashReceiptId; readonly legal_entity_id: LegalEntityId;
  readonly capital_receipt_intent_id: CapitalReceiptIntentId; readonly capital_installment_id: string;
  readonly cash_location_currency_account_id: CashLocationCurrencyAccountId; readonly cash_location_id: CashLocationId;
  readonly receipt_reference: string; readonly amount: string; readonly currency_code: SupportedCurrency;
  readonly business_event_at: Date | string; readonly received_by_user_account_id: UserAccountId;
  readonly physical_cash_count_id: PhysicalCashCountId | null; readonly evidence_reference_id: string | null;
  readonly submitted_for_verification_at: Date | string | null;
  readonly verified_by_user_account_id: UserAccountId | null; readonly verified_at: Date | string | null;
  readonly void_reason: string | null; readonly status: TreasuryReceipt["status"];
}
function receiptOf(row: ReceiptRow): TreasuryReceipt {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, capitalReceiptIntentId: row.capital_receipt_intent_id,
    capitalInstallmentId: row.capital_installment_id, cashAccountId: row.cash_location_currency_account_id,
    cashLocationId: row.cash_location_id, receiptReference: row.receipt_reference,
    amount: money(row.amount, row.currency_code), businessEventAt: iso(row.business_event_at),
    receivedByUserAccountId: row.received_by_user_account_id, status: row.status,
    ...(row.physical_cash_count_id === null ? {} : { physicalCashCountId: row.physical_cash_count_id }),
    ...(row.evidence_reference_id === null ? {} : { evidenceReferenceId: row.evidence_reference_id }),
    ...(row.submitted_for_verification_at === null ? {} : { submittedForVerificationAt: iso(row.submitted_for_verification_at) }),
    ...(row.verified_by_user_account_id === null ? {} : { verifiedByUserAccountId: row.verified_by_user_account_id }),
    ...(row.verified_at === null ? {} : { verifiedAt: iso(row.verified_at) }),
    ...(row.void_reason === null ? {} : { voidReason: row.void_reason })
  };
}

function money(amount: string, currency: SupportedCurrency): Money {
  return { amount: amount as Money["amount"], currency };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
