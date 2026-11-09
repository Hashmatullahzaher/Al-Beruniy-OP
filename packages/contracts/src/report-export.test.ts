import assert from "node:assert/strict";
import test from "node:test";

import {
  accountStatementTable, csvField, exportLineCount, generalLedgerTable, ledgerExportFits, ledgerLineCount, REPORT_EXPORT_LINE_LIMIT, reportCsv, reportExportFileName,
  reportExportKind, safeStatementTable, trialBalanceTable, type ExportLedgerLine
} from "./report-export.ts";
import type { AccountStatementView, ReportRange, TreasuryStatementView, TrialBalanceRow, TrialBalanceView } from "./reporting.ts";

/** Invisible and look-alike characters are built from their code points, so this file holds none of them literally. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const BOM = cp(0xfeff);
const RLM = cp(0x200f);
const DARI_SAFE = "صندوق اصلی";

const range: ReportRange = { mode: "RANGE", from: "2026-09-01", to: "2026-09-30", period: null, fiscalYear: null, periods: [], fiscalYears: [] };
const restricted = { type: "RESTRICTED", id: null, label: { en: "Restricted movement", fa: "حرکت محدود" }, route: null, counterparty: null };

/** A small RFC 4180 reader: what a spreadsheet decodes from the file, cell by cell. */
function parseCsv(csv: string): string[][] {
  const text = csv.startsWith(BOM) ? csv.slice(1) : csv;
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false; let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === "\"" && text.charAt(i + 1) === "\"") { cell += "\""; i += 2; continue; }
      if (ch === "\"") { quoted = false; i += 1; continue; }
      cell += ch; i += 1; continue;
    }
    if (ch === "\"") { quoted = true; i += 1; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i += 1; continue; }
    if (ch === "\r" && text.charAt(i + 1) === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 2; continue; }
    cell += ch; i += 1;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** The decoded table of a file: the heading row and the rows under it, after the header block and its empty line. */
function decodedTable(csv: string): { head: string[][]; headings: string[]; rows: string[][] } {
  const all = parseCsv(csv);
  const gap = all.findIndex((row) => row.length === 1 && row[0] === "");
  assert.notEqual(gap, -1, "an empty line separates the header block from the table");
  return { head: all.slice(0, gap), headings: all[gap + 1] ?? [], rows: all.slice(gap + 2) };
}

const account = (overrides: Partial<TrialBalanceRow>): TrialBalanceRow => ({ accountId: "a", accountCode: "1100", accountName: "Cash", accountType: "ASSET", controlType: null,
  accountCurrency: "USD", status: "ACTIVE", parentId: null, openingDebit: "0", openingCredit: "0", periodDebit: "0", periodCredit: "0", endingDebit: "0", endingCredit: "0",
  native: [], ...overrides });

const trialBalance: TrialBalanceView = {
  legalEntityId: "e", baseCurrency: "USD", range, includeZero: true, balanced: true, unbalancedJournals: 0,
  accounts: [
    account({ accountCode: "1100", accountName: "Cash", periodDebit: "1234567.891234", periodCredit: "0.10", endingDebit: "1234567.791234" }),
    // An AFN Safe: native AFN beside its USD carrying value, with a negative native opening.
    account({ accountCode: "1110", accountName: DARI_SAFE, accountCurrency: "AFN", periodDebit: "100.00", endingDebit: "100.00",
      native: [{ currency: "AFN", openingNet: "-5.5", periodDebit: "7000.00", periodCredit: "0", endingNet: "6994.50" }] }),
    account({ accountCode: "1900", accountName: "Very large", openingDebit: "123456789012345678901234567890.12", endingDebit: "123456789012345678901234567890.12" }),
    account({ accountCode: "1910", accountName: "No balance", openingDebit: "0.00", openingCredit: "0.00", endingDebit: "0.00", endingCredit: "0.00" }),
    account({ accountCode: "4100", accountName: "=HYPERLINK(\"http://x\",\"pay\")", accountType: "REVENUE", periodCredit: "1234567.891234", endingCredit: "1234567.891234" }),
    account({ accountCode: "4910", accountName: "Realized FX Gain", accountType: "REVENUE", periodCredit: "250.00", endingCredit: "250.00" }),
    account({ accountCode: "5910", accountName: "Realized FX Loss", accountType: "EXPENSE", periodDebit: "0.000001", endingDebit: "0.000001" })
  ],
  totals: { openingDebit: "123456789012345678901234567890.12", openingCredit: "0.00", periodDebit: "1234667.891235", periodCredit: "1234818.091234",
    endingDebit: "123456789012345678901234568090.91", endingCredit: "1234817.891234" }
};

