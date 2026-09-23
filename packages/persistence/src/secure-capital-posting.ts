import type { AccountingPeriodId, JournalId, PostingIntentId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";

export interface SecureCapitalPostingInput {
  /** Opaque, high-entropy session credential. The database derives the actor from this token. */
  readonly bearerToken: string;
  readonly postingIntentId: PostingIntentId;
  readonly accountingPeriodId: AccountingPeriodId;
}

/** The only E1 financial write available to the restricted runtime database role. */
export class RestrictedCapitalPostingGateway {
  private readonly database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.database = database;
  }

  async post(input: SecureCapitalPostingInput): Promise<JournalId> {
    if (input.bearerToken.trim().length < 32) {
      throw new Error("Secure capital posting requires an opaque sandbox bearer credential");
    }
    const result = await this.database.query<{ readonly journal_id: JournalId }>(
      "SELECT abos.post_synthetic_capital_receipt($1, $2, $3) AS journal_id",
      [input.bearerToken, input.postingIntentId, input.accountingPeriodId]
    );
    const journalId = result.rows[0]?.journal_id;
    if (journalId === undefined) throw new Error("Secure capital posting returned no journal");
    return journalId;
  }
}
