# V1 report export (PDF and Excel): design record

**Status:** owner decisions recorded and CSV built (2026-11-08); see *Owner decisions* and *Built* at the end. Native `.xlsx` waits for the dependency review below; PDF stays browser Print to PDF.

## What exists today

- Every report is a server function in `apps/web/src/server/reporting.ts` and `general-ledger.ts`. It calls one PostgreSQL read function through the restricted Finance runtime. Every figure is computed in the database from posted journals, and the same SQL boundary enforces confidentiality, legal-entity scope and masking.
- The reports are the trial balance, account statement, Safe and Saraf statement, shareholder statement, income statement, balance sheet, period summary, journal detail and general ledger.
- `globals.css` has a print stylesheet that hides navigation and filters and prints tables in black on white. A browser's own "Print to PDF" already produces a PDF of any report the person can see.
- The app has no export library among its dependencies. `V1_REPORTING_AND_FINANCIAL_STATEMENTS_DESIGN.md` §10 left PDF and Excel out of the reporting slice.

## Rule: one read model, no second query

An export is a different rendering of the JSON the report endpoint already returns. It never issues its own SQL, never widens the filter, and never runs under another database role. A person can export only what they can see on the screen. A masked or not-found answer exports as the same refusal. A future AI Core or Telegram export uses the same functions.

Concretely, a shared module, for example `server/report-export.ts`, takes `(reportKind, the validated range or filter, the session)`. It calls the existing `*Get` logic, or the function it wraps, and receives the same typed payload. It then hands that payload to a formatter: `csv`, `xlsx` or `pdf`. Formatters are pure functions of the payload and the locale.

## Risks and how the design meets them

| Risk | Mitigation |
| --- | --- |
| Confidentiality: an export path that reads more than the screen | The single-read-model rule above. Tests assert that the exported row set equals the on-screen row set for a restricted user, and that a refused report exports nothing. |
| Spreadsheet formula injection (a description beginning with `=`, `+`, `-` or `@`) | The CSV/XLSX formatter writes text cells as text and prefixes a leading formula character with an apostrophe. Amounts are written as numbers from the decimal strings, never by re-computing them. |
| Money precision | Amounts arrive as exact decimal strings from PostgreSQL. The formatter writes them without floating-point arithmetic, and totals come from the payload, not from spreadsheet formulas. |
| Dari, right-to-left and dual dates in PDF | Most JavaScript PDF libraries do not shape Persian script. A server-side PDF needs either a shaping-capable engine or headless Chromium rendering the existing print view. Until then, browser print is the safe PDF path. |
| Supply chain (the repository is public and the stack is pinned) | Any new library (an XLSX writer, a PDF engine) needs a separate dependency review: maintenance, licence, transitive size, and no network or `eval` at runtime. CSV needs no dependency. |
| Very long statements | Reuse the existing `TOO_MANY_LINES` refusal and limits. An export is never a way around them. |
| Caching and leakage | Responses keep `Cache-Control: no-store`. File names carry the report and period only, never a person's name. |
| Audit | Whether an export is recorded as an audit event is an owner decision (below). If yes, it goes through the existing audit path with report kind, range and row count, never the content. |

## Recommended order

1. **Now, no build:** browser print to PDF through the existing print stylesheet. This is already available and needs no change.
2. **Step 1 (low risk, no dependency):** CSV export from the shared layer for tabular reports (trial balance, account and Safe statements, general ledger), with a UTF-8 byte-order mark so Excel opens Dari correctly. Browser tests compare the export with the screen for an authorised user and for a restricted user.
3. **Step 2 (needs a dependency review):** native `.xlsx` with number formats and a header block (company, report, period, generated-at, "Confidential").
4. **Step 3 (needs a rendering decision):** a server-side PDF with the same header block, rendered from the print view by a shaping-capable engine.

## Owner decisions that were required before building (answered 2026-11-08, below)

