import type { IdempotencyKey, JournalId, LegalEntityId, PostedJournal } from "@abos/contracts";
import type { FinancePostingRepository, PostingCommit, StoredIdempotencyResult } from "./repository.ts";

export class InMemoryFinancePostingRepository implements FinancePostingRepository {
  private readonly journals = new Map<JournalId, PostedJournal>();
  private readonly bySource = new Map<string, PostedJournal>();
  private readonly idempotency = new Map<string, StoredIdempotencyResult>();
  private readonly reversals = new Map<JournalId, PostedJournal>();

  async findIdempotencyResult(legalEntityId: LegalEntityId, operation: PostingCommit["idempotency"]["operation"], key: IdempotencyKey): Promise<StoredIdempotencyResult | undefined> {
    return this.idempotency.get(`${legalEntityId}:${operation}:${key}`);
  }
  async findJournalBySource(sourceType: string, sourceId: string): Promise<PostedJournal | undefined> { return this.bySource.get(`${sourceType}:${sourceId}`); }
  async findJournalById(id: JournalId): Promise<PostedJournal | undefined> { return this.journals.get(id); }
  async findReversal(originalJournalId: JournalId): Promise<PostedJournal | undefined> { return this.reversals.get(originalJournalId); }

  async commit(commit: PostingCommit): Promise<void> {
    const sourceKey = `${commit.journal.sourceType}:${commit.journal.sourceId}`;
    if (this.bySource.has(sourceKey)) throw new Error("Duplicate journal source");
    if (this.journals.has(commit.journal.id)) throw new Error("Duplicate journal id");
    const key = `${commit.idempotency.legalEntityId}:${commit.idempotency.operation}:${commit.idempotency.key}`;
    if (this.idempotency.has(key)) throw new Error("Duplicate idempotency key");
    this.journals.set(commit.journal.id, commit.journal);
    this.bySource.set(sourceKey, commit.journal);
    this.idempotency.set(key, { requestHash: commit.idempotency.requestHash, journal: commit.journal });
    if (commit.reversalOfJournalId) this.reversals.set(commit.reversalOfJournalId, commit.journal);
  }

  listJournals(): readonly PostedJournal[] { return [...this.journals.values()]; }
}
