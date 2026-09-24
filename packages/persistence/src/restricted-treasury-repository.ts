import type {
  CapitalReceiptIntentId, CashLocationCurrencyAccountId, CashLocationId, CashReceiptId,
  LegalEntityId, PhysicalCashCountId, SupportedCurrency, UserAccountId
} from "@abos/contracts";
import type {
  CapitalReceiptSource, CashAccountOpeningRecord, CashAccountRecord, CashLocationRecord,
  CashierAssignmentRecord, FinanceProgress, PhysicalCashCountRecord, ReceiptTrace,
  TreasuryActor, TreasuryEventRecord, TreasuryHandoffRecord, TreasuryReceipt, TreasuryRepository
} from "@abos/treasury";
import {
  RestrictedTreasuryGateway, type RestrictedTreasuryAuthority
} from "./restricted-treasury-gateway.ts";

type Row = Readonly<Record<string, unknown>>;

/** TreasuryRepository backed only by the restricted allowlisted database functions. */
export class RestrictedTreasuryRepository implements TreasuryRepository {
  private readonly gateway: RestrictedTreasuryGateway;
  private readonly authority: RestrictedTreasuryAuthority;

  constructor(
    gateway: RestrictedTreasuryGateway,
    authority: RestrictedTreasuryAuthority
  ) {
    this.gateway = gateway;
    this.authority = authority;
  }

  async listLocations(entity: LegalEntityId): Promise<readonly CashLocationRecord[]> {
    return (await this.rows(entity, "LOCATIONS")).map(locationOf);
  }
  async findLocation(entity: LegalEntityId, id: CashLocationId) {
    return first((await this.rows(entity, "LOCATIONS", id)).map(locationOf));
  }
  async listAccounts(entity: LegalEntityId, locationId?: CashLocationId) {
    return (await this.rows(entity, "ACCOUNTS", locationId)).map(accountOf);
  }
  async findAccount(entity: LegalEntityId, id: CashLocationCurrencyAccountId) {
    return first((await this.rows(entity, "ACCOUNTS", id)).map(accountOf));
  }
  async listAssignments(entity: LegalEntityId, locationId: CashLocationId) {
    return (await this.rows(entity, "ASSIGNMENTS", locationId)).map(assignmentOf);
  }
  async findOpening(entity: LegalEntityId, accountId: CashLocationCurrencyAccountId) {
    return first((await this.rows(entity, "OPENINGS", accountId)).map(openingOf));
  }
  async findCount(entity: LegalEntityId, id: PhysicalCashCountId) {
    return first((await this.rows(entity, "COUNTS", id)).map(countOf));
  }
  async listSources(entity: LegalEntityId) {
    return (await this.rows(entity, "SOURCES")).map(sourceOf);
  }
  async findSource(entity: LegalEntityId, id: CapitalReceiptIntentId) {
    return first((await this.rows(entity, "SOURCES", id)).map(sourceOf));
  }
  async listReceipts(entity: LegalEntityId) {
    return (await this.rows(entity, "RECEIPTS")).map(receiptOf);
  }
  async findReceipt(entity: LegalEntityId, id: CashReceiptId) {
    return first((await this.rows(entity, "RECEIPTS", id)).map(receiptOf));
  }
  async findHandoff(entity: LegalEntityId, receiptId: CashReceiptId) {
    return first((await this.rows(entity, "HANDOFFS", receiptId)).map(handoffOf));
  }
  async findFinanceCashLedgerAccount(entity: LegalEntityId, currency: SupportedCurrency) {
    const matches = (await this.rows(entity, "CASH_LEDGER"))
      .filter((row) => text(row, "account_currency_code") === currency);
    return matches.length === 1 ? text(matches[0]!, "id") : undefined;
  }
  async findFinanceProgress(entity: LegalEntityId, receiptId: CashReceiptId): Promise<FinanceProgress> {
    const row = first(await this.rows(entity, "FINANCE_PROGRESS", receiptId));
    if (row === undefined) return { decision: "NONE" };
    return {
      ...(nullableText(row, "posting_intent_status") === undefined ? {} :
        { postingIntentStatus: text(row, "posting_intent_status") as NonNullable<FinanceProgress["postingIntentStatus"]> }),
      decision: text(row, "decision") as FinanceProgress["decision"],
      ...(nullableText(row, "decided_by_user_account_id") === undefined ? {} :
        { decidedByUserAccountId: text(row, "decided_by_user_account_id") }),
      ...(nullableText(row, "decided_at") === undefined ? {} : { decidedAt: iso(row.decided_at) })
    };
  }
  async trace(entity: LegalEntityId, receiptId: CashReceiptId): Promise<ReceiptTrace | undefined> {
    const receipt = await this.findReceipt(entity, receiptId);
    if (receipt === undefined) return undefined;
    const source = await this.findSource(entity, receipt.capitalReceiptIntentId);
    if (source === undefined) return undefined;
    const count = receipt.physicalCashCountId === undefined ? undefined :
      await this.findCount(entity, receipt.physicalCashCountId);
    const handoff = await this.findHandoff(entity, receipt.id);
    const aggregateIds = new Set([receipt.id, count?.id, handoff?.id].filter(Boolean));
    const events = (await this.rows(entity, "EVENTS")).filter((row) =>
      aggregateIds.has(text(row, "aggregate_id"))).map(eventOf);
    const finance = await this.findFinanceProgress(entity, receipt.id);
    return { receipt, source, ...(count ? { count } : {}), ...(handoff ? { handoff } : {}),
      ...(source.status === "POSTED" && source.journalId ? { postedJournalId: source.journalId } : {}),
      finance, events };
  }

