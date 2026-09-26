import type {
  CashLocationCurrencyAccountId, CashLocationId, LegalEntityId, PhysicalCashCountId, SupportedCurrency, UserAccountId
} from "@abos/contracts";
import type {
  CountEvidenceRecord, LedgerAccountChoice, PhysicalCashCountRecord, SafeCountRecord, SarafAccountRecord,
  SarafPartyRecord, TreasuryActor, TreasurySafesRepository
} from "@abos/treasury";
import {
  RestrictedTreasuryGateway, type RestrictedSafesOperation, type RestrictedSafesQuery, type RestrictedTreasuryAuthority
} from "./restricted-treasury-gateway.ts";

type Row = Readonly<Record<string, unknown>>;

/**
 * TreasurySafesRepository backed only by the restricted Treasury entry points: the 0015
 * safes/Saraf query and command, and the existing 0008 command for blocking a safe account.
 */
export class RestrictedTreasurySafesRepository implements TreasurySafesRepository {
  private readonly gateway: RestrictedTreasuryGateway;
  private readonly authority: RestrictedTreasuryAuthority;

  constructor(gateway: RestrictedTreasuryGateway, authority: RestrictedTreasuryAuthority) {
    this.gateway = gateway;
    this.authority = authority;
  }

  async listCashLedgerChoices(entity: LegalEntityId) { return (await this.rows(entity, "CASH_LEDGER_CHOICES")).map(ledgerOf); }
  async listSarafLedgerChoices(entity: LegalEntityId) { return (await this.rows(entity, "SARAF_LEDGER_CHOICES")).map(ledgerOf); }
  async listSarafParties(entity: LegalEntityId): Promise<readonly SarafPartyRecord[]> {
    return (await this.rows(entity, "SARAF_PARTIES")).map((r) => ({
      id: text(r, "id"), displayName: text(r, "display_name"),
      ...(optional(r, "external_reference") === undefined ? {} : { externalReference: text(r, "external_reference") })
    }));
  }
  async listSarafAccounts(entity: LegalEntityId) { return (await this.rows(entity, "SARAF_ACCOUNTS")).map(sarafOf); }
  async findSarafAccount(entity: LegalEntityId, id: string) { return (await this.rows(entity, "SARAF_ACCOUNTS", id)).map(sarafOf)[0]; }
  async listSafeCounts(entity: LegalEntityId) { return (await this.rows(entity, "SAFE_COUNTS")).map(safeCountOf); }
  async findSafeCount(entity: LegalEntityId, id: string) {
    return (await this.rows(entity, "SAFE_COUNTS", id)).map(safeCountOf).find((count) => count.id === id);
  }
  async listCountEvidence(entity: LegalEntityId): Promise<readonly CountEvidenceRecord[]> {
    return (await this.rows(entity, "COUNT_EVIDENCE")).map((r) => ({
      id: text(r, "id"), kind: text(r, "evidence_kind") as CountEvidenceRecord["kind"], documentId: text(r, "document_id"),
      version: Number(r.evidence_version), sha256: text(r, "sha256"), createdAt: iso(r.created_at), used: r.used === true
    }));
  }
  async listPhysicalCounts(entity: LegalEntityId): Promise<readonly PhysicalCashCountRecord[]> {
    this.entity(entity);
    return (await this.gateway.query<readonly Row[]>(this.authority, "COUNTS")).map(countOf);
  }

