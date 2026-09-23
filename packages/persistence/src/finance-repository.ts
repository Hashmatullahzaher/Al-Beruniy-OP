import type { SqlExecutor } from "@abos/database";
import type {
  IdempotencyKey,
  JournalId,
  JournalLineDraft,
  LegalEntityId,
  PostedJournal,
  SupportedCurrency
} from "@abos/contracts";
import type {
  FinancePostingRepository,
  PostingCommit,
  StoredIdempotencyResult
} from "@abos/finance";

/**
 * Durable adapter for the Finance posting kernel.
 *
 * Scope, stated plainly: this implements the **capital receipt posting** path end to end against
 * the real schema. `commit()` refuses a reversal, because persisting one needs a REVERSAL posting
 * intent, an independent approval and REVERSAL_REASON plus FINANCE_APPROVAL evidence, and who
 * creates the reversal intent is a control decision that has not been made. The reversal controls
 * themselves are implemented and tested - in the kernel (F-5, F-6) and in SQL
 * (`journal_reversal_links_sod_guard`) - but the durable write path for them is not built, and is
 * listed as outstanding work rather than quietly stubbed.
 *
 * The kernel's `PostedJournal` and the database's journal model are not the same shape. The
 * database is richer: it owns the posting intent, the accounting effective date, the journal
 * reference and the subledger. This adapter maps between them and lets the database's own triggers
 * do the validating - it does not restate their rules in TypeScript, because a restatement can
 * drift and the triggers cannot.
 */
export class PostgresFinancePostingRepository implements FinancePostingRepository {
  private readonly database: SqlExecutor;
  private readonly newId: () => string;

  constructor(database: SqlExecutor, newId: () => string = () => crypto.randomUUID()) {
    this.database = database;
    this.newId = newId;
  }

  async findIdempotencyResult(
    legalEntityId: LegalEntityId,
    operation: PostingCommit["idempotency"]["operation"],
    key: IdempotencyKey
  ): Promise<StoredIdempotencyResult | undefined> {
    const result = await this.database.query<{
      readonly request_fingerprint: string;
      readonly resource_id: JournalId | null;
    }>(
      `SELECT request_fingerprint, resource_id
         FROM abos.idempotency_records
        WHERE scope = $1 AND idempotency_key = $2 AND status = 'COMPLETED'`,
      [scopeOf(legalEntityId, operation), key]
    );
    const row = result.rows[0];
    if (row === undefined || row.resource_id === null) return undefined;
    const journal = await this.findJournalById(row.resource_id);
    if (journal === undefined) return undefined;
    return { requestHash: row.request_fingerprint, journal };
  }

