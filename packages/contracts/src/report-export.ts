import type { AccountStatementView, ReportSource, TreasuryStatementView, TrialBalanceView } from "./reporting.ts";

/**
 * Report export (owner decisions, 2026-11-08): a CSV is another rendering of the payload the screen already received. These functions are
 * pure: they never compute an amount, never read anything but the payload, and write only what the screen shows for the same payload.
 * Amounts are the exact decimal strings PostgreSQL returned. Text cells are neutralised so a spreadsheet never runs them as a formula.
 */

export type ReportExportKind = "TRIAL_BALANCE" | "GENERAL_LEDGER" | "ACCOUNT_STATEMENT" | "SAFE_STATEMENT";
export type ReportExportLanguage = "en" | "fa";

/** The address segment of each exportable report; also the first part of the file name. */
export const REPORT_EXPORT_SLUGS: Readonly<Record<ReportExportKind, string>> = {
  TRIAL_BALANCE: "trial-balance", GENERAL_LEDGER: "general-ledger", ACCOUNT_STATEMENT: "account-statement", SAFE_STATEMENT: "safe-statement"
};

export function reportExportKind(slug: string | null): ReportExportKind | null {
  const found = Object.entries(REPORT_EXPORT_SLUGS).find(([, value]) => value === slug);
  return found ? (found[0] as ReportExportKind) : null;
}

/** The same limit the account and Safe statements enforce in PostgreSQL (0053, 0057): an export is never a way around it. */
export const REPORT_EXPORT_LINE_LIMIT = 5000;

export type ExportCell = { readonly text: string } | { readonly amount: string };
/** LINE rows are the rows the screen lists; OPENING, CLOSING and TOTAL rows are the figures the screen shows around them. */
export interface ExportRow { readonly role: "LINE" | "OPENING" | "CLOSING" | "TOTAL"; readonly cells: readonly ExportCell[] }
export interface ExportTable {
  readonly kind: ReportExportKind;
  readonly title: { readonly en: string; readonly fa: string };
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly headers: readonly string[];
  readonly rows: readonly ExportRow[];
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Characters a spreadsheet treats as the start of a formula, also after leading spaces, and the control characters that hide one. */
const FORMULA = /^[\s ]*[=+\-@＝＋－＠]|^[\t\r\n]/;

const text = (value: string | null | undefined): ExportCell => ({ text: value ?? "" });
const amount = (value: string | null | undefined): ExportCell => (value === null || value === undefined || value === "" ? { text: "" } : { amount: value });

/** One CSV field. An amount that is an exact decimal stays a bare number; anything else is quoted text, defused if it could start a formula. */
export function csvField(cell: ExportCell): string {
  if ("amount" in cell && DECIMAL.test(cell.amount)) return cell.amount;
  const value = "amount" in cell ? cell.amount : cell.text;
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll("\"", "\"\"")}"`;
}

const LABELS = {
  report: { en: "Report", fa: "گزارش" }, period: { en: "Period", fa: "دوره" }, currency: { en: "Currency", fa: "واحد پول" },
  generated: { en: "Generated at", fa: "زمان تهیه" }, confidential: { en: "Confidential / محرمانه", fa: "محرمانه / Confidential" },
  restricted: { en: "Restricted movement", fa: "حرکت محدود" }, detailsRestricted: { en: "(details restricted)", fa: "(جزئیات محدود)" },
  reversed: { en: "reversed", fa: "برگشت شد" }, reverses: { en: "reverses", fa: "برگشتِ" }, total: { en: "Total", fa: "مجموع" },
  opening: { en: "Opening", fa: "افتتاحیه" }, closing: { en: "Closing", fa: "پایانی" }
} as const;

/**
 * The whole file: a UTF-8 byte-order mark so Excel reads Dari correctly, a short header block (report, period, currency, generation time and
 * the Confidential marking), one empty line, then the table. Lines end in CRLF.
 */
