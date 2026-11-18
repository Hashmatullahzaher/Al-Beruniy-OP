/** Reading a report CSV the way a spreadsheet does, for tests that compare a downloaded file with what the screen received. */

const BOM = String.fromCodePoint(0xfeff);

export interface CsvCell {
  /** The cell's text after CSV decoding. */
  readonly text: string;
  /** Whether the cell was written in quotes (text) or bare (a number). */
  readonly quoted: boolean;
}

/** RFC 4180, keeping for every cell whether it was quoted. */
export function parseCsvCells(csv: string): CsvCell[][] {
  const text = csv.startsWith(BOM) ? csv.slice(1) : csv;
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = []; let cell = ""; let quoted = false; let wasQuoted = false; let i = 0;
  const end = () => { row.push({ text: cell, quoted: wasQuoted }); cell = ""; wasQuoted = false; };
  while (i < text.length) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === "\"" && text.charAt(i + 1) === "\"") { cell += "\""; i += 2; continue; }
      if (ch === "\"") { quoted = false; i += 1; continue; }
      cell += ch; i += 1; continue;
    }
    if (ch === "\"") { quoted = true; wasQuoted = true; i += 1; continue; }
    if (ch === ",") { end(); i += 1; continue; }
    if (ch === "\r" && text.charAt(i + 1) === "\n") { end(); rows.push(row); row = []; i += 2; continue; }
    cell += ch; i += 1;
  }
  if (cell !== "" || row.length > 0) { end(); rows.push(row); }
  return rows;
}

/** What a spreadsheet shows for a cell: the constant text formula `="0012"` shows as 0012. */
export function shown(cell: CsvCell): string {
  return cell.quoted && /^="[^"]*"$/.test(cell.text) ? cell.text.slice(2, -1) : cell.text;
}

/** The decoded file: its header block, its heading row and the rows under it, as a spreadsheet shows them. */
export function decodeReportCsv(csv: string): { head: string[][]; headings: string[]; rows: string[][]; cells: CsvCell[][] } {
  const cells = parseCsvCells(csv);
  const gap = cells.findIndex((row) => row.length === 1 && row[0]?.text === "");
  const text = cells.map((row) => row.map(shown));
  return { head: text.slice(0, gap), headings: text[gap + 1] ?? [], rows: text.slice(gap + 2), cells };
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER = /^="[0-9][0-9 ./:_-]*"$/;

/**
 * Every problem a spreadsheet could have with the file: a bare cell that is not an exact decimal, or a text cell that starts like a formula
 * and is neither defused with an apostrophe nor the constant text form of an identifier. An empty list means the file is safe to open.
 */
export function spreadsheetHazards(csv: string): string[] {
  const hazards: string[] = [];
  for (const row of parseCsvCells(csv)) {
    for (const cell of row) {
      if (!cell.quoted && cell.text !== "" && !DECIMAL.test(cell.text)) hazards.push(`bare cell is not a number: ${cell.text}`);
      if (cell.quoted && /^[\s]*[=+\-@]/.test(cell.text) && !IDENTIFIER.test(cell.text)) hazards.push(`text cell could run as a formula: ${cell.text}`);
    }
  }
  return hazards;
}
