# V1 report export (CSV, print and PDF): design record

**Status (2026-11-10):** CSV export is built on branch `claude/report-export-csv` and is **not merged**: its database tests, database-backed browser tests and upgrade proof have not run yet, because the test database clusters were unavailable. Unit tests, typecheck, lint, the production build and the mocked browser suite pass. PDF stays browser Print to PDF. Native `.xlsx` is recommended for after V1; see `V1_XLSX_DEPENDENCY_REVIEW.md`.

## Owner decisions (2026-11-08)

1. CSV is the first Excel-compatible export, for the Trial Balance, General Ledger, Account Statement and Safe / Saraf Statement. It is UTF-8 with a byte-order mark. The screen calls it "CSV (Excel-compatible)", never native Excel.
2. Every export is an audit event, with metadata only: report kind, company, validated range and filter, format, row count, person and session, and time. Report contents never enter the audit.
3. Exported material is Confidential. Printed and PDF copies carry "Confidential / محرمانه". CSV file names carry only the report kind and dates. A future `.xlsx` carries a header block: Company, Report, Period, Generated at, Confidential.
4. PDF for V1 remains browser Print to PDF, from the existing report pages and print CSS. There is no PDF library and no second reporting engine.

## The one rule: screen read model = export read model

An export is another rendering of the payload the screen already received. It is never a second reporting engine.

- The export reads through the same server functions as the screens: `trialBalanceData`, `accountStatementData`, `safeStatementData` (in `apps/web/src/server/reporting.ts`) and `generalLedgerView` (in `general-ledger.ts`). The screen routes call these same functions.
- It runs under the same session and the same restricted database role. It issues no SQL of its own, takes no wider filter, and computes no total.
- So masking, legal-entity scope and the statement limits apply to an export exactly as they apply to the screen. A refused report has no payload, so it has no export.
- Formatters are pure functions of the payload and the language (`packages/contracts/src/report-export.ts`). They read only the fields the screen shows.

## What is built

### Request and response

`GET /api/v1/finance/report-export?report=<kind>&format=csv&lang=en|fa&<the screen's own query>`

- `report` is `trial-balance`, `general-ledger`, `account-statement` or `safe-statement`. Anything else is refused (422). `format` must be `csv`.
- The remaining query is the one the screen was loaded with. The button builds it from the range the report itself resolved, so the file is the report on the screen even if the form was changed afterwards.
- Response: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="…"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- The file is one in-memory string made for the request. Nothing is written to disk or to the Document Vault, there is no permanent URL, and an aborted download leaves nothing behind.

### Order of work on the server

1. Validate `report`, `format` and `lang`.
2. Build the report through the screen's function. Authentication, permission, company scope, masking and `TOO_MANY_LINES` are decided here, by the report itself.
3. Refuse a table over 5,000 lines (`TOO_MANY_LINES`).
4. Read the company name from the session's own identity, the read `/api/v1/auth/me` makes.
5. Record the audit event (below). If this fails, nothing is exported.
6. Format and answer.

A refused, oversized or failed export never reaches step 5, so it records no successful-export event.

### File contents

- **Encoding:** UTF-8 with one byte-order mark, lines ending in CRLF.
- **Header block:** Company, Report, Account (statements only), Period, Currency, Generated at, and "Confidential / محرمانه". Then one empty line, then the table.
- **A statement names its account or Safe inside the file**, as the screen's heading does. The file name never does.
- **Columns are fixed** and the same in English and Dari. Headings and labels follow the reader's language. Dates are ISO Gregorian days and amounts are plain decimals in both, so the file stays machine-readable.
- **Rows:** every row the screen lists, in the screen's order, plus the opening, closing and total rows the screen shows around them. Totals are the payload's own figures.
- **File name:** `<report>_<from>_<to>.csv`, for example `safe-statement_2026-01-01_2026-11-08.csv`. Nothing else.

### Exact money

The formatter is not a calculator. An amount is written as the decimal string PostgreSQL returned, character for character, as a bare number. Nothing passes through a JavaScript number. A value that is not an exact decimal is never written as a number; it becomes quoted text.

### Formula injection

