import { randomUUID } from "node:crypto";
import type {
  CashLocationCurrencyAccountId,
  CashLocationId,
  LegalEntityId,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";
import { assertTreasury } from "./errors.ts";
import { assertAmount } from "./policy.ts";
import type { TreasuryRepository } from "./repository.ts";
import type { PhysicalCashCountRecord, TreasuryActor } from "./types.ts";

/**
 * Safes and Saraf accounts (V1 backlog #11) and whole-safe counts (#16).
 *
 * Owner decisions: V1 money locations are cash safes and Saraf accounts (no banks); both are
 * accounts linked to an account the user picks from the Chart of Accounts; cash can be counted
 * either as money received (the receipt workflow) or as the whole safe.
 *
 * What this service cannot do, structurally: create a ledger account, move money, keep or compute
 * a ledger position, or post. A Saraf account is set-up only. A whole-safe count records what was
 * physically counted; the custody total and the difference are computed by the database from
 * approved and verified records and are only displayed. What to do about a difference is a Finance
 * Manager policy that does not exist yet, so nothing here acts on one.
 *
 * Every rule below is repeated by migration 0015 and the 0006 triggers; it is stated here so the
 * application refuses early with a typed error. It is never the only guard.
 */

export const SARAF_MANAGE_PERMISSION = "treasury.saraf-account.manage";
export const COUNT_RECORD_PERMISSION = "treasury.cash-count.record";
export const ACCOUNT_APPROVE_PERMISSION = "treasury.cash-account.approve";
export const LOCATION_MANAGE_PERMISSION = "treasury.cash-location.manage";

export type SarafAccountStatus = "DRAFT" | "ACTIVE" | "INACTIVE";
export type SafeCountStatus = "RECORDED" | "CONFIRMED";
export type CountEvidenceKind = "PHYSICAL_CASH_COUNT" | "OPENING_RECONCILIATION";

/** A Chart of Accounts entry that a safe or Saraf account may link. Read-only for Treasury. */
export interface LedgerAccountChoice {
  readonly id: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly currency: SupportedCurrency;
}

export interface SarafPartyRecord {
  readonly id: string;
  readonly displayName: string;
  readonly externalReference?: string;
}

export interface SarafAccountRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly businessPartyId: string;
  readonly partyName: string;
  readonly currency: SupportedCurrency;
  readonly ledgerAccountId: string;
  readonly ledgerAccountCode: string;
  readonly ledgerAccountName: string;
  readonly status: SarafAccountStatus;
  readonly createdByUserAccountId: UserAccountId;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly activatedByUserAccountId?: UserAccountId;
  readonly activatedByName?: string;
  readonly activatedAt?: string;
  readonly statusChangedAt?: string;
}

export interface SafeCountRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly cashLocationId: CashLocationId;
  readonly currency: SupportedCurrency;
  readonly countedAmount: string;
  readonly countedAt: string;
  readonly countedByUserAccountId: UserAccountId;
  readonly countedByName: string;
  readonly evidenceReferenceId: string;
  readonly note?: string;
  /** Snapshot taken by the database when the count was recorded. */
  readonly openingAmount: string;
  readonly verifiedReceiptsAmount: string;
  readonly verifiedReceiptCount: number;
  readonly unverifiedReceiptCount: number;
  readonly custodyTotal: string;
  readonly difference: string;
  readonly status: SafeCountStatus;
  readonly confirmedByUserAccountId?: UserAccountId;
  readonly confirmedByName?: string;
  readonly confirmedAt?: string;
}

export interface CountEvidenceRecord {
  readonly id: string;
  readonly kind: CountEvidenceKind;
  readonly documentId: string;
  readonly version: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly used: boolean;
}

export interface TreasurySafesRepository {
  listCashLedgerChoices(legalEntityId: LegalEntityId): Promise<readonly LedgerAccountChoice[]>;
  listSarafLedgerChoices(legalEntityId: LegalEntityId): Promise<readonly LedgerAccountChoice[]>;
  listSarafParties(legalEntityId: LegalEntityId): Promise<readonly SarafPartyRecord[]>;
  listSarafAccounts(legalEntityId: LegalEntityId): Promise<readonly SarafAccountRecord[]>;
  findSarafAccount(legalEntityId: LegalEntityId, id: string): Promise<SarafAccountRecord | undefined>;
  listSafeCounts(legalEntityId: LegalEntityId): Promise<readonly SafeCountRecord[]>;
  findSafeCount(legalEntityId: LegalEntityId, id: string): Promise<SafeCountRecord | undefined>;
  listCountEvidence(legalEntityId: LegalEntityId): Promise<readonly CountEvidenceRecord[]>;
  /** Every opening and receipt count of the legal entity (the existing 0008 COUNTS query). */
  listPhysicalCounts(legalEntityId: LegalEntityId): Promise<readonly PhysicalCashCountRecord[]>;

