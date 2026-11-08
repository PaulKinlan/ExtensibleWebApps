// @ts-check
// Markdown to DOM, for <ui-markdown>. The subset GitHub's docs use: headings,
// paragraphs, lists (nested, ordered or not, with task boxes), fenced code,
// tables, quotes, rules, images, links, code spans, bold, italic and
// strikethrough. It builds nodes, never HTML strings: raw HTML in the source
// shows as text, so a Markdown file can't run script or load anything but
// its images.
//
//   import { parse } from "./markdown.js";
//   const fragment = parse(text, { link: (href) => href, image: (src) => src, code: (lang, text) => node });
//
// `link` and `image` turn each address as written into the one to use (or ""
// to drop it); `code` may return its own node for a fenced block (a diagram,
// say), or nothing for the usual <pre><code>.

/**
 * @typedef {{
 *   link?: (href: string) => string,
 *   image?: (src: string) => string,
 *   code?: (lang: string, text: string) => Node | undefined,
 * }} Options
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const COMMENT = /^ {0,3}<!--/;

/** A heading's id, as GitHub makes it: lower case, punctuation dropped, spaces as hyphens. */
/** @param {string} text */
export function slug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * @param {string} text
 * @param {Options} [options]
 * @returns {DocumentFragment}
 */
export function parse(text, options = {}) {
  const used = new Map();
  /** A heading id that's unique on the page: a repeat gets -1, -2, as on GitHub. */
  const unique = (/** @type {string} */ id) => {
    const n = used.get(id) ?? 0;
    used.set(id, n + 1);
    return n ? `${id}-${n}` : id;
  };
  const fragment = document.createDocumentFragment();
  blocks(text.replace(/\r\n?/g, "\n").split("\n"), fragment, { ...options, unique });
  return fragment;
}

/** Whether a line starts a block other than a paragraph, so a paragraph ends before it. */
/** @param {string} line */
function interrupts(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || COMMENT.test(line);
}

/**
 * @param {string[]} lines
 * @param {Node} parent
 * @param {Options & { unique: (id: string) => string }} options
 */