test("the four formula characters are written as text: =1+1, +SUM(A1:A2), -CMD and @example", () => {
  assert.equal(csvField({ text: "=1+1" }), "\"'=1+1\"");
  assert.equal(csvField({ text: "+SUM(A1:A2)" }), "\"'+SUM(A1:A2)\"");
  assert.equal(csvField({ text: "-CMD" }), "\"'-CMD\"");
  assert.equal(csvField({ text: "@example" }), "\"'@example\"");
  assert.equal(csvField({ text: "=cmd|' /C calc'!A0" }), "\"'=cmd|' /C calc'!A0\"");
  assert.equal(csvField({ text: "-HYPERLINK(\"x\")" }), "\"'-HYPERLINK(\"\"x\"\")\"");
});

test("a formula hidden behind spaces, line breaks, direction marks or look-alike characters is still written as text", () => {
  const hidden = ["  =1+1", `${cp(0xa0)}=1`, "\t=1", "\r\n=1", "\n@x", `${RLM}=1+1`, `${cp(0x202b)}+1`, `${cp(0x200b)}@x`, `${cp(0x2066)}-1+2`, `${BOM}=1`,
    `${cp(0x2212)}1+1`, `${cp(0xff1d)}1`, `${cp(0xff0b)}1`, `${cp(0xff0d)}1`, `${cp(0xff20)}x`, "\tplain text after a tab"];
  for (const value of hidden) {
    const field = csvField({ text: value });
    assert.equal(field.startsWith("\"'"), true, JSON.stringify(value));
    // Nothing is removed: the original text follows the apostrophe.
    assert.equal(field, `"'${value}"`, JSON.stringify(value));
  }
});

test("ordinary text is never altered: Dari, right-to-left marks, commas, quotes and line breaks survive exactly", () => {
  const plain = ["Office supplies", DARI_SAFE, `${RLM}${DARI_SAFE}`, "A=B", "1+1", "Safe - main", "RV-1", "50% of @home", "Synthetic, Ltd.", "say \"paid\"",
    "first line\r\nsecond line", "first\nsecond", "", "0100"];
  for (const value of plain) {
    const field = csvField({ text: value });
    assert.equal(field.startsWith("\"") && field.endsWith("\""), true, JSON.stringify(value));
    assert.equal(parseCsv(field)[0]?.[0] ?? "", value, JSON.stringify(value));
  }
  assert.equal(csvField({ text: "Synthetic, Ltd." }), "\"Synthetic, Ltd.\"");
  assert.equal(csvField({ text: "say \"paid\"" }), "\"say \"\"paid\"\"\"");
});

test("an amount is the payload's own decimal string, bare and unchanged; anything else is never trusted as a number", () => {
  for (const exact of ["0", "0.00", "-1234.50", "1234567.891234", "-0.000001", "123456789012345678901234567890.12", "7000.00"]) {
    assert.equal(csvField({ amount: exact }), exact, exact);
  }
  // A negative amount is a number, not a formula: it is not prefixed.
  assert.equal(csvField({ amount: "-250.00" }).includes("'"), false);
  for (const [untrusted, written] of [["-1+1", "\"'-1+1\""], ["+5", "\"'+5\""], ["=1", "\"'=1\""], ["1e9", "\"1e9\""], ["1,234.00", "\"1,234.00\""], [" 12", "\" 12\""],
    ["12.", "\"12.\""], [".5", "\".5\""], [`${cp(0x2212)}5`, `"'${cp(0x2212)}5"`], ["NaN", "\"NaN\""], ["", "\"\""]] as const) {
    assert.equal(csvField({ amount: untrusted }), written, JSON.stringify(untrusted));
  }
});