  blockAccount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId): Promise<void>;
  createSarafAccount(actor: TreasuryActor, input: {
    readonly id: string;
    readonly businessPartyId: string;
    readonly currency: SupportedCurrency;
    readonly ledgerAccountId: string;
  }): Promise<void>;
  activateSarafAccount(actor: TreasuryActor, id: string): Promise<void>;
  deactivateSarafAccount(actor: TreasuryActor, id: string): Promise<void>;
  recordSafeCount(actor: TreasuryActor, input: {
    readonly id: string;
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly currency: SupportedCurrency;
    readonly countedAmount: string;
    readonly evidenceReferenceId: string;
    readonly note?: string;
  }): Promise<void>;
  confirmSafeCount(actor: TreasuryActor, id: string): Promise<void>;
}

export function holdsPermission(actor: TreasuryActor, permission: string): boolean {
  return (actor.treasuryPermissions as readonly string[]).includes(permission);
}

function requireSafesPermission(actor: TreasuryActor, permission: string): void {
  assertTreasury(holdsPermission(actor, permission), "PERMISSION_DENIED", `This action requires the Treasury permission ${permission}`);
}

const CURRENCIES: readonly SupportedCurrency[] = ["USD", "AFN"];

export class TreasurySafesService {
  private readonly safes: TreasurySafesRepository;
  private readonly treasury: TreasuryRepository;
  private readonly newId: () => string;

  constructor(safes: TreasurySafesRepository, treasury: TreasuryRepository, newId: () => string = () => randomUUID()) {
    this.safes = safes;
    this.treasury = treasury;
    this.newId = newId;
  }

  // ---------------------------------------------------------------- safe currency accounts

  /**
   * Opens a USD or AFN account in a safe against the CASH ledger account the user chose. The
   * account must be an ACTIVE posting CASH account in the same currency; Treasury never creates one.
   */
  async openCurrencyAccount(actor: TreasuryActor, input: {
    readonly cashLocationId: CashLocationId;
    readonly currency: SupportedCurrency;
    readonly ledgerAccountId: string;
  }): Promise<CashLocationCurrencyAccountId> {
    requireSafesPermission(actor, LOCATION_MANAGE_PERMISSION);
    assertTreasury(CURRENCIES.includes(input.currency), "CURRENCY_MISMATCH", "A safe account is USD or AFN");
    const location = await this.treasury.findLocation(actor.legalEntityId, input.cashLocationId);
    assertTreasury(location, "NOT_FOUND", "The safe does not exist");
    const existing = await this.treasury.listAccounts(actor.legalEntityId, input.cashLocationId);
    assertTreasury(!existing.some((account) => account.currency === input.currency), "IDEMPOTENCY_CONFLICT",
      `${location.name} already has a ${input.currency} account`);
    const choices = await this.safes.listCashLedgerChoices(actor.legalEntityId);
    const ledger = choices.find((choice) => choice.id === input.ledgerAccountId);
    assertTreasury(ledger, "POLICY_CONFIGURATION_PENDING",
      "Choose an active CASH account from the Chart of Accounts; Treasury does not create ledger accounts");
    assertTreasury(ledger.currency === input.currency, "CURRENCY_MISMATCH",
      `A ${input.currency} safe account cannot link the ${ledger.currency} ledger account ${ledger.accountCode}`);
    const id = this.newId() as CashLocationCurrencyAccountId;
    await this.treasury.openAccount(actor, { id, cashLocationId: input.cashLocationId, currency: input.currency, ledgerAccountId: ledger.id });
    return id;
  }