  async findJournalBySource(sourceType: string, sourceId: string): Promise<PostedJournal | undefined> {
    const result = await this.database.query<{ readonly id: JournalId }>(
      `SELECT j.id
         FROM abos.journals j
         JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
        WHERE pi.source_type = $1 AND pi.source_id = $2 AND j.status = 'POSTED'`,
      [sourceType, sourceId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.findJournalById(row.id);
  }

  async findJournalById(id: JournalId): Promise<PostedJournal | undefined> {
    const journals = await this.database.query<JournalRow>(
      `SELECT j.id, j.legal_entity_id, j.accounting_period_id, j.base_currency_code, j.status,
              j.posted_by_user_account_id, j.posted_at, pi.source_type, pi.source_id,
              link.original_journal_id
         FROM abos.journals j
         JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
         LEFT JOIN abos.journal_reversal_links link ON link.reversal_journal_id = j.id
        WHERE j.id = $1 AND j.status = 'POSTED'`,
      [id]
    );
    const journal = journals.rows[0];
    if (journal === undefined) return undefined;

    const lines = await this.database.query<LineRow>(
      `SELECT jl.id, jl.ledger_account_id, jl.original_amount::text AS original_amount,
              jl.original_currency_code, jl.base_debit::text AS base_debit,
              jl.base_credit::text AS base_credit, jl.legal_entity_id, jl.project_id,
              jl.department_id, jl.cost_center_id, se.subledger_type,
              coalesce(se.cash_location_currency_account_id::text, se.business_party_id::text)
                AS subledger_id
         FROM abos.journal_lines jl
         LEFT JOIN abos.subledger_entries se ON se.journal_line_id = jl.id
        WHERE jl.journal_id = $1
        ORDER BY jl.line_number`,
      [id]
    );

    return Object.freeze({
      id: journal.id,
      legalEntityId: journal.legal_entity_id,
      accountingPeriodId: journal.accounting_period_id,
      baseCurrency: journal.base_currency_code,
      sourceType: journal.source_type as PostedJournal["sourceType"],
      sourceId: journal.source_id,
      postedByUserAccountId: journal.posted_by_user_account_id,
      postedAt: iso(journal.posted_at),
      lines: Object.freeze(lines.rows.map(lineOf)),
      ...(journal.original_journal_id === null
        ? {}
        : { reversalOfJournalId: journal.original_journal_id }),
      status: "POSTED"
    }) satisfies PostedJournal;
  }

  async findReversal(originalJournalId: JournalId): Promise<PostedJournal | undefined> {
    const result = await this.database.query<{ readonly reversal_journal_id: JournalId }>(
      "SELECT reversal_journal_id FROM abos.journal_reversal_links WHERE original_journal_id = $1",
      [originalJournalId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.findJournalById(row.reversal_journal_id);
  }

  async commit(commit: PostingCommit): Promise<void> {
    if (commit.reversalOfJournalId !== undefined) {
      throw new Error(
        "PostgresFinancePostingRepository does not persist reversals yet. A durable reversal needs " +
          "a REVERSAL posting intent and an independent approval, and who creates that intent is " +
          "an unmade control decision. Kernel and SQL reversal controls are in place; the write " +
          "path is outstanding work."
      );
    }

    const { journal } = commit;
    await this.database.transaction(async (transaction) => {
      const intent = await this.loadPostingIntent(transaction, journal);
      const journalId = journal.id;

      await transaction.query(
        `INSERT INTO abos.journals
           (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
            accounting_effective_date, base_currency_code, status, created_by_user_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8)`,
        [
          journalId,
          journal.legalEntityId,
          journal.accountingPeriodId,
          intent.id,
          `JRN-${journalId}`,
          intent.accounting_effective_date,
          journal.baseCurrency,
          journal.postedByUserAccountId
        ]
      );

      let lineNumber = 0;
      for (const line of journal.lines) {
        lineNumber += 1;
        // The shareholder control line must name the business party; the database's posting guard
        // checks exactly that, and the subledger entry must agree with it.
        const businessPartyId =
          line.subledgerType === "SHAREHOLDER_CAPITAL" ? intent.shareholder_business_party_id : null;

        await transaction.query(
          `INSERT INTO abos.journal_lines
             (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id,
              project_id, department_id, cost_center_id, original_amount, original_currency_code,
              base_debit, base_credit, base_currency_code, source_type, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12::numeric,$13::numeric,$14,$15,$16)`,
          [
            line.id,
            journalId,
            journal.legalEntityId,
            lineNumber,
            line.ledgerAccountId,
            businessPartyId,
            dimensionOf(line, "projectId"),
            dimensionOf(line, "departmentId"),
            dimensionOf(line, "costCenterId"),
            line.originalAmount.amount,
            line.originalAmount.currency,
            line.debitBase ?? "0",
            line.creditBase ?? "0",
            journal.baseCurrency,
            journal.sourceType,
            journal.sourceId
          ]
        );

        if (line.subledgerType !== undefined) {
          // Sign convention the posting guard enforces: a debit line's subledger amount is
          // positive, a credit line's is negative.
          const signed = line.debitBase !== undefined ? line.debitBase : `-${line.creditBase}`;
          await transaction.query(
            `INSERT INTO abos.subledger_entries
               (id, legal_entity_id, journal_line_id, subledger_type, business_party_id,
                cash_location_currency_account_id, original_amount, original_currency_code,
                base_amount, base_currency_code, source_type, source_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9::numeric,$10,$11,$12)`,
            [
              this.newId(),
              journal.legalEntityId,
              line.id,
              line.subledgerType,
              businessPartyId,
              line.subledgerType === "CASH_LOCATION" ? line.subledgerId : null,
              signed,
              line.originalAmount.currency,
              signed,
              journal.baseCurrency,
              journal.sourceType,
              journal.sourceId
            ]
          );
        }
      }

      // Posting is a status transition, never an INSERT of a POSTED row: migration 0001 refuses
      // the latter outright, and this UPDATE is what fires the full posting guard.
      await transaction.query(
        `UPDATE abos.journals
            SET status = 'POSTED', posted_by_user_account_id = $2, posted_at = $3
          WHERE id = $1`,
        [journalId, journal.postedByUserAccountId, journal.postedAt]
      );
      // The posting intent is deliberately left APPROVED. Migration 0001's provenance guard makes
      // a posting intent immutable once a posted journal references it, so marking it POSTED after
      // the fact is refused - and it would be redundant anyway: journals.posting_intent_id is
      // unique, so a posted journal IS the record that the intent was posted.

      await transaction.query(
        `INSERT INTO abos.idempotency_records
           (scope, idempotency_key, request_fingerprint, correlation_id, status, resource_type,
            resource_id, response_code, completed_at)
         VALUES ($1,$2,$3,$4,'COMPLETED','JOURNAL',$5,200,clock_timestamp())`,
        [
          scopeOf(journal.legalEntityId, commit.idempotency.operation),
          commit.idempotency.key,
          commit.idempotency.requestHash,
          commit.audit.correlationId,
          journalId
        ]
      );

      await transaction.query(
        `INSERT INTO abos.audit_records
           (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type,
            entity_id, after_state)
         VALUES ($1,$2,$3,$4,$5,'JOURNAL',$6,$7::jsonb)`,
        [
          commit.audit.id,
          commit.audit.actorUserAccountId,
          journal.legalEntityId,
          commit.audit.correlationId,
          commit.audit.action,
          journalId,
          JSON.stringify(commit.audit.payload)
        ]
      );

      await transaction.query(
        `INSERT INTO abos.outbox_events
           (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id,
            actor_user_account_id, correlation_id, payload, occurred_at)
         VALUES ($1,'JOURNAL',$2,$3,1,$4,$5,$6,$7::jsonb,$8)`,
        [
          commit.outbox.eventId,
          journalId,
          commit.outbox.eventType,
          journal.legalEntityId,
          commit.outbox.actorUserAccountId,
          commit.outbox.correlationId,
          JSON.stringify({ journalId, sourceType: journal.sourceType, sourceId: journal.sourceId }),
          journal.postedAt
        ]
      );
    });
  }

  private async loadPostingIntent(
    transaction: SqlExecutor,
    journal: PostedJournal
  ): Promise<PostingIntentRow> {
    const result = await transaction.query<PostingIntentRow>(
      `SELECT pi.id, pi.accounting_effective_date, pi.status,
              cri.shareholder_business_party_id
         FROM abos.posting_intents pi
         LEFT JOIN abos.capital_receipt_intents cri
           ON cri.id = pi.capital_receipt_intent_id AND cri.legal_entity_id = pi.legal_entity_id
        WHERE pi.legal_entity_id = $1 AND pi.source_type = $2 AND pi.source_id = $3
          FOR UPDATE OF pi`,
      [journal.legalEntityId, journal.sourceType, journal.sourceId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `No posting intent exists for source ${journal.sourceType}:${journal.sourceId}. ` +
          "Finance posts against a persisted intent; it does not create one."
      );
    }
    return row;
  }
}

interface PostingIntentRow {
  readonly id: string;
  readonly accounting_effective_date: Date | string;
  readonly status: string;
  readonly shareholder_business_party_id: string | null;
}

interface JournalRow {
  readonly id: JournalId;
  readonly legal_entity_id: LegalEntityId;
  readonly accounting_period_id: PostedJournal["accountingPeriodId"];
  readonly base_currency_code: SupportedCurrency;
  readonly status: string;
  readonly posted_by_user_account_id: PostedJournal["postedByUserAccountId"];
  readonly posted_at: Date | string;
  readonly source_type: string;
  readonly source_id: string;
  readonly original_journal_id: JournalId | null;
}

interface LineRow {
  readonly id: JournalLineDraft["id"];
  readonly ledger_account_id: JournalLineDraft["ledgerAccountId"];
  readonly original_amount: string | null;
  readonly original_currency_code: SupportedCurrency | null;
  readonly base_debit: string;
  readonly base_credit: string;
  readonly legal_entity_id: LegalEntityId;
  readonly project_id: string | null;
  readonly department_id: string | null;
  readonly cost_center_id: string | null;
  readonly subledger_type: "CASH_LOCATION" | "SHAREHOLDER_CAPITAL" | null;
  readonly subledger_id: string | null;
}

function lineOf(row: LineRow): JournalLineDraft {
  const debit = row.base_debit !== "0" && Number(row.base_debit) !== 0;
  return {
    id: row.id,
    ledgerAccountId: row.ledger_account_id,
    dimensions:
      row.project_id === null
        ? {
            scope: "COMPANY_LEVEL",
            legalEntityId: row.legal_entity_id,
            companyLevelReason: "CORPORATE_CAPITAL"
          }
        : {
            scope: "PROJECT_LEVEL",
            legalEntityId: row.legal_entity_id,
            projectId: row.project_id as never,
            departmentId: row.department_id as never,
            costCenterId: row.cost_center_id as never
          },
    originalAmount: {
      amount: (row.original_amount ?? "0") as never,
      currency: row.original_currency_code ?? "USD"
    },
    ...(debit ? { debitBase: row.base_debit as never } : { creditBase: row.base_credit as never }),
    ...(row.subledger_type === null ? {} : { subledgerType: row.subledger_type }),
    ...(row.subledger_id === null ? {} : { subledgerId: row.subledger_id })
  };
}

function dimensionOf(
  line: JournalLineDraft,
  key: "projectId" | "departmentId" | "costCenterId"
): string | null {
  const dimensions = line.dimensions;
  if (dimensions.scope === "PROJECT_LEVEL") return dimensions[key];
  return key === "projectId" ? null : (dimensions[key] ?? null);
}

function scopeOf(
  legalEntityId: LegalEntityId,
  operation: PostingCommit["idempotency"]["operation"]
): string {
  return `${legalEntityId}:${operation}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