  async blockAccount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId) {
    this.actor(actor);
    await this.gateway.command(this.authority, "BLOCK_ACCOUNT", { id: accountId });
  }
  async createSarafAccount(actor: TreasuryActor, input: { id: string; businessPartyId: string; currency: SupportedCurrency; ledgerAccountId: string }) {
    await this.command(actor, "CREATE_SARAF_ACCOUNT", input);
  }
  async activateSarafAccount(actor: TreasuryActor, id: string) { await this.command(actor, "ACTIVATE_SARAF_ACCOUNT", { id }); }
  async deactivateSarafAccount(actor: TreasuryActor, id: string) { await this.command(actor, "DEACTIVATE_SARAF_ACCOUNT", { id }); }
  async recordSafeCount(actor: TreasuryActor, input: {
    id: string; cashAccountId: CashLocationCurrencyAccountId; currency: SupportedCurrency; countedAmount: string;
    evidenceReferenceId: string; note?: string;
  }) {
    await this.command(actor, "RECORD_SAFE_COUNT", input);
  }
  async confirmSafeCount(actor: TreasuryActor, id: string) { await this.command(actor, "CONFIRM_SAFE_COUNT", { id }); }

  private async rows(entity: LegalEntityId, query: RestrictedSafesQuery, id?: string): Promise<readonly Row[]> {
    this.entity(entity);
    return this.gateway.safesQuery<readonly Row[]>(this.authority, query, id);
  }
  private async command(actor: TreasuryActor, operation: RestrictedSafesOperation, payload: Record<string, unknown>) {
    this.actor(actor);
    await this.gateway.safesCommand(this.authority, operation, payload);
  }
  private actor(actor: TreasuryActor) {
    this.entity(actor.legalEntityId);
    if (actor.userAccountId.length === 0) throw new Error("Treasury actor is required");
  }
  private entity(entity: LegalEntityId) {
    if (entity !== this.authority.legalEntityId) throw new Error("Treasury legal entity is outside the authenticated session");
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Missing Treasury field ${key}`);
  return value;
}
function optional(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }

function ledgerOf(r: Row): LedgerAccountChoice {
  return { id: text(r, "id"), accountCode: text(r, "account_code"), accountName: text(r, "account_name"),
    currency: text(r, "account_currency_code") as SupportedCurrency };
}

function sarafOf(r: Row): SarafAccountRecord {
  return {
    id: text(r, "id"), legalEntityId: text(r, "legal_entity_id") as LegalEntityId,
    businessPartyId: text(r, "business_party_id"), partyName: text(r, "party_name"),
    currency: text(r, "currency_code") as SupportedCurrency, ledgerAccountId: text(r, "ledger_account_id"),
    ledgerAccountCode: text(r, "account_code"), ledgerAccountName: text(r, "account_name"),
    status: text(r, "status") as SarafAccountRecord["status"],
    createdByUserAccountId: text(r, "created_by_user_account_id") as UserAccountId,
    createdByName: text(r, "created_by_name"), createdAt: iso(r.created_at),
    ...(optional(r, "activated_by_user_account_id") === undefined ? {} : {
      activatedByUserAccountId: text(r, "activated_by_user_account_id") as UserAccountId,
      activatedByName: text(r, "activated_by_name"), activatedAt: iso(r.activated_at)
    }),
    ...(optional(r, "status_changed_at") === undefined ? {} : { statusChangedAt: iso(r.status_changed_at) })
  };
}

function safeCountOf(r: Row): SafeCountRecord {
  return {
    id: text(r, "id"), legalEntityId: text(r, "legal_entity_id") as LegalEntityId,
    cashAccountId: text(r, "cash_location_currency_account_id") as CashLocationCurrencyAccountId,
    cashLocationId: text(r, "cash_location_id") as CashLocationId,
    currency: text(r, "currency_code") as SupportedCurrency, countedAmount: text(r, "counted_amount"),
    countedAt: iso(r.counted_at), countedByUserAccountId: text(r, "counted_by_user_account_id") as UserAccountId,
    countedByName: text(r, "counted_by_name"), evidenceReferenceId: text(r, "evidence_reference_id"),
    ...(optional(r, "note") === undefined ? {} : { note: text(r, "note") }),
    openingAmount: text(r, "opening_amount"), verifiedReceiptsAmount: text(r, "verified_receipts_amount"),
    verifiedReceiptCount: Number(r.verified_receipt_count), unverifiedReceiptCount: Number(r.unverified_receipt_count),
    custodyTotal: text(r, "custody_total"), difference: text(r, "difference"),
    status: text(r, "status") as SafeCountRecord["status"],
    ...(optional(r, "confirmed_by_user_account_id") === undefined ? {} : {
      confirmedByUserAccountId: text(r, "confirmed_by_user_account_id") as UserAccountId,
      confirmedByName: text(r, "confirmed_by_name"), confirmedAt: iso(r.confirmed_at)
    })
  };
}

function countOf(r: Row): PhysicalCashCountRecord {
  return {
    id: text(r, "id") as PhysicalCashCountId, legalEntityId: text(r, "legal_entity_id") as LegalEntityId,
    cashAccountId: text(r, "cash_location_currency_account_id") as CashLocationCurrencyAccountId,
    currency: text(r, "currency_code") as SupportedCurrency, countedAmount: text(r, "counted_amount"),
    countedAt: iso(r.counted_at), countedByUserAccountId: text(r, "counted_by_user_account_id") as UserAccountId,
    evidenceReferenceId: text(r, "evidence_reference_id"),
    purpose: text(r, "count_purpose") as PhysicalCashCountRecord["purpose"],
    status: text(r, "status") as PhysicalCashCountRecord["status"],
    ...(optional(r, "confirmed_by_user_account_id") === undefined ? {} : {
      confirmedByUserAccountId: text(r, "confirmed_by_user_account_id") as UserAccountId, confirmedAt: iso(r.confirmed_at)
    })
  };
}