  async listEvidence(entity: LegalEntityId): Promise<readonly Row[]> { return this.rows(entity, "EVIDENCE"); }
  async listUsers(entity: LegalEntityId): Promise<readonly Row[]> { return this.rows(entity, "USERS"); }

  async createLocation(actor: TreasuryActor, input: { id: CashLocationId; name: string; responsibleCashierUserAccountId: UserAccountId }) {
    await this.command(actor, "CREATE_LOCATION", input);
  }
  async setLocationStatus(actor: TreasuryActor, id: CashLocationId, status: CashLocationRecord["status"]) {
    await this.command(actor, "SET_LOCATION_STATUS", { id, status });
  }
  async openAccount(actor: TreasuryActor, input: { id: CashLocationCurrencyAccountId; cashLocationId: CashLocationId; currency: SupportedCurrency; ledgerAccountId: string }) {
    await this.command(actor, "OPEN_ACCOUNT", input);
  }
  async assignCashier(actor: TreasuryActor, input: { id: string; cashLocationId: CashLocationId; userAccountId: UserAccountId }) {
    await this.command(actor, "ASSIGN_CASHIER", input);
  }
  async revokeCashier(actor: TreasuryActor, id: string) { await this.command(actor, "REVOKE_CASHIER", { id }); }
  async recordCount(actor: TreasuryActor, input: { id: PhysicalCashCountId; cashAccountId: CashLocationCurrencyAccountId; currency: SupportedCurrency; countedAmount: string; evidenceReferenceId: string; purpose: "OPENING" | "RECEIPT" }) {
    await this.command(actor, "RECORD_COUNT", input);
  }
  async confirmCount(actor: TreasuryActor, id: PhysicalCashCountId) { await this.command(actor, "CONFIRM_OPENING_COUNT", { id }); }
  async reconcileOpening(actor: TreasuryActor, input: { cashAccountId: CashLocationCurrencyAccountId; currency: SupportedCurrency; openingCountedAmount: string; physicalCashCountId: PhysicalCashCountId; reconciliationEvidenceReferenceId: string }) {
    await this.command(actor, "RECONCILE_OPENING", { ...input, id: input.cashAccountId });
  }
  async approveOpening(actor: TreasuryActor, id: CashLocationCurrencyAccountId) { await this.command(actor, "APPROVE_OPENING", { id }); }
  async activateAccount(actor: TreasuryActor, id: CashLocationCurrencyAccountId, evidenceReferenceId: string) {
    await this.command(actor, "ACTIVATE_ACCOUNT", { id, evidenceReferenceId });
  }
  async recordReceipt(actor: TreasuryActor, input: { id: CashReceiptId; source: CapitalReceiptSource; receiptReference: string; businessEventAt: string }) {
    await this.command(actor, "RECORD_RECEIPT", { id: input.id, capitalReceiptIntentId: input.source.id,
      receiptReference: input.receiptReference, businessEventAt: input.businessEventAt });
  }
  async countReceipt(actor: TreasuryActor, input: { receiptId: CashReceiptId; count: { id: PhysicalCashCountId; cashAccountId: CashLocationCurrencyAccountId; currency: SupportedCurrency; countedAmount: string; evidenceReferenceId: string }; receiptEvidenceReferenceId: string }) {
    await this.command(actor, "COUNT_RECEIPT", { id: input.receiptId, countId: input.count.id,
      countedAmount: input.count.countedAmount, countEvidenceReferenceId: input.count.evidenceReferenceId,
      receiptEvidenceReferenceId: input.receiptEvidenceReferenceId });
  }
  async submitForVerification(actor: TreasuryActor, id: CashReceiptId) { await this.command(actor, "SUBMIT_RECEIPT", { id }); }
  async verifyReceipt(actor: TreasuryActor, id: CashReceiptId, countId: PhysicalCashCountId) {
    await this.command(actor, "VERIFY_RECEIPT", { id, countId });
  }
  async voidReceipt(actor: TreasuryActor, id: CashReceiptId, reason: string) {
    const permission = actor.treasuryPermissions.includes("treasury.cash-receipt.verify") ?
      "treasury.cash-receipt.verify" : "treasury.cash-receipt.record";
    await this.command(actor, "VOID_RECEIPT", { id, reason, permission });
  }
  async handOffToFinance(actor: TreasuryActor, input: { id: string; receipt: TreasuryReceipt; count: PhysicalCashCountRecord; correlationId: string }) {
    await this.command(actor, "HANDOFF_RECEIPT", { id: input.receipt.id, handoffId: input.id,
      correlationId: input.correlationId });
  }