A text cell is written as quoted text. If it could start a formula, an apostrophe is put in front and nothing is removed. That covers text starting with `=`, `+`, `-` or `@`, their full-width forms and the Unicode minus, also when spaces, tabs, line breaks, or invisible direction and zero-width marks come first, and any cell starting with a tab or line break. Negative amounts are numbers and are not prefixed. Opened in Excel, a defused cell shows its apostrophe; that is the accepted cost.

### Row limits

- The Account Statement and Safe / Saraf Statement refuse more than 5,000 lines in PostgreSQL. The export calls those functions, so it gets the same refusal.
- The General Ledger pages on screen and has no limit of its own. The export applies the same 5,000-line limit to the whole filtered range, from the first page's totals, before reading further pages.
- The General Ledger's totals and pages are separate reads. After reading every page, the export checks that the number of lines equals the totals' count. If something was posted in between, it refuses (409, "try again") and writes nothing.

### Authorization

The export adds no permission and removes none.

| Reader | Screen | Export |
| --- | --- | --- |
| Finance report reader | All four reports | The same four |
| Reader without source-module permissions or scope | Amounts kept; references, source and counterparty withheld | The same masked rows |
| Safe reader | Safe / Saraf statements | The same |
| Person responsible for a Safe, with no report permission | That Safe's statement only (0057) | That Safe's statement only |
| Another company | Not found | Not found, no file |
| Signed out | 401 | 401, no file |

### Audit (migration 0068)

`abos.finance_report_export_record` writes one `FINANCE_REPORT_EXPORTED` row to the append-only audit table.

- It accepts only: report kind, format, language, range mode, from, to, period, financial year, account, include-zero and row count. Each comes from a closed list or is checked for shape. There is no free-text field, so report contents, names, balances and references cannot enter the audit.
- The company, the person and the session come from the session, never from the request.
- It requires the same authority as the report. For a Safe statement that includes the person responsible for that Safe; authority is checked before existence, so someone without access gets the same refusal for a real and an unknown id.
- An account or period in the filter must belong to the session's own company.
- The function is `SECURITY DEFINER` with a pinned search path, owned by the operational Finance owner, not executable by `PUBLIC`. It creates no journal and changes no financial row.

### Print and PDF

- PDF is the browser's Print to PDF from the report page. There is no PDF library.
- Every printable report prints a header: company, report, period, currency, print time and "Confidential / محرمانه", in English or in Dari right to left.
- Every printed page of the application carries a "Confidential / محرمانه" footer.
- Navigation, filters, the export button and action buttons are not printed.

## Known limits

- Excel shows a defused cell with its apostrophe, and shows a quoted code such as `0100` without its leading zero. Native `.xlsx` text cells would fix both.
- The export audit function uses the operational Finance session check. The General Ledger screen uses an older check with the same permission. A session that passes one and not the other would be refused the export, never given more.
- If the audit is recorded and the download is then interrupted, the audit shows an export that did not fully arrive.

## Tests

- **Unit** (`packages/contracts/src/report-export.test.ts`): formula cases, exact money, a decode-and-compare round trip, Dari and English column parity, the byte-order mark, file names, masking, and the 4,999 / 5,000 / 5,001 boundary.
- **Database** (`packages/e1-integration/src/report-export-audit.test.ts`): metadata-only audit, refused shapes, unauthorized readers, the Safe's responsible person, another company, a restricted reader's masked file, the 5,000-line boundary with real postings, and an audit row that cannot be changed. *Not yet run.*
- **Browser, mocked** (`apps/web/tests/v1-report-export.spec.ts`): the button and its wording, the query it sends, a refusal shown and not downloaded, and the print header in English and Dari.
- **Browser, database-backed** (`apps/web/tests/v1-operational-finance.spec.ts`, section 15): each downloaded file is compared byte for byte with the screen's own response passed through the formatter, for a full reader and a restricted reader, with headers, refusals and audit rows checked. *Not yet run.*

## Later

1. Native `.xlsx`, after V1, per `V1_XLSX_DEPENDENCY_REVIEW.md`. It needs a migration so the audit accepts `XLSX`.
2. A server-made PDF only if browser print proves insufficient. It would render the existing print view; it would not be a second report.
3. Other reports (income statement, balance sheet, financial summary, shareholder statement) can join through the same layer: one table builder each, no new read path.