  async blockAccount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId): Promise<void> {
    requireSafesPermission(actor, ACCOUNT_APPROVE_PERMISSION);
    const account = await this.treasury.findAccount(actor.legalEntityId, accountId);
    assertTreasury(account, "NOT_FOUND", "The cash account does not exist");
    assertTreasury(["RECONCILED", "APPROVED", "ACTIVE"].includes(account.status), "CASH_ACCOUNT_INACTIVE",
      `A ${account.status} account cannot be blocked`);
    await this.safes.blockAccount(actor, accountId);
  }

  /** The latest opening count of an account that is not yet reconciled, if any. */
  async pendingOpeningCount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId): Promise<PhysicalCashCountRecord | undefined> {
    const counts = (await this.safes.listPhysicalCounts(actor.legalEntityId))
      .filter((count) => count.cashAccountId === accountId && count.purpose === "OPENING" && count.status !== "VOIDED");
    return [...counts].sort((a, b) => b.countedAt.localeCompare(a.countedAt))[0];
  }

  /** Opening count evidence must be unused PHYSICAL_CASH_COUNT evidence provisioned for safes. */
  async assertUnusedEvidence(actor: TreasuryActor, evidenceReferenceId: string, kind: CountEvidenceKind): Promise<void> {
    const evidence = (await this.safes.listCountEvidence(actor.legalEntityId)).find((item) => item.id === evidenceReferenceId);
    assertTreasury(evidence && evidence.kind === kind, "EVIDENCE_REQUIRED", `Choose ${kind.replaceAll("_", " ").toLowerCase()} evidence provisioned for safes`);
    assertTreasury(!evidence.used, "IDEMPOTENCY_CONFLICT", "This evidence already belongs to another count or reconciliation");
  }

  // ---------------------------------------------------------------- Saraf accounts

  async createSarafAccount(actor: TreasuryActor, input: {
    readonly businessPartyId: string;
    readonly currency: SupportedCurrency;
    readonly ledgerAccountId: string;
  }): Promise<string> {
    requireSafesPermission(actor, SARAF_MANAGE_PERMISSION);
    assertTreasury(CURRENCIES.includes(input.currency), "CURRENCY_MISMATCH", "A Saraf account is USD or AFN");
    const party = (await this.safes.listSarafParties(actor.legalEntityId)).find((item) => item.id === input.businessPartyId);
    assertTreasury(party, "NOT_FOUND", "The business party is not an active Saraf (it needs a current SARAF role)");
    const ledger = (await this.safes.listSarafLedgerChoices(actor.legalEntityId)).find((item) => item.id === input.ledgerAccountId);
    assertTreasury(ledger, "POLICY_CONFIGURATION_PENDING",
      "Choose an active SARAF control account from the Chart of Accounts; Treasury does not create ledger accounts");
    assertTreasury(ledger.currency === input.currency, "CURRENCY_MISMATCH",
      `A ${input.currency} Saraf account cannot link the ${ledger.currency} ledger account ${ledger.accountCode}`);
    const live = (await this.safes.listSarafAccounts(actor.legalEntityId))
      .find((item) => item.businessPartyId === party.id && item.currency === input.currency && item.status !== "INACTIVE");
    assertTreasury(!live, "IDEMPOTENCY_CONFLICT", `${party.displayName} already has a ${input.currency} Saraf account`);
    const id = this.newId();
    await this.safes.createSarafAccount(actor, { id, businessPartyId: party.id, currency: input.currency, ledgerAccountId: ledger.id });
    return id;
  }

  async activateSarafAccount(actor: TreasuryActor, id: string): Promise<void> {
    requireSafesPermission(actor, SARAF_MANAGE_PERMISSION);
    const account = await this.safes.findSarafAccount(actor.legalEntityId, id);
    assertTreasury(account, "NOT_FOUND", "The Saraf account does not exist");
    assertTreasury(account.status !== "ACTIVE", "IDEMPOTENCY_CONFLICT", "The Saraf account is already active");
    assertTreasury(account.createdByUserAccountId !== actor.userAccountId, "SEGREGATION_OF_DUTIES_VIOLATION",
      "The person who created a Saraf account cannot activate it");
    await this.safes.activateSarafAccount(actor, id);
  }

  async deactivateSarafAccount(actor: TreasuryActor, id: string): Promise<void> {
    requireSafesPermission(actor, SARAF_MANAGE_PERMISSION);
    const account = await this.safes.findSarafAccount(actor.legalEntityId, id);
    assertTreasury(account, "NOT_FOUND", "The Saraf account does not exist");
    assertTreasury(account.status !== "INACTIVE", "IDEMPOTENCY_CONFLICT", "The Saraf account is already inactive");
    await this.safes.deactivateSarafAccount(actor, id);
  }

  // ---------------------------------------------------------------- whole-safe counts

  /**
   * The counter records everything physically in one currency account of a safe. The custody total
   * and difference are computed by the database at this moment; the caller cannot supply them.
   */
  async recordSafeCount(actor: TreasuryActor, input: {
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly countedAmount: string;
    readonly evidenceReferenceId: string;
    readonly note?: string;
  }): Promise<string> {
    requireSafesPermission(actor, COUNT_RECORD_PERMISSION);
    assertAmount(input.countedAmount, "The whole-safe count");
    const account = await this.treasury.findAccount(actor.legalEntityId, input.cashAccountId);
    assertTreasury(account, "NOT_FOUND", "The cash account does not exist");
    const opening = await this.treasury.findOpening(actor.legalEntityId, account.id);
    assertTreasury(opening?.status === "APPROVED", "OPENING_POSITION_NOT_APPROVED",
      "A whole-safe count needs an account whose opening position is approved");
    await this.assertUnusedEvidence(actor, input.evidenceReferenceId, "PHYSICAL_CASH_COUNT");
    const note = input.note?.trim();
    assertTreasury(note === undefined || note.length <= 500, "EVIDENCE_REQUIRED", "A note has at most 500 characters");
    const id = this.newId();
    await this.safes.recordSafeCount(actor, {
      id, cashAccountId: account.id, currency: account.currency, countedAmount: input.countedAmount,
      evidenceReferenceId: input.evidenceReferenceId, ...(note ? { note } : {})
    });
    return id;
  }

  async confirmSafeCount(actor: TreasuryActor, id: string): Promise<void> {
    requireSafesPermission(actor, ACCOUNT_APPROVE_PERMISSION);
    const count = await this.safes.findSafeCount(actor.legalEntityId, id);
    assertTreasury(count, "NOT_FOUND", "The whole-safe count does not exist");
    assertTreasury(count.status === "RECORDED", "POSTED_RECORD_IMMUTABLE", "This whole-safe count is already confirmed");
    assertTreasury(count.countedByUserAccountId !== actor.userAccountId, "SEGREGATION_OF_DUTIES_VIOLATION",
      "The person who counted the safe cannot confirm the count");
    await this.safes.confirmSafeCount(actor, id);
  }
}