export function reportCsv(table: ExportTable, language: ReportExportLanguage, generatedAt: string): string {
  const head: ExportCell[][] = [
    [text(LABELS.report[language]), text(table.title[language])],
    [text(LABELS.period[language]), text(`${table.from} – ${table.to}`)],
    ...(table.currency ? [[text(LABELS.currency[language]), text(table.currency)]] : []),
    [text(LABELS.generated[language]), text(generatedAt)],
    [text(LABELS.confidential[language])]
  ];
  const lines = [...head.map((row) => row.map(csvField).join(",")), "", table.headers.map((header) => csvField(text(header))).join(","),
    ...table.rows.map((row) => row.cells.map(csvField).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** The file name carries only the report and its dates, never a person, account or counterparty name. */
export function reportExportFileName(table: Pick<ExportTable, "kind" | "from" | "to">): string {
  const from = DAY.test(table.from) ? table.from : "from";
  const to = DAY.test(table.to) ? table.to : "to";
  return `${REPORT_EXPORT_SLUGS[table.kind]}_${from}_${to}.csv`;
}

/** The number of screen rows an export carries, recorded in the audit event. */
export function exportLineCount(table: ExportTable): number {
  return table.rows.filter((row) => row.role === "LINE").length;
}

/** What the source cell of a statement says, word for word as the screen writes it. */
export function reportSourceText(source: ReportSource | null, language: ReportExportLanguage): string {
  if (source === null) return "—";
  return [language === "fa" ? source.label.fa : source.label.en, source.detail ? (language === "fa" ? source.detail.fa : source.detail.en) : null,
    source.counterparty].filter((part): part is string => part !== null && part !== "").join(" · ")
    + (source.detailRestricted ? ` ${LABELS.detailsRestricted[language]}` : "");
}

function reversalText(line: { readonly reversedBy: unknown; readonly reverses: { readonly reference: string | null } | null }, language: ReportExportLanguage): string {
  return [line.reversedBy ? LABELS.reversed[language] : null, line.reverses ? `${LABELS.reverses[language]} ${line.reverses.reference ?? ""}`.trim() : null]
    .filter((part): part is string => part !== null).join(" · ");
}

const TYPE_COPY: Readonly<Record<string, { readonly en: string; readonly fa: string }>> = {
  ASSET: { en: "Asset", fa: "دارایی" }, LIABILITY: { en: "Liability", fa: "بدهی" }, EQUITY: { en: "Equity", fa: "سرمایه" },
  REVENUE: { en: "Income", fa: "عاید" }, EXPENSE: { en: "Expense", fa: "مصرف" }
};

const pick = (language: ReportExportLanguage, en: string, fa: string) => (language === "fa" ? fa : en);

export function trialBalanceTable(view: TrialBalanceView, language: ReportExportLanguage): ExportTable {
  const l = (en: string, fa: string) => pick(language, en, fa);
  const rows: ExportRow[] = [];
  for (const row of view.accounts) {
    rows.push({ role: "LINE", cells: [text(row.accountCode), text(row.accountName), text(TYPE_COPY[row.accountType]?.[language] ?? row.accountType), text(view.baseCurrency),
      amount(row.openingDebit), amount(row.openingCredit), amount(row.periodDebit), amount(row.periodCredit), amount(row.endingDebit), amount(row.endingCredit), text(""), text("")] });
    for (const n of row.native) {
      rows.push({ role: "LINE", cells: [text(row.accountCode), text(l(`Native ${n.currency}`, `مبلغ اصلی به ${n.currency}`)), text(""), text(n.currency),
        text(""), text(""), amount(n.periodDebit), amount(n.periodCredit), text(""), text(""), amount(n.openingNet), amount(n.endingNet)] });
    }
  }
  const t = view.totals;
  rows.push({ role: "TOTAL", cells: [text(""), text(LABELS.total[language]), text(""), text(view.baseCurrency), amount(t.openingDebit), amount(t.openingCredit),
    amount(t.periodDebit), amount(t.periodCredit), amount(t.endingDebit), amount(t.endingCredit), text(""), text("")] });
  return { kind: "TRIAL_BALANCE", title: { en: "Trial balance", fa: "بیلانس آزمایشی" }, from: view.range.from, to: view.range.to, currency: view.baseCurrency,
    headers: [l("Code", "کد"), l("Account", "حساب"), l("Type", "نوع"), l("Currency", "واحد پول"), l("Opening debit", "بدهکار افتتاحیه"), l("Opening credit", "بستانکار افتتاحیه"),
      l("Period debit", "بدهکار دوره"), l("Period credit", "بستانکار دوره"), l("Ending debit", "بدهکار پایانی"), l("Ending credit", "بستانکار پایانی"),
      l("Native opening (net)", "افتتاحیهٔ اصلی (خالص)"), l("Native ending (net)", "پایانی اصلی (خالص)")], rows };
}

export function accountStatementTable(view: AccountStatementView, language: ReportExportLanguage): ExportTable {
  const l = (en: string, fa: string) => pick(language, en, fa);
  const rows: ExportRow[] = [{ role: "OPENING", cells: [text(view.range.from), text(LABELS.opening[language]), text(""), text(""),
    amount(view.opening.debit), amount(view.opening.credit), amount(view.opening.net), text(""), text(""), text("")] }];
  for (const line of view.lines) {
    rows.push({ role: "LINE", cells: [text(line.date), text(line.restricted ? LABELS.restricted[language] : line.journalReference), text(reversalText(line, language)),
      text(reportSourceText(line.source, language)), amount(line.debit), amount(line.credit), amount(line.balance), text(line.originalCurrency), amount(line.originalAmount),
      text(line.rate ? `1 ${line.rate.unitCurrency} = ${line.rate.rate} ${line.rate.quoteCurrency}` : "")] });
  }
  rows.push({ role: "CLOSING", cells: [text(view.range.to), text(LABELS.closing[language]), text(""), text(""), amount(view.closing.debit), amount(view.closing.credit),
    amount(view.closing.net), text(""), text(""), text("")] });
  rows.push({ role: "TOTAL", cells: [text(""), text(l("Period total", "مجموع دوره")), text(""), text(""), amount(view.periodDebit), amount(view.periodCredit), text(""),
    text(""), text(""), text("")] });
  return { kind: "ACCOUNT_STATEMENT", title: { en: `Account statement · ${view.account.code}`, fa: `صورت‌حساب · ${view.account.code}` }, from: view.range.from,
    to: view.range.to, currency: view.account.currency,
    headers: [l("Date", "تاریخ"), l("Reference", "مرجع"), l("Reversal", "برگشت"), l("Source", "منبع"), l("Debit", "بدهکار"), l("Credit", "بستانکار"),
      l("Balance (debit positive)", "موجودی (بدهکار مثبت)"), l("Original currency", "واحد پول اصلی"), l("Original amount", "مبلغ اصلی"), l("Rate", "نرخ")], rows };
}

/** A Safe or Saraf statement. The carrying-value columns appear only for an account in another currency, exactly as on the screen. */
export function safeStatementTable(view: TreasuryStatementView, language: ReportExportLanguage): ExportTable | null {
  const statement = view.statement;
  if (statement === null) return null;
  const l = (en: string, fa: string) => pick(language, en, fa);
  const currency = statement.account.currencyCode;
  const base = view.baseCurrency;
  const foreign = currency !== base;
  const carrying = (movement: ExportCell, value: ExportCell) => (foreign ? [movement, value] : []);
  const rows: ExportRow[] = [{ role: "OPENING", cells: [text(statement.range.from), text(LABELS.opening[language]), text(""), text(""), text(""), text(""),
    amount(statement.opening.native), ...carrying(text(""), amount(statement.opening.base))] }];
  for (const line of statement.lines) {
    const peer = line.transferPeer ? (language === "fa" ? line.transferPeer.fa : line.transferPeer.en) : null;
    const out = line.moneyOut !== "0";
    const movement = peer !== null ? l(`Transfer ${out ? "to" : "from"} ${peer}`, `انتقال ${out ? "به" : "از"} ${peer}`) : reportSourceText(line.source, language);
    const details = [movement, line.source?.reference ?? null, line.source?.description ?? null].filter((part): part is string => part !== null && part !== "").join(" · ");
    rows.push({ role: "LINE", cells: [text(line.date), text(line.restricted ? LABELS.restricted[language] : line.journalReference), text(reversalText(line, language)),
      text(details), amount(line.moneyIn), amount(line.moneyOut), amount(line.balance), ...carrying(amount(line.baseAmount), amount(line.runningBase))] });
  }
  rows.push({ role: "CLOSING", cells: [text(statement.range.to), text(LABELS.closing[language]), text(""), text(""), amount(statement.totals.moneyIn),
    amount(statement.totals.moneyOut), amount(statement.closing.native), ...carrying(text(""), amount(statement.closing.base))] });
  return { kind: "SAFE_STATEMENT", title: { en: `Safe / Saraf statement · ${currency}`, fa: `صورت‌حساب صندوق / صراف · ${currency}` }, from: statement.range.from,
    to: statement.range.to, currency,
    headers: [l("Date", "تاریخ"), l("Reference", "مرجع"), l("Reversal", "برگشت"), l("Details", "شرح"), l(`Money in (${currency})`, `ورودی (${currency})`),
      l(`Money out (${currency})`, `خروجی (${currency})`), l(`Balance (${currency})`, `موجودی (${currency})`),
      ...(foreign ? [l(`Carrying value movement (${base})`, `حرکت ارزش دفتری (${base})`), l(`Carrying value (${base})`, `ارزش دفتری (${base})`)] : [])], rows };
}

/** The General Ledger line fields the screen shows (the server type lives in the web app). */
export interface ExportLedgerLine {
  readonly journalReference: string | null;
  readonly lineNumber: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly accountingEffectiveDate: string;
  readonly originalCurrency: string | null;
  readonly originalAmount: string | null;
  readonly baseCurrency: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
  readonly restricted: boolean;
  readonly source: ReportSource | null;
}
export interface ExportLedgerTotal { readonly currency: string; readonly debits: string; readonly credits: string; readonly lineCount: string }

/** Whether the whole filtered range fits in one export, from the totals of its first page. */
export function ledgerExportFits(totals: readonly ExportLedgerTotal[] | null): boolean {
  const lines = (totals ?? []).reduce((sum, total) => sum + Number.parseInt(total.lineCount, 10), 0);
  return Number.isSafeInteger(lines) && lines <= REPORT_EXPORT_LINE_LIMIT;
}

export function generalLedgerTable(range: { readonly from: string; readonly to: string }, lines: readonly ExportLedgerLine[], totals: readonly ExportLedgerTotal[],
  language: ReportExportLanguage): ExportTable {
  const l = (en: string, fa: string) => pick(language, en, fa);
  const restrictedSource: ReportSource = { type: "RESTRICTED", id: null, label: { en: "Restricted movement", fa: "حرکت محدود" }, route: null, counterparty: null };
  const rows: ExportRow[] = lines.map((line) => ({ role: "LINE", cells: [text(line.accountingEffectiveDate),
    text(line.restricted ? LABELS.restricted[language] : line.journalReference), text(String(line.lineNumber)), text(line.accountCode), text(line.accountName),
    amount(line.baseDebit), amount(line.baseCredit), text(line.baseCurrency), text(line.originalCurrency), amount(line.originalAmount),
    text(line.source ? reportSourceText(line.source, language) : line.restricted ? reportSourceText(restrictedSource, language) : `${line.sourceType} · ${line.sourceId ?? ""}`)] }));
  for (const total of totals) {
    rows.push({ role: "TOTAL", cells: [text(""), text(LABELS.total[language]), text(""), text(""), text(l(`${total.lineCount} lines`, `${total.lineCount} ردیف`)),
      amount(total.debits), amount(total.credits), text(total.currency), text(""), text(""), text("")] });
  }
  return { kind: "GENERAL_LEDGER", title: { en: "General Ledger", fa: "دفتر کل" }, from: range.from, to: range.to,
    currency: totals.length === 1 ? (totals[0]?.currency ?? null) : null,
    headers: [l("Date", "تاریخ"), l("Reference", "مرجع"), l("Line", "ردیف"), l("Account code", "کد حساب"), l("Account", "حساب"), l("Debit", "بدهکار"), l("Credit", "بستانکار"),
      l("Currency", "واحد پول"), l("Original currency", "واحد پول اصلی"), l("Original amount", "مبلغ اصلی"), l("Source", "منبع")], rows };
}
