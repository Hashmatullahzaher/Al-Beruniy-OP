import { cookies } from "next/headers";
import pg from "pg";

import type { AccountingPeriodId, JournalId, PostingIntentId } from "@abos/contracts";
import type { QueryResult, SqlExecutor } from "@abos/database";
import { RestrictedCapitalPostingGateway } from "@abos/persistence";
import { SandboxAuthError } from "@abos/sandbox-auth";

import type { FinanceHandoffTraceView, FinanceHandoffWorkspaceView } from "@/lib/finance-handoff-types";
import { SESSION_COOKIE, TreasuryUnavailableError } from "@/server/treasury";

pg.types.setTypeParser(1700, (value: string) => value);

class PoolExecutor implements SqlExecutor {
  constructor(private readonly pool: pg.Pool) {}

  async query<Row extends object = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, [...parameters]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<Result>(operation: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor: SqlExecutor = {
        query: async <Row extends object = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
          const result = await client.query(sql, [...parameters]);
          return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
        },
        transaction: async <Nested>(nested: (tx: SqlExecutor) => Promise<Nested>) => nested(executor)
      };
      const result = await operation(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface FinanceRuntime { readonly executor: SqlExecutor; readonly posting: RestrictedCapitalPostingGateway }
const globalRuntime = globalThis as typeof globalThis & { __abosFinanceHandoffRuntime?: FinanceRuntime };

export function financeHandoffRuntime(): FinanceRuntime {
  if (globalRuntime.__abosFinanceHandoffRuntime) return globalRuntime.__abosFinanceHandoffRuntime;
  const url = process.env.ABOS_FINANCE_DATABASE_URL;
  if (!url?.trim()) throw new TreasuryUnavailableError("The E1 Finance sandbox is not configured (ABOS_FINANCE_DATABASE_URL is unset).");
  const executor = new PoolExecutor(new pg.Pool({ connectionString: url, max: 4 }));
  return globalRuntime.__abosFinanceHandoffRuntime = { executor, posting: new RestrictedCapitalPostingGateway(executor) };
}

export async function financeToken(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new SandboxAuthError("AUTHENTICATION_REQUIRED", "Sign in with a synthetic Finance session token.");
  return token;
}

async function jsonFunction<T>(sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await financeHandoffRuntime().executor.query<{ readonly value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The controlled Finance function returned no result.");
  return value;
}

export async function financeWorkspace(token: string): Promise<FinanceHandoffWorkspaceView> {
  const raw = await jsonFunction<RawWorkspace>("SELECT abos.finance_handoff_workspace($1) AS value", [token]);
  return {
    actor: {
      userAccountId: raw.actor.userAccountId,
      displayName: raw.actor.displayName ?? `Finance user ${raw.actor.userAccountId.slice(0, 8)}`,
      permissions: raw.actor.permissions,
      sessionExpiresAt: raw.actor.sessionExpiresAt ?? ""
    },
    handoffs: raw.handoffs.map(row => ({
      id: row.id, receiptId: row.cash_receipt_id, receiptReference: row.receipt_reference,
      shareholder: row.shareholder_display_name ?? "Authorized shareholder record",
      agreementReference: row.agreement_reference, installmentSequence: row.sequence_number,
      amount: row.amount, currency: row.currency_code, receivingAccount: row.location_name,
      handedOffAt: row.handed_off_at,
      stage: row.journal_status === "POSTED" ? "POSTED" : row.posting_status === "APPROVED" ? "APPROVED" : row.posting_status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "HANDED_TO_FINANCE",
      ...(row.posting_intent_id ? { postingIntentId: row.posting_intent_id } : {}),
      ...(row.journal_id ? { journalId: row.journal_id } : {})
    })),
    openPeriods: raw.openPeriods.map(period => ({ id: period.id, label: period.period_name, startsOn: period.starts_on, endsOn: period.ends_on }))
  };
}

export async function financeTrace(token: string, handoffId: string): Promise<FinanceHandoffTraceView> {
  const raw = await jsonFunction<RawTrace>("SELECT abos.finance_handoff_trace($1, $2::uuid) AS value", [token, handoffId]);
  const posting = raw.postingIntent;
  const approval = raw.approval;
  const journal = raw.journal;
  return {
    id: raw.handoff.id, receiptId: raw.receipt.id, receiptReference: raw.receipt.receipt_reference,
    shareholder: raw.shareholder.displayName, agreementReference: raw.agreement.reference,
    installmentSequence: raw.installment.sequenceNumber, amount: raw.source.amount,
    currency: raw.source.currency_code, receivingAccount: `${raw.safe.name} · ${raw.safe.currency}`,
    handedOffAt: raw.handoff.handed_off_at,
    stage: journal?.status === "POSTED" ? "POSTED" : posting?.status === "APPROVED" ? "APPROVED" : posting ? "PENDING_APPROVAL" : "HANDED_TO_FINANCE",
    agreementId: raw.agreement.id, installmentId: raw.installment.id, receivingSafe: raw.safe.name,
    physicalCount: {
      amount: raw.physicalCount.counted_amount,
      countedBy: raw.physicalCount.counted_by_display_name ?? raw.physicalCount.counted_by_user_account_id,
      confirmedBy: raw.physicalCount.confirmed_by_display_name ?? raw.physicalCount.confirmed_by_user_account_id,
      evidence: String(raw.evidence.count ?? "Evidence unavailable")
    },
    receiptEvidence: String(raw.evidence.receipt ?? "Evidence unavailable"),
    verifier: raw.receipt.verifier_display_name ?? raw.receipt.verified_by_user_account_id,
    handedOffBy: raw.handoff.handed_off_by_display_name ?? raw.handoff.handed_off_by_user_account_id,
    ...(posting ? { postingIntent: { id: posting.id, status: posting.status, createdBy: posting.created_by_display_name ?? posting.created_by_user_account_id, accountingEffectiveDate: posting.accounting_effective_date } } : {}),
    ...(approval ? { approval: { id: approval.id, approver: approval.approver_display_name ?? approval.approver_user_account_id, approvedAt: approval.approved_at, evidence: String(raw.evidence.approval ?? "Evidence unavailable") } } : {}),
    ...(journal ? { journal: { id: journal.id, reference: journal.journal_reference, status: journal.status, debit: raw.reconciliation.debits, credit: raw.reconciliation.credits, postedAt: journal.posted_at ?? "" } } : {}),
    reconciliation: { sourceStatus: raw.source.status, receiptStatus: raw.receipt.status, journalStatus: journal?.status ?? "NOT_POSTED" }
  };
}

interface RawWorkspace {
  readonly actor: { readonly userAccountId: string; readonly displayName?: string; readonly sessionExpiresAt?: string; readonly permissions: readonly string[] };
  readonly handoffs: readonly { readonly id: string; readonly cash_receipt_id: string; readonly receipt_reference: string; readonly shareholder_display_name?: string; readonly agreement_reference: string; readonly sequence_number: number; readonly amount: string; readonly currency_code: "USD"|"AFN"; readonly location_name: string; readonly handed_off_at: string; readonly posting_intent_id?: string; readonly posting_status?: string; readonly journal_id?: string; readonly journal_status?: string }[];
  readonly openPeriods: readonly { readonly id: string; readonly period_name: string; readonly starts_on: string; readonly ends_on: string }[];
}
interface RawTrace {
  readonly handoff: { readonly id: string; readonly handed_off_at: string; readonly handed_off_by_user_account_id: string; readonly handed_off_by_display_name?: string };
  readonly source: { readonly amount: string; readonly currency_code: "USD"|"AFN"; readonly status: string };
  readonly shareholder: { readonly displayName: string };
  readonly agreement: { readonly id: string; readonly reference: string };
  readonly installment: { readonly id: string; readonly sequenceNumber: number };
  readonly receipt: { readonly id: string; readonly receipt_reference: string; readonly status: string; readonly verified_by_user_account_id: string; readonly verifier_display_name?: string };
  readonly safe: { readonly name: string; readonly currency: string };
  readonly physicalCount: { readonly counted_amount: string; readonly counted_by_user_account_id: string; readonly confirmed_by_user_account_id: string; readonly counted_by_display_name?: string; readonly confirmed_by_display_name?: string };
  readonly evidence: { readonly count?: string; readonly receipt?: string; readonly approval?: string };
  readonly postingIntent?: { readonly id: string; readonly status: string; readonly created_by_user_account_id: string; readonly created_by_display_name?: string; readonly accounting_effective_date: string };
  readonly approval?: { readonly id: string; readonly approver_user_account_id: string; readonly approver_display_name?: string; readonly approved_at: string };
  readonly journal?: { readonly id: string; readonly journal_reference: string; readonly status: string; readonly posted_at?: string };
  readonly reconciliation: { readonly debits: string; readonly credits: string };
}

export async function preparePosting(token: string, handoffId: string, accountingPeriodId: string, idempotencyKey: string): Promise<string> {
  const result = await financeHandoffRuntime().executor.query<{ readonly posting_intent_id: string }>(
    "SELECT abos.finance_prepare_capital_posting($1, $2::uuid, $3::uuid, $4) AS posting_intent_id",
    [token, handoffId, accountingPeriodId, idempotencyKey]
  );
  const id = result.rows[0]?.posting_intent_id;
  if (!id) throw new Error("The controlled Finance prepare function returned no posting intent.");
  return id;
}

export async function approvePosting(token: string, postingIntentId: string): Promise<string> {
  const result = await financeHandoffRuntime().executor.query<{ readonly approval_id: string }>(
    "SELECT abos.finance_approve_capital_posting($1, $2::uuid) AS approval_id", [token, postingIntentId]
  );
  const id = result.rows[0]?.approval_id;
  if (!id) throw new Error("The controlled Finance approval function returned no approval.");
  return id;
}

export async function postApproved(token: string, postingIntentId: string, accountingPeriodId: string): Promise<JournalId> {
  return financeHandoffRuntime().posting.post({
    bearerToken: token,
    postingIntentId: postingIntentId as PostingIntentId,
    accountingPeriodId: accountingPeriodId as AccountingPeriodId
  });
}