function blocks(lines, parent, options) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${indent}}`), ""));
      i++;
      const lang = fence[2].toLowerCase();
      const code = body.join("\n");
      const custom = options.code?.(lang, code);
      if (custom) parent.appendChild(custom);
      else {
        const pre = el("pre");
        const inner = el("code", code);
        if (lang) inner.className = `language-${lang}`;
        pre.appendChild(inner);
        parent.appendChild(pre);
      }
      continue;
    }

    if (COMMENT.test(line)) {
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const h = el(`h${heading[1].length}`);
      inline(heading[2], h, options);
      h.id = options.unique(slug(h.textContent ?? ""));
      parent.appendChild(h);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      parent.appendChild(el("hr"));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !interrupts(lines[i]))) body.push(lines[i++].replace(QUOTE, ""));
      const quote = el("blockquote");
      blocks(body, quote, options);
      parent.appendChild(quote);
      continue;
    }

    if (ITEM.test(line)) {
      i = list(lines, i, parent, options);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && DELIMITER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      i = table(lines, i, parent, options);
      continue;
    }

    // Leading spaces go; trailing ones stay, since two at the end of a line are a hard break.
    const body = [line.trimStart()];
    i++;
    while (i < lines.length && lines[i].trim() && !interrupts(lines[i])) body.push(lines[i++].trimStart());
    const p = el("p");
    inline(body.join("\n"), p, options);
    parent.appendChild(p);
  }
}

/** A list starting at line `start`: its items, each parsed as blocks of its own. Returns the line after it. */
/** @param {string[]} lines @param {number} start @param {Node} parent @param {Options & { unique: (id: string) => string }} options */
function list(lines, start, parent, options) {
  const first = /** @type {RegExpExecArray} */ (ITEM.exec(lines[start]));
  const ordered = /\d/.test(first[2]);
  const list = el(ordered ? "ol" : "ul");
  if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute("start", String(parseInt(first[2], 10)));
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const marker = ITEM.exec(lines[i]);
    if (!marker || /\d/.test(marker[2]) !== ordered || marker[1].length > first[1].length + 1) break;
    // An item's own lines are indented past its marker; a line indented less, but not blank and not a new block, carries on its paragraph.
    const width = marker[0].length || marker[1].length + marker[2].length + 1;
    const body = [lines[i].slice(marker[0].length)];
    i++;
    let blank = false;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        blank = true;
        body.push("");
        i++;
        continue;
      }
      const indent = /^ */.exec(next)?.[0].length ?? 0;
      if (indent >= width) body.push(next.slice(width));
      else if (!blank && !interrupts(next)) body.push(next.trim());
      else break;
      if (blank) loose = true;
      blank = false;
      i++;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const item = el("li");
    const task = /^\[( |x|X)\]\s+/.exec(body[0] ?? "");
    if (task) {
      const box = /** @type {HTMLInputElement} */ (el("input"));
      box.type = "checkbox";
      box.disabled = true;
      box.checked = task[1] !== " ";
      item.appendChild(box);
      item.appendChild(document.createTextNode(" "));
      body[0] = body[0].slice(task[0].length);
      item.className = "task";
    }
    blocks(body, item, options);
    list.appendChild(item);
    // A blank line between items makes the list loose, which keeps its paragraphs; otherwise items are tight.
    if (i < lines.length && !lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const again = ITEM.exec(lines[j] ?? "");
      if (!again || /\d/.test(again[2]) !== ordered || again[1].length > first[1].length + 1) break;
      loose = true;
      i = j;
    }
  }
  if (!loose) for (const item of list.children) for (const p of [...item.children]) if (p.localName === "p") p.replaceWith(...p.childNodes);
  parent.appendChild(list);
  return i;
}

/** The cells of a table row: split on pipes that aren't escaped or in code. */
/** @param {string} line */
function cells(line) {
  const out = [];
  let cell = "";
  let code = false;
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cell += c;
    } else if (c === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

/** @param {string[]} lines @param {number} start @param {Node} parent @param {Options & { unique: (id: string) => string }} options */
function table(lines, start, parent, options) {
  const head = cells(lines[start]);
  const align = cells(lines[start + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const wrap = el("div");
  wrap.className = "table";
  const t = el("table");
  const row = (/** @type {string[]} */ values, /** @type {string} */ tag) => {
    const tr = el("tr");
    head.forEach((_, n) => {
      const cell = el(tag);
      if (align[n]) cell.style.textAlign = align[n];
      inline(values[n] ?? "", cell, options);
      tr.appendChild(cell);
    });
    return tr;
  };
  const thead = el("thead");
  thead.appendChild(row(head, "th"));
  t.appendChild(thead);
  const tbody = el("tbody");
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) tbody.appendChild(row(cells(lines[i++]), "td"));
  t.appendChild(tbody);
  wrap.appendChild(t);
  parent.appendChild(wrap);
  return i;
}

/**
 * Inline text: code spans, images, links, autolinks, emphasis and line breaks.
 * @param {string} text
 * @param {Node} parent
 * @param {Options} options
 */
function inline(text, parent, options) {
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) parent.appendChild(document.createTextNode(plain));
    plain = "";
  };
  while (i < text.length) {
    const c = text[i];
    const rest = text.slice(i);

    if (c === "\\" && /[\\`*_{}\[\]()#+\-.!|<>~]/.test(text[i + 1] ?? "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`";
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > -1) {
        flush();
        let body = text.slice(i + ticks.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(body)) body = body.slice(1, -1);
        parent.appendChild(el("code", body));
        i = end + ticks.length;
        continue;
      }
    }

    if (c === "!" && text[i + 1] === "[") {
      const link = bracket(text, i + 1);
      if (link) {
        flush();
        const src = options.image ? options.image(link.href) : link.href;
        if (src) {
          const img = /** @type {HTMLImageElement} */ (el("img"));
          img.src = src;
          img.alt = link.label;
          img.loading = "lazy";
          if (link.title) img.title = link.title;
          parent.appendChild(img);
        } else plain += link.label;
        i = link.end;
        continue;
      }
    }

    if (c === "[") {
      const link = bracket(text, i);
      if (link) {
        flush();
        const href = options.link ? options.link(link.href) : link.href;
        const a = el(href ? "a" : "span");
        if (href) {
          a.setAttribute("href", href);
          if (/^https?:/i.test(href) && !href.startsWith(location.origin)) a.setAttribute("rel", "noopener");
        }
        if (link.title) a.title = link.title;
        inline(link.label, a, options);
        parent.appendChild(a);
        i = link.end;
        continue;
      }
    }

    if (c === "<") {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
      if (auto) {
        flush();
        // The same callback as a bracketed link, so an autolink to a page becomes its screen too.
        const href = options.link ? options.link(auto[1]) : auto[1];
        const a = el(href ? "a" : "span", auto[1]);
        if (href) {
          a.setAttribute("href", href);
          if (/^https?:/i.test(href) && !href.startsWith(location.origin)) a.setAttribute("rel", "noopener");
        }
        parent.appendChild(a);
        i += auto[0].length;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const run = new RegExp(`^\\${c}+`).exec(rest)?.[0] ?? c;
      const size = c === "~" ? (run.length >= 2 ? 2 : 0) : Math.min(run.length, 2);
      // Underscores inside a word (snake_case) are text, as on GitHub.
      const inWord = c === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "");
      if (size && !inWord && text[i + size] && !/\s/.test(text[i + size])) {
        const marker = c.repeat(size);
        const end = closing(text, i + size, marker, c);
        if (end > -1) {
          flush();
          const node = el(c === "~" ? "del" : size === 2 ? "strong" : "em");
          inline(text.slice(i + size, end), node, options);
          parent.appendChild(node);
          i = end + size;
          continue;
        }
      }
      plain += run;
      i += run.length;
      continue;
    }

    if (c === "\n") {
      // Two spaces or a backslash at the end of a line break it; otherwise a newline is a space.
      if (/ {2,}$/.test(plain) || plain.endsWith("\\")) {
        plain = plain.replace(/ +$|\\$/, "");
        flush();
        parent.appendChild(el("br"));
      } else plain += "\n";
      i++;
      continue;
    }

    plain += c;
    i++;
  }
  flush();
}

