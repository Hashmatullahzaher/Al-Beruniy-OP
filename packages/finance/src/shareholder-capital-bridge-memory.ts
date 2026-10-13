import type {
  CapitalBridgeAuditEntry, CapitalContributionDeclaration, CapitalReceiptPostingConfiguration,
  CapitalReceiptPostingIntentRecord, CapitalReceiptRecord, EvidenceReference, IdempotencyKey,
  JournalId, JournalLineDraft, LedgerAccountId, LegalEntityId, PostedJournal, ServerActorContext
} from "@abos/contracts";

import { assertFinance } from "./errors.ts";
import type {
  BridgeDestination, BridgeLedgerAccount, BridgeOperation, BridgeReversalDecision,
  ShareholderCapitalBridgeRepository
} from "./shareholder-capital-bridge.ts";

interface FixtureSession {
  readonly userAccountId: ServerActorContext["userAccountId"];
  readonly authenticatedAt: string;
  readonly expiresAt: string;
  readonly provenance: "PASSWORD_OPERATIONAL" | "SYNTHETIC_TEST_ONLY";
  readonly revoked: boolean;
}

export interface CapitalBridgeMemorySubledgerEntry {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly receiptId: string;
  readonly journalId: JournalId;
  readonly line: JournalLineDraft;
  readonly reversalOfEntryId?: string;
}

/**
 * Isolated deterministic fixture adapter, not database authorization or runtime storage.
 * Registration methods are fixture setup only. No API/runtime uses this adapter and it never
 * opens a connection. The global queue models atomic transactions only in this process.
 */
export class InMemoryShareholderCapitalBridgeRepository implements ShareholderCapitalBridgeRepository {
  readonly mode = "ISOLATED_MEMORY_REVIEW" as const;
  private readonly users = new Map<string, ServerActorContext>();
  private readonly sessions = new Map<string, FixtureSession>();
  private readonly destinations = new Map<string, BridgeDestination>();
  private readonly evidence = new Map<string, { readonly legalEntityId: LegalEntityId; readonly reference: EvidenceReference }>();
  private readonly configurations = new Map<string, CapitalReceiptPostingConfiguration>();
  private readonly accounts = new Map<LedgerAccountId, BridgeLedgerAccount>();
  private readonly reversalDecisions = new Map<string, BridgeReversalDecision>();
  private readonly contributions = new Map<string, CapitalContributionDeclaration>();
  private readonly receipts = new Map<string, CapitalReceiptRecord>();
  private readonly intents = new Map<string, CapitalReceiptPostingIntentRecord>();
  private readonly journals = new Map<JournalId, PostedJournal>();
  private readonly journalByReceipt = new Map<string, PostedJournal>();
  private readonly reversalByJournal = new Map<JournalId, PostedJournal>();
  private readonly effectiveDates = new Map<JournalId, string>();
  private readonly consumedReversalDecisions = new Set<string>();
  private readonly subledger = new Map<string, CapitalBridgeMemorySubledgerEntry>();
  private readonly auditEntries: CapitalBridgeAuditEntry[] = [];
  private readonly idempotency = new Map<string, { readonly requestHash: string; readonly value: unknown }>();
  private queue: Promise<void> = Promise.resolve();
  readonly legacyCommitments = new Map<string, string>();
  readonly untouchedInstallments = new Map<string, string>();
  readonly documentVersions = new Map<string, number>();
  readonly treasuryMovements: readonly never[] = [];