1. Is CSV acceptable as the first Excel-compatible export, or is native `.xlsx` required from the start?
2. Should each export be recorded as an audit event, and should exported files carry a "Confidential" footer or watermark?

## Owner decisions (2026-11-08)

1. CSV is accepted as the first Excel-compatible export, for the Trial Balance, General Ledger, Account Statement and Safe / Saraf Statement. It is UTF-8 with a byte-order mark, and the screen calls it "CSV (Excel-compatible)", never native Excel. Native `.xlsx` comes later, after a dependency review.
2. Every export is an audit event, with metadata only: report kind, company, validated range and filter, format, row count, person and session, and time. Report contents never enter the audit.
3. Exported material is Confidential. Printed and PDF copies carry "Confidential / محرمانه". CSV file names carry only the report kind and dates. A future `.xlsx` carries a header block: Company, Report, Period, Generated at, Confidential.
4. PDF for V1 remains browser Print to PDF, from the existing report pages and print CSS. There is no PDF library and no second reporting engine.

## Built

- `apps/web/src/server/report-export.ts` and `GET /api/v1/finance/report-export?report=…&format=csv&lang=en|fa&…`. The export reads through the same server functions as the screens (`trialBalanceData`, `accountStatementData`, `safeStatementData`, `generalLedgerView`), under the same session and database role. It issues no SQL of its own. The General Ledger is read page by page through the screen's page function, and the export refuses a range over 5,000 lines, the same limit the statements enforce in PostgreSQL. Responses are `no-store`, and files are made per request and never stored, including in the Document Vault.
- `packages/contracts/src/report-export.ts`: pure formatters. Amounts are the payload's decimal strings, written unchanged. A text cell that could start a formula (`=`, `+`, `-`, `@`, also after spaces, their full-width forms, and leading tab or CR) is written as text with a leading apostrophe. The header block holds the report, period, currency, generation time and the Confidential marking. It holds no company name: that would need a second lookup, and the export reads only the report.
- Migration `0068_v1_report_export_audit`: `finance_report_export_record` accepts only metadata fields, each from a closed list and checked for shape, and has no free-text field. The company, person and session come from the session. A filter must name the session's own company's account or period, and the same report permission is required. If the audit fails, nothing is exported.
- Printing: `ReportPrintHeader` on every printable report (company, report, period, currency, print time, Confidential; English, and Dari right to left), plus a running "Confidential / محرمانه" footer on every printed page.

## Native `.xlsx`: dependency review (2026-11-08)

| Candidate | Licence | Maintenance | Dependencies | Notes |
| --- | --- | --- | --- | --- |
| `write-excel-file` 4.1.1 | MIT | Releases through June 2026 | One: `fflate` (MIT, no dependencies) | Writer only. Has a Node entry point (`write-excel-file/node`, Node ≥ 18) and needs no network. Typed `String`, `Number` and `Date` cells, the `@` text format, and a `rightToLeft` sheet option. |
| `exceljs` 4.4.0 | MIT | Last release October 2023 | Nine direct dependencies (`archiver`, `unzipper`, `tmp`, `uuid`, `jszip`, …) | Reads and writes, a much larger surface than an export needs. |
| `xlsx` (SheetJS) 0.18.5 on npm | Apache-2.0 | npm build from March 2022 | Seven | Newer fixed builds are published outside the npm registry, so it is not acceptable for this public, pinned repository. |

**Recommendation:** `write-excel-file`, on its own slice, after the CSV release gate is green. Before adoption:

- pin the exact version in the lockfile;
- scan the package and `fflate` for `eval`, `new Function` and network calls;
- write text only as `String` cells, never `Formula`;
- write amounts as `Number` only when the decimal string has 15 or fewer significant digits, otherwise as text with the `@` format, so no amount is rounded by floating point;
- add the owner's header block (Company, Report, Period, Generated at, Confidential);
- set `rightToLeft` for Dari.

