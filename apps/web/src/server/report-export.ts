import {
  accountStatementTable, exportLineCount, generalLedgerTable, ledgerExportFits, REPORT_EXPORT_LINE_LIMIT, reportCsv, reportExportFileName, reportExportKind,
  safeStatementTable, trialBalanceTable, type ExportTable, type ReportExportKind, type ReportExportLanguage, type ReportRange
} from "@abos/contracts";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { generalLedgerView, ledgerErrorResponse, parseLedgerQuery, type GeneralLedgerLine } from "@/server/general-ledger";
import { sessionToken } from "@/server/identity";
import { restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { accountStatementData, reportingErrorResponse, safeStatementData, trialBalanceData } from "@/server/reporting";

/**
 * Report export (owner decisions, 2026-11-08). One rule: an export is the payload the screen receives for the same query, rendered as CSV.
 * It reads through the same server functions as the screens (trialBalanceData, accountStatementData, safeStatementData, generalLedgerView),
 * under the same session and database role, so masking, legal-entity scope and the statement limits apply unchanged. It issues no SQL of its
 * own. Before answering, it records the export as an audit event (0068, metadata only); if that fails, nothing is exported. The file is made
 * for this request and never stored.
 */

class ExportRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const TOO_LONG = () => new ExportRefusal(422, "TOO_MANY_LINES", "This statement is too long. Choose a shorter period.");

function refusal(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

type Built = { readonly table: ExportTable; readonly audit: Record<string, unknown> };

/** The range the report itself resolved, as the audit records it. */
function rangeAudit(range: ReportRange): Record<string, unknown> {
  return { mode: range.mode, from: range.from, to: range.to, ...(range.period ? { periodId: range.period.id } : {}),
    ...(range.mode === "YEAR" && range.fiscalYear ? { fiscalYearId: range.fiscalYear.id } : {}) };
}

async function generalLedger(query: URLSearchParams, language: ReportExportLanguage): Promise<Built> {
  const ledger = parseLedgerQuery(query, false);
  if (ledger === null) throw new ExportRefusal(422, "VALIDATION_FAILED", "Choose a valid inclusive date range and account.");
  // Every page comes from the screen's own page function, in its order; the first page's totals decide whether the range fits at all.
  const first = await generalLedgerView(ledger.from, ledger.to, ledger.accountId, null, 100);
  if (!ledgerExportFits(first.totals)) throw TOO_LONG();
  const lines: GeneralLedgerLine[] = [...first.lines];
  for (let cursor = first.nextCursor; cursor !== null;) {
    const page = await generalLedgerView(ledger.from, ledger.to, ledger.accountId, cursor, 100);
    lines.push(...page.lines);
    if (lines.length > REPORT_EXPORT_LINE_LIMIT) throw TOO_LONG();
    cursor = page.nextCursor;
  }
  return { table: generalLedgerTable({ from: ledger.from, to: ledger.to }, lines, first.totals ?? [], language),
    audit: { mode: "RANGE", from: ledger.from, to: ledger.to, ...(ledger.accountId ? { accountId: ledger.accountId } : {}) } };
}

async function build(kind: ReportExportKind, query: URLSearchParams, language: ReportExportLanguage): Promise<Built> {
  if (kind === "TRIAL_BALANCE") {
    const view = await trialBalanceData(query);
    return { table: trialBalanceTable(view, language), audit: { ...rangeAudit(view.range), includeZero: view.includeZero } };
  }
  if (kind === "ACCOUNT_STATEMENT") {
    const view = await accountStatementData(query);
    return { table: accountStatementTable(view, language), audit: { ...rangeAudit(view.range), accountId: view.account.id } };
  }
  if (kind === "SAFE_STATEMENT") {
    if (!query.get("accountId")) throw new ExportRefusal(422, "VALIDATION_FAILED", "Choose a Safe or Saraf.");
    const view = await safeStatementData(query);
    const table = safeStatementTable(view, language);
    if (table === null || view.statement === null) throw new ExportRefusal(422, "VALIDATION_FAILED", "Choose a Safe or Saraf.");
    return { table, audit: { ...rangeAudit(view.statement.range), accountId: view.statement.account.id } };
  }
  return generalLedger(query, language);
}

export async function reportExportGet(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const kind = reportExportKind(query.get("report"));
  const language = query.get("lang");
  if (kind === null || query.get("format") !== "csv" || (language !== "en" && language !== "fa")) {
    return refusal(422, "VALIDATION_FAILED", "Choose a report, a format and a language.");
  }
  let built: Built;
  try {
    built = await build(kind, query, language);
  } catch (error) {
    if (error instanceof ExportRefusal) return refusal(error.status, error.code, error.message);
    return kind === "GENERAL_LEDGER" ? ledgerErrorResponse(error) : reportingErrorResponse(error);
  }
  try {
    await restrictedFinanceAuthenticator().reportExportRecord(financeHandoffRuntime().executor, await sessionToken(),
      { kind, format: "CSV", language, ...built.audit, rowCount: exportLineCount(built.table) });
  } catch (error) {
    // No audit, no export.
    return reportingErrorResponse(error);
  }
  return new Response(reportCsv(built.table, language, new Date().toISOString()), { status: 200, headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${reportExportFileName(built.table)}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-ABOS-Data": "operational"
  } });
}
