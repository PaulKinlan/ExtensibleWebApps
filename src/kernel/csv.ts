// CSV, as spreadsheets and banks write it: a header row, then one row per
// record. Fields may be quoted ("Smith, J"), a quote inside one is doubled
// (""), and a quoted field may run over lines. The separator is a comma, or a
// semicolon or tab when the header uses those instead (as some European
// banks' exports do). A byte order mark at the start is skipped.

/** Splits CSV text into rows of fields. Blank lines are left out. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = [",", ";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), (field = "");
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/**
 * A spreadsheet runs a cell that starts with = + - or @ as a formula, so text
 * like that is written with a ' in front, which spreadsheets hide. Reading
 * takes it off again (`unguard`). Numbers are written as they are.
 */
const FORMULA = /^[=+\-@\t\r]/;
export const unguard = (value: string) => (value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value);

/** One field, quoted when it has to be. */
function field(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of values as CSV text, with a header row, lines ending \r\n as the format asks. */
export function formatCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}
