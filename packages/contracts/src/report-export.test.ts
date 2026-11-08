import assert from "node:assert/strict";
import test from "node:test";

import {
  accountStatementTable, csvField, exportLineCount, generalLedgerTable, ledgerExportFits, REPORT_EXPORT_LINE_LIMIT, reportCsv, reportExportFileName, reportExportKind,
  safeStatementTable, trialBalanceTable, type ExportLedgerLine
} from "./report-export.ts";
import type { AccountStatementView, ReportRange, TreasuryStatementView, TrialBalanceView } from "./reporting.ts";

const range: ReportRange = { mode: "RANGE", from: "2026-09-01", to: "2026-09-30", period: null, fiscalYear: null, periods: [], fiscalYears: [] };
const restricted = { type: "RESTRICTED", id: null, label: { en: "Restricted movement", fa: "حرکت محدود" }, route: null, counterparty: null };

/** The table rows of a CSV, without the byte-order mark and header block. */
function body(csv: string): string[] {
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  return lines.slice(lines.indexOf("") + 1).filter((line) => line !== "");
}

const trialBalance: TrialBalanceView = {
  legalEntityId: "e", baseCurrency: "USD", range, includeZero: false, balanced: true, unbalancedJournals: 0,
  accounts: [
    { accountId: "a1", accountCode: "1100", accountName: "Cash", accountType: "ASSET", controlType: "CASH", accountCurrency: "USD", status: "ACTIVE", parentId: null,
      openingDebit: "0", openingCredit: "0", periodDebit: "1234567.891234", periodCredit: "0.10", endingDebit: "1234567.791234", endingCredit: "0",
      native: [{ currency: "AFN", openingNet: "-5.5", periodDebit: "7000.00", periodCredit: "0", endingNet: "6994.50" }] },
    { accountId: "a2", accountCode: "4100", accountName: "=HYPERLINK(\"http://x\",\"pay\")", accountType: "REVENUE", controlType: null, accountCurrency: "USD", status: "ACTIVE",
      parentId: null, openingDebit: "0", openingCredit: "0", periodDebit: "0.10", periodCredit: "1234567.891234", endingDebit: "0", endingCredit: "1234567.791234", native: [] }
  ],
  totals: { openingDebit: "0", openingCredit: "0", periodDebit: "1234568.991234", periodCredit: "1234568.991234", endingDebit: "1234567.791234", endingCredit: "1234567.791234" }
};

test("a text cell that could start a formula is written as text; an exact decimal stays a number", () => {
  for (const attack of ["=1+1", "+1", "-1+2", "@SUM(A1)", " =1", "\t=1", "\r=1", "＝1", "-HYPERLINK(\"x\")"]) {
    assert.equal(csvField({ text: attack }).startsWith("\"'"), true, JSON.stringify(attack));
  }
  assert.equal(csvField({ text: "Office \"supplies\", May" }), "\"Office \"\"supplies\"\", May\"");
  assert.equal(csvField({ amount: "-1234.50" }), "-1234.50");
  assert.equal(csvField({ amount: "0" }), "0");
  // Something that is not an exact decimal is never trusted as a number.
  assert.equal(csvField({ amount: "-1+1" }), "\"'-1+1\"");
  assert.equal(csvField({ amount: "1e9" }), "\"1e9\"");
});

test("amounts are the payload's decimal strings, character for character, never re-computed", () => {
  const csv = reportCsv(trialBalanceTable(trialBalance, "en"), "en", "2026-11-08T10:00:00.000Z");
  const rows = body(csv);
  assert.equal(rows[1], "\"1100\",\"Cash\",\"Asset\",\"USD\",0,0,1234567.891234,0.10,1234567.791234,0,\"\",\"\"");
  assert.equal(rows[2], "\"1100\",\"Native AFN\",\"\",\"AFN\",\"\",\"\",7000.00,0,\"\",\"\",-5.5,6994.50");
  assert.match(rows[3] ?? "", /^"4100","'=HYPERLINK\(""http:\/\/x"",""pay""\)","Income"/);
  assert.equal(rows[4], "\"\",\"Total\",\"\",\"USD\",0,0,1234568.991234,1234568.991234,1234567.791234,1234567.791234,\"\",\"\"");
  // The screen rows are the accounts and their native detail; the total row is the screen's footer.
  assert.equal(exportLineCount(trialBalanceTable(trialBalance, "en")), 3);
});