/** Where emphasis opened at `from` closes: the next marker not followed by another of its kind, after text. */
/** @param {string} text @param {number} from @param {string} marker @param {string} c */
function closing(text, from, marker, c) {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > -1) {
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(marker, i) && !/\s/.test(text[i - 1] ?? "") && (marker.length === 2 || text[i + 1] !== c)) {
      if (c !== "_" || !/[\p{L}\p{N}]/u.test(text[i + marker.length] ?? "")) return i;
    }
    i++;
  }
  return -1;
}

/** `[label](href "title")` starting at `at`, with nested brackets in the label. */
/** @param {string} text @param {number} at */
function bracket(text, at) {
  let depth = 0;
  let i = at;
  for (; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > -1) i = end;
      continue;
    }
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) break;
  }
  if (depth !== 0 || text[i + 1] !== "(") return undefined;
  // The address may hold balanced parentheses, as in a Wikipedia link: (https://en.wikipedia.org/wiki/Web_(disambiguation)).
  const target = /^\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+"([^"]*)")?\s*\)/.exec(text.slice(i + 1));
  if (!target) return undefined;
  return { label: text.slice(at + 1, i), href: target[1], title: target[2] ?? "", end: i + 1 + target[0].length };
}

/** @param {string} tag @param {string} [text] */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
