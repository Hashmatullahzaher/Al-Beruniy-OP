# V1 native `.xlsx` export: dependency review

**Date:** 2026-11-10. **Status:** review only. Nothing was installed, and no `.xlsx` code exists. CSV is the V1 export (see `V1_REPORT_EXPORT_DESIGN.md`).

**Recommendation:** build native `.xlsx` **after V1**, on its own slice, with **`write-excel-file` pinned to an exact version**. If that package fails its adoption checks, the fallback is a small in-house writer over `fflate`, not a larger library. No candidate should be added before the CSV export has passed its release gate.

## What the export needs from a library

The export layer already produces one table per report from the screen's payload (`packages/contracts/src/report-export.ts`). An `.xlsx` formatter is one more renderer of that table. It needs to:

- write one sheet with a header block and a table, on the server, with no network access;
- write text as text, so nothing a person typed can run as a formula;
- write amounts as numbers only when that loses nothing, and never compute a total;
- support Dari text and a right-to-left sheet;
- handle at most 5,000 lines, the limit the reports already enforce.

It does not need to read spreadsheets, evaluate formulas, draw charts or stream very large files. Every feature beyond the list is attack surface the export would carry for nothing.

## Candidates

Facts are from the npm registry and the OSV advisory database on 2026-11-10.

| | `write-excel-file` | `exceljs` | `xlsx` (SheetJS, npm) | `hucre` | `xlsx-populate` | `excel4node` |
| --- | --- | --- | --- | --- | --- | --- |
| Version | 4.1.1 | 4.4.0 | 0.18.5 | 1.3.0 | 1.21.0 | 1.8.2 |
| Last release | June 2026 | October 2023 | March 2022 | October 2026 | March 2020 | May 2023 |
| First published | 2021 | 2014 | 2013 | March 2026 | 2015 | 2014 |
| Licence | MIT | MIT | Apache-2.0 | MIT | MIT | MIT |
| Direct dependencies | 1 (`fflate`) | 9 | 7 | 0 | 4 (incl. `lodash`, `jszip`) | 11 |
| Unpacked size | 1.8 MB (four builds of the same code) | 21.8 MB | 7.5 MB | 2.9 MB | 15.1 MB | 1.1 MB |
| Weekly downloads | 2.6 million | 27 million | 15.8 million | 0.12 million | 0.29 million | 0.14 million |
| Open advisories on the package | none | none current (one from 2018, fixed in 1.6.0) | **two unfixed on npm** (prototype pollution, ReDoS) | none | none | none |
| Advisories in its dependencies | `fflate`: one, in unzip only, fixed in 0.8.3 | `tmp` (3), `unzipper` (1), `jszip` (2), `fast-csv` (1), `uuid` (1) | none listed | none | `lodash` (10), `jszip` (2) | `jszip` (2) |
| Scope | write only | read and write, streaming | read and write, many formats | read and write, several formats | read and write | write only |

## Assessment

### `write-excel-file` (preferred)

- **Maintenance:** 105 releases since 2021, the latest in June 2026. One maintainer, hosted on GitLab.
- **Supply chain:** one dependency, `fflate` (MIT, no dependencies, 155 million weekly downloads). The `fflate` advisory is an infinite loop in `unzipSync` on a malformed archive; the export never unzips, and 0.8.3 fixes it.
- **No eval, no network:** I read all 84 source modules of 4.1.1 from the package CDN and searched for `eval(`, `new Function`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `process.env` and imports of `http`, `https`, `net`, `dns`, `dgram` and `child_process`. There were no matches.
- **Server use:** a dedicated `write-excel-file/node` entry point, Node 18 or later, with TypeScript types. It returns a buffer or a stream. The sheet is built in memory, which is fine under the 5,000-line limit.
- **Cells:** typed `String`, `Number`, `Date` and `Boolean` cells, number and date formats, column widths, alignment, bold, borders and fills. The `@` format declares a cell as text.
- **Right to left:** a `rightToLeft` sheet option, which writes `rightToLeft="1"` in the sheet view. Strings are UTF-8 shared strings, so Dari needs nothing special.
- **Formula safety:** a string written as a `String` cell is stored as a shared string and cannot run. The library also has a `'Formula'` cell type; the export must never use it.
- **Limits found:**
  - A `Number` cell accepts only a JavaScript number and writes `String(value)`. That is a binary double, as every numeric Excel cell is. See *Exact money* below.
  - No workbook properties (title, author). The owner's header block is rows in the sheet, so this is not needed.