  private async rows(entity: LegalEntityId, query: Parameters<RestrictedTreasuryGateway["query"]>[1], id?: string) {
    this.entity(entity); return this.gateway.query<readonly Row[]>(this.authority, query, id);
  }
  private async command(actor: TreasuryActor, operation: Parameters<RestrictedTreasuryGateway["command"]>[1], payload: Record<string, unknown>) {
    this.entity(actor.legalEntityId);
    if (actor.userAccountId.length === 0) throw new Error("Treasury actor is required");
    await this.gateway.command(this.authority, operation, payload);
  }
  private entity(entity: LegalEntityId) {
    if (entity !== this.authority.legalEntityId) throw new Error("Treasury legal entity is outside the authenticated session");
  }
}

function first<T>(rows: readonly T[]): T | undefined { return rows[0]; }
function text(row: Row, key: string): string { const value=row[key]; if (typeof value!=="string") throw new Error(`Missing Treasury field ${key}`); return value; }
function nullableText(row: Row, key: string): string | undefined { const value=row[key]; return value===null || value===undefined ? undefined : String(value); }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function locationOf(r: Row): CashLocationRecord { return { id:text(r,"id") as CashLocationId, legalEntityId: text(r,"legal_entity_id") as LegalEntityId, name:text(r,"location_name"), kind:text(r,"location_kind") as "OFFICE_SAFE", status:text(r,"status") as CashLocationRecord["status"], responsibleCashierUserAccountId:text(r,"responsible_cashier_user_account_id") as UserAccountId }; }
function accountOf(r: Row): CashAccountRecord { return { id:text(r,"id") as CashLocationCurrencyAccountId, legalEntityId:text(r,"legal_entity_id") as LegalEntityId, cashLocationId:text(r,"cash_location_id") as CashLocationId, currency:text(r,"currency_code") as SupportedCurrency, ledgerAccountId:text(r,"ledger_account_id"), status:text(r,"activation_status") as CashAccountRecord["status"], ...(nullableText(r,"activated_by_user_account_id") ? { activatedByUserAccountId:text(r,"activated_by_user_account_id") as UserAccountId }:{}), ...(nullableText(r,"activated_at") ? { activatedAt:iso(r.activated_at) }: {}) }; }
function assignmentOf(r: Row): CashierAssignmentRecord { return { id:text(r,"id"), legalEntityId:text(r,"legal_entity_id") as LegalEntityId, cashLocationId:text(r,"cash_location_id") as CashLocationId, userAccountId:text(r,"user_account_id") as UserAccountId, assignedByUserAccountId:text(r,"assigned_by_user_account_id") as UserAccountId, assignedAt:iso(r.assigned_at), ...(nullableText(r,"revoked_at") ? { revokedAt:iso(r.revoked_at) }: {}) }; }
function openingOf(r: Row): CashAccountOpeningRecord { return { cashAccountId:text(r,"cash_location_currency_account_id") as CashLocationCurrencyAccountId, legalEntityId:text(r,"legal_entity_id") as LegalEntityId, currency:text(r,"currency_code") as SupportedCurrency, openingCountedAmount:text(r,"opening_counted_amount"), physicalCashCountId:text(r,"physical_cash_count_id") as PhysicalCashCountId, reconciliationEvidenceReferenceId:text(r,"reconciliation_evidence_reference_id"), reconciledByUserAccountId:text(r,"reconciled_by_user_account_id") as UserAccountId, ...(nullableText(r,"approved_by_user_account_id") ? { approvedByUserAccountId:text(r,"approved_by_user_account_id") as UserAccountId }:{}), status:text(r,"status") as CashAccountOpeningRecord["status"] }; }
function countOf(r: Row): PhysicalCashCountRecord { return { id:text(r,"id") as PhysicalCashCountId, legalEntityId:text(r,"legal_entity_id") as LegalEntityId, cashAccountId:text(r,"cash_location_currency_account_id") as CashLocationCurrencyAccountId, currency:text(r,"currency_code") as SupportedCurrency, countedAmount:text(r,"counted_amount"), countedAt:iso(r.counted_at), countedByUserAccountId:text(r,"counted_by_user_account_id") as UserAccountId, evidenceReferenceId:text(r,"evidence_reference_id"), purpose:text(r,"count_purpose") as PhysicalCashCountRecord["purpose"], status:text(r,"status") as PhysicalCashCountRecord["status"], ...(nullableText(r,"confirmed_by_user_account_id") ? { confirmedByUserAccountId:text(r,"confirmed_by_user_account_id") as UserAccountId }:{}), ...(nullableText(r,"confirmed_at") ? { confirmedAt:iso(r.confirmed_at) }: {}) }; }
function sourceOf(r: Row): CapitalReceiptSource { return { id:text(r,"id") as CapitalReceiptIntentId, legalEntityId:text(r,"legal_entity_id") as LegalEntityId, shareholderBusinessPartyId:text(r,"shareholder_business_party_id"), shareholderDisplayName:text(r,"display_name"), capitalAgreementId:text(r,"capital_agreement_id"), agreementReference:text(r,"agreement_reference"), capitalInstallmentId:text(r,"capital_installment_id"), installmentSequence:Number(r.sequence_number), amount:{ amount:text(r,"amount") as never, currency:text(r,"currency_code") as SupportedCurrency }, destinationCashAccountId:text(r,"destination_cash_account_id") as CashLocationCurrencyAccountId, status:text(r,"status") as CapitalReceiptSource["status"], ...(nullableText(r,"treasury_cash_receipt_id") ? { treasuryCashReceiptId:text(r,"treasury_cash_receipt_id") as CashReceiptId }:{}), ...(nullableText(r,"journal_id") ? { journalId:text(r,"journal_id") }:{}), businessEventAt:iso(r.business_event_at), evidenceReferenceId:text(r,"evidence_reference_id") }; }
function receiptOf(r: Row): TreasuryReceipt { return { id:text(r,"id") as CashReceiptId, legalEntityId:text(r,"legal_entity_id") as LegalEntityId, capitalReceiptIntentId:text(r,"capital_receipt_intent_id") as CapitalReceiptIntentId, capitalInstallmentId:text(r,"capital_installment_id"), cashAccountId:text(r,"cash_location_currency_account_id") as CashLocationCurrencyAccountId, cashLocationId:text(r,"cash_location_id") as CashLocationId, receiptReference:text(r,"receipt_reference"), amount:{ amount:text(r,"amount") as never, currency:text(r,"currency_code") as SupportedCurrency }, businessEventAt:iso(r.business_event_at), receivedByUserAccountId:text(r,"received_by_user_account_id") as UserAccountId, status:text(r,"status") as TreasuryReceipt["status"], ...(nullableText(r,"physical_cash_count_id") ? { physicalCashCountId:text(r,"physical_cash_count_id") as PhysicalCashCountId }:{}), ...(nullableText(r,"evidence_reference_id") ? { evidenceReferenceId:text(r,"evidence_reference_id") }:{}), ...(nullableText(r,"submitted_for_verification_at") ? { submittedForVerificationAt:iso(r.submitted_for_verification_at) }:{}), ...(nullableText(r,"verified_by_user_account_id") ? { verifiedByUserAccountId:text(r,"verified_by_user_account_id") as UserAccountId }:{}), ...(nullableText(r,"verified_at") ? { verifiedAt:iso(r.verified_at) }:{}), ...(nullableText(r,"void_reason") ? { voidReason:text(r,"void_reason") }:{}) }; }
function handoffOf(r: Row): TreasuryHandoffRecord { return { id:text(r,"id"), legalEntityId:text(r,"legal_entity_id") as LegalEntityId, cashReceiptId:text(r,"cash_receipt_id") as CashReceiptId, capitalReceiptIntentId:text(r,"capital_receipt_intent_id") as CapitalReceiptIntentId, handedOffByUserAccountId:text(r,"handed_off_by_user_account_id") as UserAccountId, handedOffAt:iso(r.handed_off_at), status:"READY_FOR_FINANCE" }; }
function eventOf(r: Row): TreasuryEventRecord { return { id:text(r,"id"), aggregateType:text(r,"aggregate_type"), aggregateId:text(r,"aggregate_id"), operation:text(r,"operation") as TreasuryEventRecord["operation"], ...(nullableText(r,"from_status") ? { fromStatus:text(r,"from_status") }:{}), ...(nullableText(r,"to_status") ? { toStatus:text(r,"to_status") }:{}), actorUserAccountId:text(r,"actor_user_account_id") as UserAccountId, actorDisplayName:text(r,"display_name"), occurredAt:iso(r.occurred_at) }; }
