# V1 report export (PDF and Excel): design record

**Status:** design only (2026-11-08). Nothing in this record is built. Two steps need owner decisions first, listed at the end.

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

## Owner decisions required before building

1. Is CSV acceptable as the first Excel-compatible export, or is native `.xlsx` required from the start?
2. Should each export be recorded as an audit event, and should exported files carry a "Confidential" footer or watermark?