  seedActor(actor: ServerActorContext): void { this.seedCurrentUser(actor); this.seedSession(actor); }
  seedCurrentUser(actor: ServerActorContext): void { this.users.set(actor.userAccountId, structuredClone(actor)); }
  seedSession(actor: ServerActorContext, options: Partial<Pick<FixtureSession, "expiresAt" | "provenance" | "revoked">> = {}): void {
    if (!actor.sessionId) throw new Error("Fixture session needs an identifier");
    this.sessions.set(actor.sessionId, { userAccountId: actor.userAccountId, authenticatedAt: actor.authenticatedAt,
      expiresAt: options.expiresAt ?? actor.expiresAt ?? "2099-01-01T00:00:00.000Z",
      provenance: options.provenance ?? "PASSWORD_OPERATIONAL", revoked: options.revoked ?? false });
  }
  revokeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, revoked: true });
  }
  seedDestination(destination: BridgeDestination): void { this.destinations.set(destination.id, structuredClone(destination)); }
  seedEvidence(legalEntityId: LegalEntityId, reference: EvidenceReference): void { this.evidence.set(reference.id, { legalEntityId, reference: structuredClone(reference) }); }
  seedConfiguration(configuration: CapitalReceiptPostingConfiguration): void { this.configurations.set(configKey(configuration.legalEntityId, configuration.treasuryDestinationId, configuration.accountingPeriodId), structuredClone(configuration)); }
  seedLedgerAccount(account: BridgeLedgerAccount): void { this.accounts.set(account.id, structuredClone(account)); }
  seedReversalDecision(decision: BridgeReversalDecision): void { this.reversalDecisions.set(decision.id, structuredClone(decision)); }
  seedContribution(contribution: CapitalContributionDeclaration): void { this.contributions.set(contribution.id, structuredClone(contribution)); }
  seedLegacyCommitment(id: string, amount: string): void { this.legacyCommitments.set(id, amount); }
  seedUntouchedInstallment(id: string, status: string): void { this.untouchedInstallments.set(id, status); }
  seedDocument(id: string, version: number): void { this.documentVersions.set(id, version); }

  async authorize(actor: ServerActorContext, permission: string, legalEntityId: LegalEntityId, now: string): Promise<ServerActorContext> {
    const sessionId = actor.sessionId;
    assertFinance(sessionId, "AUTHENTICATION_REQUIRED", "An active registered session is required");
    const session = this.sessions.get(sessionId);
    assertFinance(session && session.userAccountId === actor.userAccountId && !session.revoked,
      "AUTHENTICATION_REQUIRED", "An active registered session is required");
    assertFinance(Number.isFinite(Date.parse(now)) && Number.isFinite(Date.parse(session.expiresAt))
      && Date.parse(session.expiresAt) > Date.parse(now), "AUTHENTICATION_REQUIRED", "Session expired");
    assertFinance(session.provenance === "PASSWORD_OPERATIONAL", "PERMISSION_DENIED", "Operational password provenance is required");
    const current = this.users.get(session.userAccountId);
    assertFinance(current, "AUTHENTICATION_REQUIRED", "Current user is unavailable");
    assertFinance(current.legalEntityIds.includes(legalEntityId), "SCOPE_MISMATCH", "Entity is outside current user scope");
    const grants: readonly string[] = permission.startsWith("treasury.") ? current.treasuryPermissions ?? [] : current.permissions;
    assertFinance(grants.includes(permission), "PERMISSION_DENIED", "Current user has no grant for this action");
    return structuredClone({ ...current, sessionId, authenticatedAt: session.authenticatedAt, expiresAt: session.expiresAt });
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await before;
    const snapshot = this.snapshot();
    try { return await action(); }
    catch (error) { this.restore(snapshot); throw error; }
    finally { release(); }
  }

  async findContribution(id: string) { return clone(this.contributions.get(id)); }
  async listReceipts(contributionId: string) { return [...this.receipts.values()].filter((item) => item.contributionId === contributionId).map((item) => structuredClone(item)); }
  async findReceipt(id: string) { return clone(this.receipts.get(id)); }
  async findDestination(id: string) { return clone(this.destinations.get(id)); }
  async findEvidence(id: string) { return clone(this.evidence.get(id)); }
  async findConfiguration(entity: LegalEntityId, destinationId: string, periodId: CapitalReceiptPostingConfiguration["accountingPeriodId"]) { return clone(this.configurations.get(configKey(entity, destinationId, periodId))); }
  async findLedgerAccounts(entity: LegalEntityId): Promise<ReadonlyMap<LedgerAccountId, BridgeLedgerAccount>> {
    return new Map([...this.accounts.entries()].filter(([, account]) => account.legalEntityId === entity).map(([id, account]) => [id, structuredClone(account)]));
  }
  async findReversalDecision(id: string) { return clone(this.reversalDecisions.get(id)); }
  async findJournal(id: JournalId) { return clone(this.journals.get(id)); }
  async findJournalByReceipt(receiptId: string) { return clone(this.journalByReceipt.get(receiptId)); }
  async findReversal(originalJournalId: JournalId) { return clone(this.reversalByJournal.get(originalJournalId)); }
  async postingEffectiveDate(journalId: JournalId) { return this.effectiveDates.get(journalId); }
  async findIdempotency<T>(legalEntityId: string, operation: BridgeOperation, key: IdempotencyKey) {
    return clone(this.idempotency.get(idempotencyKey(legalEntityId, operation, key))) as { readonly requestHash: string; readonly value: T } | undefined;
  }

  async saveReceipt(receipt: CapitalReceiptRecord, audit: CapitalBridgeAuditEntry,
    idempotency: { readonly requestHash: string; readonly value: CapitalReceiptRecord; readonly operation: BridgeOperation; readonly key: IdempotencyKey }) {
    assertFinance(!this.receipts.has(receipt.id), "IDEMPOTENCY_CONFLICT", "Duplicate receipt id");
    this.preflight(receipt.legalEntityId, audit, idempotency);
    this.receipts.set(receipt.id, structuredClone(receipt));
    this.finish(receipt.legalEntityId, audit, idempotency);
  }

  async replaceReceipt(receipt: CapitalReceiptRecord, expectedVersion: number, audit: CapitalBridgeAuditEntry,
    idempotency: { readonly requestHash: string; readonly value: CapitalReceiptRecord; readonly operation: BridgeOperation; readonly key: IdempotencyKey }) {
    const current = this.receipts.get(receipt.id);
    assertFinance(current && current.version === expectedVersion, "IDEMPOTENCY_CONFLICT", "Concurrent receipt change");
    this.preflight(receipt.legalEntityId, audit, idempotency);
    this.receipts.set(receipt.id, structuredClone(receipt));
    this.finish(receipt.legalEntityId, audit, idempotency);
  }

  async commitPosting(input: Parameters<ShareholderCapitalBridgeRepository["commitPosting"]>[0]) {
    const current = this.receipts.get(input.receipt.id);
    assertFinance(current && current.version === input.expectedReceiptVersion, "IDEMPOTENCY_CONFLICT", "Concurrent receipt change");
    assertFinance(!this.journalByReceipt.has(input.receipt.id) && !this.journals.has(input.journal.id)
      && !this.intents.has(input.postingIntent.id), "IDEMPOTENCY_CONFLICT", "Receipt already has a journal or duplicate generated identifier");
    this.preflight(input.receipt.legalEntityId, input.audit, input.idempotency);
    const effects = this.effects(input.journal, input.receipt.id);
    this.receipts.set(input.receipt.id, structuredClone(input.receipt));
    this.intents.set(input.postingIntent.id, structuredClone(input.postingIntent));
    this.journals.set(input.journal.id, structuredClone(input.journal));
    this.journalByReceipt.set(input.receipt.id, structuredClone(input.journal));
    this.effectiveDates.set(input.journal.id, input.accountingEffectiveDate);
    for (const effect of effects) this.subledger.set(effect.id, effect);
    this.finish(input.receipt.legalEntityId, input.audit, input.idempotency);
  }

  async commitReversal(input: Parameters<ShareholderCapitalBridgeRepository["commitReversal"]>[0]) {
    const current = this.receipts.get(input.receipt.id);
    assertFinance(current && current.version === input.expectedReceiptVersion, "IDEMPOTENCY_CONFLICT", "Concurrent receipt change");
    assertFinance(!this.reversalByJournal.has(input.originalJournalId) && !this.journals.has(input.reversal.id)
      && !this.consumedReversalDecisions.has(input.decision.id), "IDEMPOTENCY_CONFLICT", "Journal or reversal decision already consumed");
    this.preflight(input.receipt.legalEntityId, input.audit, input.idempotency);
    const original = this.journals.get(input.originalJournalId);
    assertFinance(original, "NOT_FOUND", "Original journal is unavailable");
    const effects = this.effects(input.reversal, input.receipt.id, original);
    this.receipts.set(input.receipt.id, structuredClone(input.receipt));
    this.journals.set(input.reversal.id, structuredClone(input.reversal));
    this.reversalByJournal.set(input.originalJournalId, structuredClone(input.reversal));
    this.effectiveDates.set(input.reversal.id, input.accountingEffectiveDate);
    this.consumedReversalDecisions.add(input.decision.id);
    for (const effect of effects) this.subledger.set(effect.id, effect);
    this.finish(input.receipt.legalEntityId, input.audit, input.idempotency);
  }

  listAudit(): readonly CapitalBridgeAuditEntry[] { return structuredClone(this.auditEntries); }
  listJournals(): readonly PostedJournal[] { return [...this.journals.values()].map((item) => structuredClone(item)); }
  listPostingIntents(): readonly CapitalReceiptPostingIntentRecord[] { return [...this.intents.values()].map((item) => structuredClone(item)); }
  listSubledgerEntries(): readonly CapitalBridgeMemorySubledgerEntry[] { return [...this.subledger.values()].map((item) => structuredClone(item)); }
  contributionCount(): number { return this.contributions.size; }

  private effects(journal: PostedJournal, receiptId: string, original?: PostedJournal): readonly CapitalBridgeMemorySubledgerEntry[] {
    return journal.lines.map((line, index) => {
      assertFinance(line.subledgerType && line.subledgerId, "POLICY_CONFIGURATION_PENDING", "Capital journal line needs a subledger binding");
      const id = `${journal.id}:${line.id}`;
      assertFinance(!this.subledger.has(id), "IDEMPOTENCY_CONFLICT", "Duplicate subledger effect");
      const originalLine = original?.lines[index];
      return { id, legalEntityId: journal.legalEntityId, receiptId, journalId: journal.id,
        line: structuredClone(line), ...(originalLine && original ? { reversalOfEntryId: `${original.id}:${originalLine.id}` } : {}) };
    });
  }

  private preflight(entity: string, audit: CapitalBridgeAuditEntry, idempotency: { readonly operation: BridgeOperation; readonly key: IdempotencyKey }) {
    assertFinance(!this.idempotency.has(idempotencyKey(entity, idempotency.operation, idempotency.key)), "IDEMPOTENCY_CONFLICT", "Duplicate idempotency key");
    assertFinance(!this.auditEntries.some(entry => entry.id === audit.id), "IDEMPOTENCY_CONFLICT", "Duplicate audit identifier");
  }
  private finish(entity: string, audit: CapitalBridgeAuditEntry,
    idempotency: { readonly requestHash: string; readonly value: unknown; readonly operation: BridgeOperation; readonly key: IdempotencyKey }) {
    this.auditEntries.push(structuredClone(audit));
    this.idempotency.set(idempotencyKey(entity, idempotency.operation, idempotency.key), { requestHash: idempotency.requestHash, value: structuredClone(idempotency.value) });
  }
  private snapshot() {
    return structuredClone({ receipts: this.receipts, intents: this.intents, journals: this.journals,
      journalByReceipt: this.journalByReceipt, reversalByJournal: this.reversalByJournal, effectiveDates: this.effectiveDates,
      consumedReversalDecisions: this.consumedReversalDecisions, subledger: this.subledger,
      auditEntries: this.auditEntries, idempotency: this.idempotency });
  }
  private restore(snapshot: ReturnType<InMemoryShareholderCapitalBridgeRepository["snapshot"]>) {
    restoreMap(this.receipts, snapshot.receipts); restoreMap(this.intents, snapshot.intents);
    restoreMap(this.journals, snapshot.journals); restoreMap(this.journalByReceipt, snapshot.journalByReceipt);
    restoreMap(this.reversalByJournal, snapshot.reversalByJournal); restoreMap(this.effectiveDates, snapshot.effectiveDates);
    restoreMap(this.subledger, snapshot.subledger); restoreMap(this.idempotency, snapshot.idempotency);
    this.consumedReversalDecisions.clear(); for (const id of snapshot.consumedReversalDecisions) this.consumedReversalDecisions.add(id);
    this.auditEntries.splice(0, this.auditEntries.length, ...snapshot.auditEntries);
  }
}

function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
function configKey(entity: string, destination: string, period: string) { return JSON.stringify([entity, destination, period]); }
function idempotencyKey(entity: string, operation: string, key: string) { return JSON.stringify([entity, operation, key]); }
function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>) { target.clear(); for (const [key, value] of source) target.set(key, value); }