### `exceljs` (not recommended)

It can do everything needed, but it is much more than needed: reading, streaming, images, nine direct dependencies and 21.8 MB. Its last release was in October 2023, and five of its dependencies have advisories, among them `tmp` and `unzipper`, which the export would never call but would still ship.

### `xlsx` (SheetJS) from npm (rejected)

The npm package stopped at 0.18.5 in March 2022. Two advisories against it (prototype pollution and ReDoS) are fixed only in builds published on the vendor's own server, outside the npm registry. A pinned, public repository cannot take a dependency from there. `xlsx-js-style` is a 2022 fork of the same code and inherits the problem.

### `hucre` (too young)

No dependencies and active, but first published in March 2026, with 14 releases and one maintainer. It reads and writes several formats, which is more surface than a writer. Worth another look in a year.

### `xlsx-populate` and `excel4node` (not recommended)

Their last releases were in March 2020 and May 2023, and both pull `jszip` and `lodash`-family packages with known advisories.

## Fallback: a small in-house writer

If `write-excel-file` fails an adoption check, the fallback is not a bigger library. One sheet of text and number cells is five small XML files in a ZIP. A writer for exactly the export table is about 200 lines over `fflate` alone, with the same tests as the CSV formatter. It costs more to write and to keep correct in Excel, LibreOffice and Numbers, so it is the fallback, not the first choice.

## Exact money

Excel stores every numeric cell as a binary double with 15 significant digits. No library can change that. A native numeric cell is therefore exact for the amounts this system holds in practice, but not for every decimal PostgreSQL can return. The `.xlsx` formatter must apply this rule, which keeps the exporter a formatter and never a calculator:

- write an amount as a `Number` cell only if the decimal string has at most 15 significant digits and converts back to the same string at its own scale;
- otherwise write it as a text cell with the `@` format, exactly as the payload gave it;
- give numeric cells a number format with the payload's scale, so `0.10` shows as `0.10`;
- write no formulas and no computed totals: totals are the payload's own figures.

## Adoption checks, before any install

1. Pin `write-excel-file` and `fflate` to exact versions in the lockfile (`fflate` 0.8.3 or later).
2. Repeat the source scan for `eval`, `new Function` and network use on the pinned version, from the installed files.
3. Confirm the Next.js server bundle includes only the `node` entry point, and measure the bundle change.
4. Tests, mirroring the CSV ones: formula text stays text; amounts follow the *Exact money* rule; Dari text round-trips; the sheet is right to left for Dari; the header block holds Company, Report, Period, Generated at and Confidential; a restricted reader's file equals their masked screen; the 5,000-line limit holds; every export is audited (the 0068 function already accepts only `CSV`, so it needs a new migration to accept `XLSX`).
5. Open the file in Excel and LibreOffice, in English and Dari.

## V1 or after V1

**After V1.** CSV with a byte-order mark already opens in Excel with correct Dari and exact figures. Native `.xlsx` improves presentation (column widths, number formats, text cells that keep leading zeros, a right-to-left sheet). It does not add data. It does add a dependency and a migration. It should follow the CSV release, not hold it.

## Risks to accept if adopted

| Risk | Size | Mitigation |
| --- | --- | --- |
| One maintainer | Medium | Exact pin; the in-house writer is a ready fallback; the export layer keeps formatters separate, so swapping one touches one file. |
| Hosted on GitLab, published to npm | Low | Verify the npm tarball against the tagged source when pinning. |
| Numeric cells are doubles | Inherent to the format | The *Exact money* rule above. |
| A future version adds network or eval | Low | The scan in step 2 runs again on every version change. |