test("decoded from the file, every row is the payload's row, in the payload's order, with the payload's figures", () => {
  const { headings, rows } = decodedTable(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "2026-11-08T10:00:00.000Z"));
  assert.equal(headings.length, 12);
  const types: Readonly<Record<string, string>> = { ASSET: "Asset", REVENUE: "Income", EXPENSE: "Expense" };
  const expected: string[][] = [];
  for (const row of trialBalance.accounts) {
    expected.push([row.accountCode, row.accountName.startsWith("=") ? `'${row.accountName}` : row.accountName, types[row.accountType] ?? "",
      "USD", row.openingDebit, row.openingCredit, row.periodDebit, row.periodCredit, row.endingDebit, row.endingCredit, "", ""]);
    for (const n of row.native) expected.push([row.accountCode, `Native ${n.currency}`, "", n.currency, "", "", n.periodDebit, n.periodCredit, "", "", n.openingNet, n.endingNet]);
  }
  const t = trialBalance.totals;
  expected.push(["", "Total", "", "USD", t.openingDebit, t.openingCredit, t.periodDebit, t.periodCredit, t.endingDebit, t.endingCredit, "", ""]);
  assert.deepEqual(rows, expected);
  // The screen rows are the accounts and their native detail; the total row is the screen's footer.
  assert.equal(exportLineCount(trialBalanceTable(trialBalance, "en")), trialBalance.accounts.length + 1);
  // The raw bytes: exact decimals are bare, the huge value is not rounded, the formula is quoted text.
  const csv = reportCsv(trialBalanceTable(trialBalance, "en"), "en", "x");
  assert.equal(csv.includes(",123456789012345678901234567890.12,"), true);
  assert.equal(csv.includes(",-5.5,6994.50"), true);
  assert.equal(csv.includes("\"'=HYPERLINK(\"\"http://x\"\",\"\"pay\"\")\""), true);
  assert.equal(/(^|,)=HYPERLINK/m.test(csv), false);
});

test("Dari and English files have the same columns, dates and figures; only headings and labels differ", () => {
  const en = decodedTable(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "x"));
  const fa = decodedTable(reportCsv(trialBalanceTable(trialBalance, "fa"), "fa", "x"));
  assert.equal(fa.headings.length, en.headings.length);
  assert.equal(fa.rows.length, en.rows.length);
  assert.notDeepEqual(fa.headings, en.headings);
  fa.rows.forEach((row, index) => {
    // Code, currency and the eight figure columns are machine-readable and identical in both languages.
    for (const column of [0, 3, 4, 5, 6, 7, 8, 9, 10, 11]) assert.equal(row[column], en.rows[index]?.[column], `row ${index} column ${column}`);
  });
  assert.equal(fa.headings[0], "کد");
  assert.equal(fa.rows[1]?.[1], DARI_SAFE);
});

test("the file starts with a UTF-8 byte-order mark, carries its header block, says Confidential, and keeps Dari text intact", () => {
  const csv = reportCsv(trialBalanceTable(trialBalance, "fa"), "fa", "2026-11-08T10:00:00.000Z", "شرکت نمونه");
  const bytes = Buffer.from(csv, "utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).includes(Buffer.from(BOM, "utf8")), false, "exactly one byte-order mark");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.equal(decoded.includes(DARI_SAFE), true);
  assert.deepEqual(decodedTable(csv).head, [["شرکت", "شرکت نمونه"], ["گزارش", "بیلانس آزمایشی"], ["دوره", "2026-09-01 – 2026-09-30"], ["واحد پول", "USD"],
    ["زمان تهیه", "2026-11-08T10:00:00.000Z"], ["محرمانه / Confidential"]]);
  assert.deepEqual(decodedTable(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "t", "Synthetic Company")).head,
    [["Company", "Synthetic Company"], ["Report", "Trial balance"], ["Period", "2026-09-01 – 2026-09-30"], ["Currency", "USD"], ["Generated at", "t"], ["Confidential / محرمانه"]]);
  // Without a company the block simply has no company row; a company name that looks like a formula is defused like any text.
  assert.equal(decodedTable(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "t")).head[0]?.[0], "Report");
  assert.equal(decodedTable(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "t", "=Evil Co")).head[0]?.[1], "'=Evil Co");
  assert.equal(csv.endsWith("\r\n"), true);
  assert.equal(csv.replaceAll("\r\n", "").includes("\n"), false, "every line ends in CRLF");
});

