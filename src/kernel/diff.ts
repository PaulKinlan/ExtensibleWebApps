// A line diff for change review: the longest common subsequence of lines,
// shown as kept, added and removed lines. Large inputs fall back to
// "remove all, add all" so a review can never stall the kernel.

export type DiffLine = { op: "same" | "add" | "del"; text: string };

const LIMIT = 4_000_000; // cells in the LCS table
/** Most lines a review shows; the rest are summed up in one line, so a huge change can't freeze the page. */
export const SHOWN = 400;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const replaceAll = () => [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  if (!a.length || !b.length || (a.length + 1) * (b.length + 1) > LIMIT) return replaceAll();
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i++] });
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < n) out.push({ op: "del", text: a[i++] });
  while (j < m) out.push({ op: "add", text: b[j++] });
  return out;
}

/** Keeps changed lines and `context` lines around them; runs of unchanged lines become one "…" line. */
export function trim(lines: DiffLine[], context = 2): DiffLine[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "same", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ op: "same", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  if (out.length > SHOWN) {
    const hidden = out.length - SHOWN;
    out.length = SHOWN;
    out.push({ op: "same", text: `… ${hidden} more line${hidden === 1 ? "" : "s"} not shown` });
  }
  // Very long lines are cut too.
  return out.map((line) => (line.text.length > 1000 ? { ...line, text: `${line.text.slice(0, 1000)} …` } : line));
}
