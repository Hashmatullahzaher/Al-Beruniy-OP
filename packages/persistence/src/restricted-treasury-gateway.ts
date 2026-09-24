import type { LegalEntityId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";

export type RestrictedTreasuryQuery =
  | "LOCATIONS" | "ACCOUNTS" | "ASSIGNMENTS" | "OPENINGS" | "COUNTS"
  | "SOURCES" | "RECEIPTS" | "HANDOFFS" | "CASH_LEDGER" | "EVENTS"
  | "EVIDENCE" | "USERS" | "FINANCE_PROGRESS";

export type RestrictedTreasuryOperation =
  | "CREATE_LOCATION" | "SET_LOCATION_STATUS" | "OPEN_ACCOUNT"
  | "ASSIGN_CASHIER" | "REVOKE_CASHIER" | "RECORD_COUNT"
  | "CONFIRM_OPENING_COUNT" | "RECONCILE_OPENING" | "APPROVE_OPENING"
  | "ACTIVATE_ACCOUNT" | "BLOCK_ACCOUNT" | "RECORD_RECEIPT"
  | "COUNT_RECEIPT" | "SUBMIT_RECEIPT" | "VERIFY_RECEIPT"
  | "VOID_RECEIPT" | "HANDOFF_RECEIPT";

export interface RestrictedTreasuryAuthority {
  readonly bearerToken: string;
  readonly legalEntityId: LegalEntityId;
}

export interface RestrictedTreasurySessionContext {
  readonly sessionId: string;
  readonly userAccountId: string;
  readonly legalEntityId: string;
  readonly displayName: string;
  readonly expiresAt: string;
  readonly treasuryPermissions: readonly string[];
}

/**
 * The application-facing Treasury adapter for the restricted database credential.
 * It can call only the two audited SECURITY DEFINER entry points; actor identity and
 * authority are always derived again from the opaque bearer credential in PostgreSQL.
 */
export class RestrictedTreasuryGateway {
  private readonly database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.database = database;
  }

  async context(bearerToken: string): Promise<RestrictedTreasurySessionContext> {
    requireCredential(bearerToken);
    const result = await this.database.query<{ readonly result: RestrictedTreasurySessionContext }>(
      "SELECT abos.treasury_secure_context($1) AS result", [bearerToken]
    );
    const value = result.rows[0]?.result;
    if (value === undefined) throw new Error("Secure Treasury context returned no result");
    return value;
  }

  async revokeOwnSession(bearerToken: string): Promise<boolean> {
    requireCredential(bearerToken);
    const result = await this.database.query<{ readonly revoked: boolean }>(
      "SELECT abos.treasury_revoke_own_session($1) AS revoked", [bearerToken]
    );
    return result.rows[0]?.revoked === true;
  }

  async query<Result = unknown>(
    authority: RestrictedTreasuryAuthority,
    query: RestrictedTreasuryQuery,
    objectId?: string
  ): Promise<Result> {
    requireCredential(authority.bearerToken);
    const result = await this.database.query<{ readonly result: Result }>(
      "SELECT abos.treasury_secure_query($1, $2, $3, $4) AS result",
      [authority.bearerToken, authority.legalEntityId, query, objectId ?? null]
    );
    const value = result.rows[0]?.result;
    if (value === undefined) throw new Error("Secure Treasury query returned no result");
    return value;
  }

  async command<Result = { readonly id: string; readonly operation?: string; readonly replayed?: boolean }>(
    authority: RestrictedTreasuryAuthority,
    operation: RestrictedTreasuryOperation,
    payload: Readonly<Record<string, unknown>>
  ): Promise<Result> {
    requireCredential(authority.bearerToken);
    const result = await this.database.query<{ readonly result: Result }>(
      "SELECT abos.treasury_secure_command($1, $2, $3, $4::jsonb) AS result",
      [authority.bearerToken, authority.legalEntityId, operation, JSON.stringify(payload)]
    );
    const value = result.rows[0]?.result;
    if (value === undefined) throw new Error("Secure Treasury command returned no result");
    return value;
  }
}

function requireCredential(token: string): void {
  if (token.trim().length < 32) {
    throw new Error("Secure Treasury access requires an opaque sandbox bearer credential");
  }
}