test("the file name is the report and its dates only", () => {
  assert.equal(reportExportFileName({ kind: "SAFE_STATEMENT", from: "2026-01-01", to: "2026-11-08" }), "safe-statement_2026-01-01_2026-11-08.csv");
  assert.equal(reportExportFileName({ kind: "GENERAL_LEDGER", from: "../Ahmad", to: "x\"y" }), "general-ledger_from_to.csv");
  for (const kind of ["TRIAL_BALANCE", "GENERAL_LEDGER", "ACCOUNT_STATEMENT", "SAFE_STATEMENT"] as const) {
    assert.match(reportExportFileName({ kind, from: "2026-09-01", to: "2026-09-30" }), /^[a-z-]+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  }
  assert.equal(reportExportKind("trial-balance"), "TRIAL_BALANCE");
  assert.equal(reportExportKind("balance-sheet"), null);
  assert.equal(reportExportKind(null), null);
});

const statement: AccountStatementView = {
  legalEntityId: "e", range, account: { id: "a1", code: "1100", name: "Cash", type: "ASSET", controlType: "CASH", currency: "USD", status: "ACTIVE" },
  opening: { debit: "10.00", credit: "0", net: "10.00" }, periodDebit: "700.00", periodCredit: "50.00", closing: { debit: "660.00", credit: "0", net: "660.00" },
  lines: [
    { journalId: "j1", lineNumber: 1, date: "2026-09-06", postedAt: "x", debit: "700.00", credit: "0", balance: "710.00", originalAmount: "700.00", originalCurrency: "USD",
      rate: null, restricted: false, journalReference: "DC-1", reversedBy: null, reverses: null,
      source: { type: "DIRECT_SHAREHOLDER_CAPITAL", id: null, label: { en: "Capital received", fa: "سرمایه دریافت‌شده" }, route: null, counterparty: "Synthetic Holder" } },
    { journalId: "j2", lineNumber: 1, date: "2026-09-11", postedAt: "x", debit: "0", credit: "50.00", balance: "660.00", originalAmount: "50.00", originalCurrency: "USD",
      rate: null, restricted: true, journalReference: null, reversedBy: null, reverses: null, source: restricted }
  ]
};

test("a restricted statement line is written as the screen writes it: amounts kept, reference and source withheld", () => {
  const table = accountStatementTable(statement, "en");
  const { head, rows } = decodedTable(reportCsv(table, "en", "x"));
  assert.deepEqual(head.slice(0, 2), [["Report", "Account statement"], ["Account", "1100 · Cash"]]);
  assert.deepEqual(rows[0], ["2026-09-01", "Opening", "", "", "10.00", "0", "10.00", "", "", ""]);
  assert.deepEqual(rows[1], ["2026-09-06", "DC-1", "", "Capital received · Synthetic Holder", "700.00", "0", "710.00", "USD", "700.00", ""]);
  assert.deepEqual(rows[2], ["2026-09-11", "Restricted movement", "", "Restricted movement", "0", "50.00", "660.00", "USD", "50.00", ""]);
  assert.deepEqual(rows[3], ["2026-09-30", "Closing", "", "", "660.00", "0", "660.00", "", "", ""]);
  assert.deepEqual(rows[4], ["", "Period total", "", "", "700.00", "50.00", "", "", "", ""]);
  assert.equal(exportLineCount(table), statement.lines.length);
  // The formatter reads nothing but what the screen shows: internal ids are not exported.
  assert.equal(reportCsv(table, "en", "x").includes("j2"), false, "journal ids are not exported");
});

const safe = (currency: string): TreasuryStatementView => ({
  legalEntityId: "e", baseCurrency: "USD", accounts: [],
  statement: { range, canOpenLedger: true, carryingStatus: "OK",
    account: { id: "s1", nameEn: "Synthetic Person Saraf", nameFa: "صراف نمونه", accountType: "SARAF", currencyCode: currency, status: "ACTIVE", ledgerAccount: null },
    opening: { native: "0", base: "0" }, closing: { native: "7000.00", base: "100.00" },
    totals: { moneyIn: "7000.00", moneyOut: "0", transfersIn: "0", transfersOut: "0", reversalsIn: "0", reversalsOut: "0", movementCount: 1 },
    lines: [{ id: "l1", date: "2026-09-14", postedAt: "x", moneyIn: "7000.00", moneyOut: "0", balance: "7000.00", currency, baseAmount: "100.00", runningBase: "100.00",
      restricted: false, kind: "EXTERNAL", isReversal: false, fx: null, journalId: "j", journalReference: "RC-1", transferPeer: null, reversedBy: null, reverses: null,
      source: { type: "CASH_RECEIPT", id: "r", label: { en: "Receipt", fa: "دریافت" }, route: null, counterparty: null, reference: "@cmd|' /C calc'!A0", description: null } }],
    reconciliation: { treasuryBase: "100.00", ledgerBase: "100.00", difference: "0", matches: true } }
});

test("a Safe statement names its Safe in the header, never in the file name, and shows carrying value only for another currency", () => {
  const afn = safeStatementTable(safe("AFN"), "en");
  assert.ok(afn);
  assert.equal(afn.headers.length, 9);
  const decoded = decodedTable(reportCsv(afn, "en", "x"));
  // The statement says which Safe it is, as the screen's heading does. Native AFN and the USD carrying value sit side by side.
  assert.deepEqual(decoded.head.slice(0, 2), [["Report", "Safe / Saraf statement"], ["Account", "Synthetic Person Saraf"]]);
  assert.deepEqual(decoded.rows[1], ["2026-09-14", "RC-1", "", "Receipt · @cmd|' /C calc'!A0", "7000.00", "0", "7000.00", "100.00", "100.00"]);
  assert.deepEqual(decoded.rows[2], ["2026-09-30", "Closing", "", "", "7000.00", "0", "7000.00", "", "100.00"]);
  assert.equal(reportExportFileName(afn), "safe-statement_2026-09-01_2026-09-30.csv");
  const afnDari = safeStatementTable(safe("AFN"), "fa");
  assert.ok(afnDari);
  assert.deepEqual(decodedTable(reportCsv(afnDari, "fa", "x")).head[1], ["حساب", "صراف نمونه"]);
  assert.equal(safeStatementTable(safe("USD"), "en")?.headers.length, 7);
  assert.equal(safeStatementTable({ ...safe("USD"), statement: null }, "en"), null);
});

test("the General Ledger export keeps every line and masks a restricted one", () => {
  const line = (overrides: Partial<ExportLedgerLine>): ExportLedgerLine => ({ journalReference: "OPX-1", lineNumber: 1, accountCode: "5100", accountName: "Office Expense",
    sourceType: "OPERATIONAL_EXPENSE", sourceId: "s", accountingEffectiveDate: "2026-09-11", originalCurrency: "USD", originalAmount: "1000.00", baseCurrency: "USD",
    baseDebit: "1000.00", baseCredit: "0", restricted: false, source: null, ...overrides });
  const table = generalLedgerTable(range, [line({}), line({ restricted: true, journalReference: null, sourceType: "RESTRICTED", sourceId: null })],
    [{ currency: "USD", debits: "2000.00", credits: "0", lineCount: "2" }], "en");
  const { rows } = decodedTable(reportCsv(table, "en", "x"));
  assert.deepEqual(rows[0], ["2026-09-11", "OPX-1", "1", "5100", "Office Expense", "1000.00", "0", "USD", "USD", "1000.00", "OPERATIONAL_EXPENSE · s"]);
  assert.deepEqual(rows[1], ["2026-09-11", "Restricted movement", "1", "5100", "Office Expense", "1000.00", "0", "USD", "USD", "1000.00", "Restricted movement"]);
  assert.deepEqual(rows[2], ["", "Total", "", "", "2 lines", "2000.00", "0", "USD", "", "", ""]);
  assert.equal(exportLineCount(table), 2);
});

test("the General Ledger export fits just below and at the statement limit, and not one line above it", () => {
  const total = (currency: string, lineCount: number) => ({ currency, debits: "0", credits: "0", lineCount: String(lineCount) });
  assert.equal(REPORT_EXPORT_LINE_LIMIT, 5000);
  assert.equal(ledgerExportFits([total("USD", REPORT_EXPORT_LINE_LIMIT - 1)]), true);
  assert.equal(ledgerExportFits([total("USD", REPORT_EXPORT_LINE_LIMIT)]), true);
  assert.equal(ledgerExportFits([total("USD", REPORT_EXPORT_LINE_LIMIT + 1)]), false);
  // The limit is on the whole range, across currencies.
  assert.equal(ledgerExportFits([total("USD", 4000), total("AFN", 1000)]), true);
  assert.equal(ledgerExportFits([total("USD", 4000), total("AFN", 1001)]), false);
  assert.equal(ledgerLineCount([total("USD", 4000), total("AFN", 1001)]), 5001);
  assert.equal(ledgerLineCount(null), 0);
  assert.equal(ledgerExportFits(null), true);
  assert.equal(ledgerExportFits([{ currency: "USD", debits: "0", credits: "0", lineCount: "many" }]), false, "a count that is not a number never fits");
});
