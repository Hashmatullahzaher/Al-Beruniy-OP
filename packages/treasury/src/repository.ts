import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  LegalEntityId,
  PhysicalCashCountId,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";
import type {
  CapitalReceiptSource,
  CashAccountOpeningRecord,
  CashAccountRecord,
  CashLocationRecord,
  CashierAssignmentRecord,
  PhysicalCashCountRecord,
  ReceiptTrace,
  TreasuryActor,
  TreasuryHandoffRecord,
  TreasuryReceipt
} from "./types.ts";

/**
 * Reads available to Treasury. None of them return a ledger balance, and none are needed to post:
 * Treasury has no posting surface.
 */
export interface TreasuryReader {
  listLocations(legalEntityId: LegalEntityId): Promise<readonly CashLocationRecord[]>;
  findLocation(legalEntityId: LegalEntityId, id: CashLocationId): Promise<CashLocationRecord | undefined>;
  listAccounts(legalEntityId: LegalEntityId, locationId?: CashLocationId): Promise<readonly CashAccountRecord[]>;
  findAccount(legalEntityId: LegalEntityId, id: CashLocationCurrencyAccountId): Promise<CashAccountRecord | undefined>;
  listAssignments(legalEntityId: LegalEntityId, locationId: CashLocationId): Promise<readonly CashierAssignmentRecord[]>;
  findOpening(legalEntityId: LegalEntityId, accountId: CashLocationCurrencyAccountId): Promise<CashAccountOpeningRecord | undefined>;
  findCount(legalEntityId: LegalEntityId, id: PhysicalCashCountId): Promise<PhysicalCashCountRecord | undefined>;
  listSources(legalEntityId: LegalEntityId): Promise<readonly CapitalReceiptSource[]>;
  findSource(legalEntityId: LegalEntityId, id: CapitalReceiptIntentId): Promise<CapitalReceiptSource | undefined>;
  listReceipts(legalEntityId: LegalEntityId): Promise<readonly TreasuryReceipt[]>;
  findReceipt(legalEntityId: LegalEntityId, id: CashReceiptId): Promise<TreasuryReceipt | undefined>;
  findHandoff(legalEntityId: LegalEntityId, receiptId: CashReceiptId): Promise<TreasuryHandoffRecord | undefined>;
  /**
   * The ledger account Finance has configured as cash for this currency. Treasury never creates
   * one; if Finance has not configured it, an account cannot be opened.
   */
  findFinanceCashLedgerAccount(legalEntityId: LegalEntityId, currency: SupportedCurrency): Promise<string | undefined>;
  trace(legalEntityId: LegalEntityId, receiptId: CashReceiptId): Promise<ReceiptTrace | undefined>;
}

/** Writes, each executed in one transaction attributed to the acting user. */
export interface TreasuryWriter {
  createLocation(actor: TreasuryActor, input: {
    readonly id: CashLocationId;
    readonly name: string;
    readonly responsibleCashierUserAccountId: UserAccountId;
  }): Promise<void>;
  setLocationStatus(actor: TreasuryActor, id: CashLocationId, status: CashLocationRecord["status"]): Promise<void>;
  openAccount(actor: TreasuryActor, input: {
    readonly id: CashLocationCurrencyAccountId;
    readonly cashLocationId: CashLocationId;
    readonly currency: SupportedCurrency;
    readonly ledgerAccountId: string;
  }): Promise<void>;
  assignCashier(actor: TreasuryActor, input: {
    readonly id: string;
    readonly cashLocationId: CashLocationId;
    readonly userAccountId: UserAccountId;
  }): Promise<void>;
  revokeCashier(actor: TreasuryActor, assignmentId: string): Promise<void>;
  recordCount(actor: TreasuryActor, input: {
    readonly id: PhysicalCashCountId;
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly currency: SupportedCurrency;
    readonly countedAmount: string;
    readonly evidenceReferenceId: string;
    readonly purpose: "OPENING" | "RECEIPT";
  }): Promise<void>;
  confirmCount(actor: TreasuryActor, countId: PhysicalCashCountId): Promise<void>;
  reconcileOpening(actor: TreasuryActor, input: {
    readonly cashAccountId: CashLocationCurrencyAccountId;
    readonly currency: SupportedCurrency;
    readonly openingCountedAmount: string;
    readonly physicalCashCountId: PhysicalCashCountId;
    readonly reconciliationEvidenceReferenceId: string;
  }): Promise<void>;
  approveOpening(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId): Promise<void>;
  activateAccount(actor: TreasuryActor, accountId: CashLocationCurrencyAccountId, evidenceReferenceId: string): Promise<void>;
  recordReceipt(actor: TreasuryActor, input: {
    readonly id: CashReceiptId;
    readonly source: CapitalReceiptSource;
    readonly receiptReference: string;
    readonly businessEventAt: string;
  }): Promise<void>;
  /** Records the receipt count and attaches it, atomically. */
  countReceipt(actor: TreasuryActor, input: {
    readonly receiptId: CashReceiptId;
    readonly count: {
      readonly id: PhysicalCashCountId;
      readonly cashAccountId: CashLocationCurrencyAccountId;
      readonly currency: SupportedCurrency;
      readonly countedAmount: string;
      readonly evidenceReferenceId: string;
    };
    readonly receiptEvidenceReferenceId: string;
  }): Promise<void>;
  submitForVerification(actor: TreasuryActor, receiptId: CashReceiptId): Promise<void>;
  /** Confirms the count and verifies the receipt, atomically, as the same independent verifier. */
  verifyReceipt(actor: TreasuryActor, receiptId: CashReceiptId, countId: PhysicalCashCountId): Promise<void>;
  voidReceipt(actor: TreasuryActor, receiptId: CashReceiptId, reason: string): Promise<void>;
  /**
   * Records the shareholder-side TREASURY_VERIFIED transition and the Finance handoff atomically.
   * The shareholder transition is performed by the shareholder domain's own service, not by
   * Treasury writing the shareholder's table.
   */
  handOffToFinance(actor: TreasuryActor, input: {
    readonly id: string;
    readonly receipt: TreasuryReceipt;
    readonly count: PhysicalCashCountRecord;
    readonly correlationId: string;
  }): Promise<void>;
}

export interface TreasuryRepository extends TreasuryReader, TreasuryWriter {}