test("the file starts with a UTF-8 byte-order mark, says Confidential, and keeps Dari text intact", () => {
  const csv = reportCsv(trialBalanceTable({ ...trialBalance, accounts: [{ ...trialBalance.accounts[0]!, accountName: "صندوق اصلی" }] }, "fa"), "fa", "2026-11-08T10:00:00.000Z");
  const bytes = Buffer.from(csv, "utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(new TextDecoder("utf-8").decode(bytes).includes("صندوق اصلی"), true);
  assert.match(csv, /"محرمانه \/ Confidential"/);
  assert.match(csv, /"گزارش","بیلانس آزمایشی"/);
  assert.match(csv, /"دوره","2026-09-01 – 2026-09-30"/);
  assert.match(reportCsv(trialBalanceTable(trialBalance, "en"), "en", "x"), /"Confidential \/ محرمانه"/);
  assert.equal(csv.includes("\r\n"), true);
});

test("the file name is the report and its dates only", () => {
  assert.equal(reportExportFileName({ kind: "SAFE_STATEMENT", from: "2026-01-01", to: "2026-11-08" }), "safe-statement_2026-01-01_2026-11-08.csv");
  assert.equal(reportExportFileName({ kind: "GENERAL_LEDGER", from: "../Ahmad", to: "x\"y" }), "general-ledger_from_to.csv");
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
  const rows = body(reportCsv(accountStatementTable(statement, "en"), "en", "x"));
  assert.equal(rows[1], "\"2026-09-01\",\"Opening\",\"\",\"\",10.00,0,10.00,\"\",\"\",\"\"");
  assert.equal(rows[2], "\"2026-09-06\",\"DC-1\",\"\",\"Capital received · Synthetic Holder\",700.00,0,710.00,\"USD\",700.00,\"\"");
  assert.equal(rows[3], "\"2026-09-11\",\"Restricted movement\",\"\",\"Restricted movement\",0,50.00,660.00,\"USD\",50.00,\"\"");
  assert.equal(exportLineCount(accountStatementTable(statement, "en")), 2);
});

const safe = (currency: string): TreasuryStatementView => ({
  legalEntityId: "e", baseCurrency: "USD", accounts: [],
  statement: { range, canOpenLedger: true, carryingStatus: "OK",
    account: { id: "s1", nameEn: "Synthetic Person Saraf", nameFa: null, accountType: "SARAF", currencyCode: currency, status: "ACTIVE", ledgerAccount: null },
    opening: { native: "0", base: "0" }, closing: { native: "7000.00", base: "100.00" },
    totals: { moneyIn: "7000.00", moneyOut: "0", transfersIn: "0", transfersOut: "0", reversalsIn: "0", reversalsOut: "0", movementCount: 1 },
    lines: [{ id: "l1", date: "2026-09-14", postedAt: "x", moneyIn: "7000.00", moneyOut: "0", balance: "7000.00", currency, baseAmount: "100.00", runningBase: "100.00",
      restricted: false, kind: "EXTERNAL", isReversal: false, fx: null, journalId: "j", journalReference: "RC-1", transferPeer: null, reversedBy: null, reverses: null,
      source: { type: "CASH_RECEIPT", id: "r", label: { en: "Receipt", fa: "دریافت" }, route: null, counterparty: null, reference: "@cmd|' /C calc'!A0", description: null } }],
    reconciliation: { treasuryBase: "100.00", ledgerBase: "100.00", difference: "0", matches: true } }
});

test("a Safe statement shows carrying value only for another currency, and its name never reaches the file", () => {
  const afn = safeStatementTable(safe("AFN"), "en");
  assert.ok(afn);
  assert.equal(afn.headers.length, 9);
  const csv = reportCsv(afn, "en", "x");
  assert.equal(body(csv)[2], "\"2026-09-14\",\"RC-1\",\"\",\"Receipt · @cmd|' /C calc'!A0\",7000.00,0,7000.00,100.00,100.00");
  assert.equal(csv.includes("Synthetic Person Saraf"), false);
  assert.equal(reportExportFileName(afn), "safe-statement_2026-09-01_2026-09-30.csv");
  assert.equal(safeStatementTable(safe("USD"), "en")?.headers.length, 7);
  assert.equal(safeStatementTable({ ...safe("USD"), statement: null }, "en"), null);
});

test("the General Ledger export keeps every line, masks a restricted one, and refuses a range over the statement limit", () => {
  const line = (overrides: Partial<ExportLedgerLine>): ExportLedgerLine => ({ journalReference: "OPX-1", lineNumber: 1, accountCode: "5100", accountName: "Office Expense",
    sourceType: "OPERATIONAL_EXPENSE", sourceId: "s", accountingEffectiveDate: "2026-09-11", originalCurrency: "USD", originalAmount: "1000.00", baseCurrency: "USD",
    baseDebit: "1000.00", baseCredit: "0", restricted: false, source: null, ...overrides });
  const table = generalLedgerTable(range, [line({}), line({ restricted: true, journalReference: null, sourceType: "RESTRICTED", sourceId: null })],
    [{ currency: "USD", debits: "2000.00", credits: "0", lineCount: "2" }], "en");
  const rows = body(reportCsv(table, "en", "x"));
  assert.equal(rows[1], "\"2026-09-11\",\"OPX-1\",\"1\",\"5100\",\"Office Expense\",1000.00,0,\"USD\",\"USD\",1000.00,\"OPERATIONAL_EXPENSE · s\"");
  assert.equal(rows[2], "\"2026-09-11\",\"Restricted movement\",\"1\",\"5100\",\"Office Expense\",1000.00,0,\"USD\",\"USD\",1000.00,\"Restricted movement\"");
  assert.equal(exportLineCount(table), 2);
  assert.equal(ledgerExportFits([{ currency: "USD", debits: "0", credits: "0", lineCount: String(REPORT_EXPORT_LINE_LIMIT) }]), true);
  assert.equal(ledgerExportFits([{ currency: "USD", debits: "0", credits: "0", lineCount: "4000" }, { currency: "AFN", debits: "0", credits: "0", lineCount: "1001" }]), false);
  assert.equal(ledgerExportFits(null), true);
});
