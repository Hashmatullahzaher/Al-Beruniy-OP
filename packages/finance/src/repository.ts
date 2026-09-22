import type { AuditRecordId, CorrelationId, IdempotencyKey, JournalId, LegalEntityId, PostedJournal } from "@abos/contracts";

export interface PostingCommit {
  readonly journal: PostedJournal;
  readonly idempotency: {
    readonly legalEntityId: LegalEntityId;
    readonly operation: "POST_CAPITAL_RECEIPT" | "REVERSE_JOURNAL";
    readonly key: IdempotencyKey;
    readonly requestHash: string;
  };
  readonly audit: {
    readonly id: AuditRecordId;
    readonly actorUserAccountId: PostedJournal["postedByUserAccountId"];
    readonly correlationId: CorrelationId;
    readonly action: "FINANCE_JOURNAL_POSTED" | "FINANCE_JOURNAL_REVERSED";
    readonly payload: Readonly<Record<string, string>>;
  };
  readonly outbox: {
    readonly eventId: string;
    readonly eventType: "finance.journal.posted" | "finance.journal.reversed";
    readonly actorUserAccountId: PostedJournal["postedByUserAccountId"];
    readonly correlationId: CorrelationId;
  };
  readonly reversalOfJournalId?: JournalId;
}

export interface StoredIdempotencyResult { readonly requestHash: string; readonly journal: PostedJournal; }

export interface FinancePostingRepository {
  findIdempotencyResult(legalEntityId: LegalEntityId, operation: PostingCommit["idempotency"]["operation"], key: IdempotencyKey): Promise<StoredIdempotencyResult | undefined>;
  findJournalBySource(sourceType: string, sourceId: string): Promise<PostedJournal | undefined>;
  findJournalById(id: JournalId): Promise<PostedJournal | undefined>;
  findReversal(originalJournalId: JournalId): Promise<PostedJournal | undefined>;
  commit(commit: PostingCommit): Promise<void>;
}
