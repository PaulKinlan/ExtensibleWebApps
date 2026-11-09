// Event-handler attributes (onclick=, onload=…) taken out of markup before
// the host parses it. They would never run: the sanitizer (sanitize.ts)
// drops them, and the page's policy (public/_headers) refuses inline
// handlers. But Chromium 158 and later report the policy refusing one as soon
// as any parser in the page sees it, even in an inert <template> or a
// DOMParser document, so a plugin view with onclick= filled the console
// with errors for something that was never going to happen.
//
// This walks the markup the way the HTML tokenizer does (tags, quoted
// values, comments, and the elements whose text isn't markup) and leaves out
// every attribute whose name starts with "on". It only ever removes: if it
// misreads some unusual markup, a handler stays in and the browser reports
// it, as before, and the sanitizer and the policy still stop it.

/** Elements whose content is text, not markup, up to their end tag (outside SVG and MathML). */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\f" || c === "\r";
const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** The markup with every on…= attribute left out. Markup with none is returned as it was. */
export function withoutHandlers(html: string): string {
  // The common case: nothing that could be a handler.
  if (!/\son|\/on|["']on/i.test(html)) return html;
  let out = "";
  let i = 0;
  const n = html.length;
  /** How deep in <svg> or <math> the markup is: their <style> and <title> are elements, not text. */
  let foreign = 0;
  const lower = html.toLowerCase();
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    out += html.slice(i, lt);
    i = lt;
    // A comment: <!-- … -->, also ended by --!>, or at once by <!--> and <!--->.
    if (html.startsWith("<!--", i)) {
      let end: number;
      if (html.startsWith(">", i + 4)) end = i + 5;
      else if (html.startsWith("->", i + 4)) end = i + 6;
      else {
        const a = html.indexOf("-->", i + 4);
        const b = html.indexOf("--!>", i + 4);
        end = a < 0 && b < 0 ? n : b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
      }
      out += html.slice(i, end);
      i = end;
      continue;
    }
    // A doctype, <![CDATA[, or <?…>: up to the next >.
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      const stop = end < 0 ? n : end + 1;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const closing = html[i + 1] === "/";
    const nameAt = closing ? i + 2 : i + 1;
    if (!isLetter(html[nameAt] ?? "")) {
      // A < that starts no tag is text.
      out += "<";
      i++;
      continue;
    }
    // The tag's name: up to a space, / or >.
    let j = nameAt;
    while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
    const name = html.slice(nameAt, j).toLowerCase();
    out += html.slice(i, j);
    // Its attributes, as the tokenizer reads them.
    while (j < n && html[j] !== ">") {
      if (isSpace(html[j]) || html[j] === "/") {
        out += html[j++];
        continue;
      }
      const start = j;
      // A name runs to a space, /, > or = (an = can start one).
      j++;
      while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
      const attribute = html.slice(start, j);
      let k = j;
      while (k < n && isSpace(html[k])) k++;
      if (html[k] === "=") {
        k++;
        while (k < n && isSpace(html[k])) k++;
        const quote = html[k];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, k + 1);
          k = close < 0 ? n : close + 1;
        } else {
          while (k < n && !isSpace(html[k]) && html[k] !== ">") k++;
        }
        j = k;
      }
      if (!/^on/i.test(attribute)) out += html.slice(start, j);
    }
    if (j < n) out += ">";
    i = j + 1;
    if (closing) {
      if ((name === "svg" || name === "math") && foreign > 0) foreign--;
      continue;
    }
    const selfClosed = html[j - 1] === "/";
    if ((name === "svg" || name === "math") && !selfClosed) {
      foreign++;
      continue;
    }
    // The content of <style>, <script> and the like is text up to its end tag.
    if (!foreign && RAW.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const stop = end < 0 ? n : end;
      out += html.slice(i, stop);
      i = stop;
    }
  }
  return i < n ? out + html.slice(i) : out;
}
