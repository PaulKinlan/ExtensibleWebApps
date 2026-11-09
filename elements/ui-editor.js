// @ts-check
// ui-editor: see ui-editor.html for what it does and its attributes.
//
// CodeMirror comes from vendor/codemirror/codemirror.js, one prebuilt module
// (scripts/vendor-codemirror.mjs), imported the first time an editor is drawn.
// The element reports what the person does as `ui-action` events, which the
// host passes to the plugin whose view it is in, like a click.

/** @type {Promise<any> | undefined} */
let loading;
const SOURCE = "/vendor/codemirror/codemirror.js";
const codemirror = () => (loading ??= import(SOURCE));

const MAX_TEXT = 1_000_000;
const MAX_FILE = 2_000_000;
const CHANGE_WAIT_MS = 300;
const SELECTION_WAIT_MS = 150;

/** @param {File} file */
const dataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
/** @param {File} file */
const isText = (file) => file.type.startsWith("text/") || /\.(md|markdown|txt|csv|json|toml|ya?ml|html?|css|js)$/i.test(file.name);

/**
 * What a paste or drop carries, as the host's editor events give it (src/host/editing.ts).
 * @param {DataTransfer | null} data
 */
async function transferred(data) {
  // The browser lets the text be read only while the event runs, so it is read before any file is.
  const text = (data?.getData("text/plain") ?? "").slice(0, MAX_TEXT);
  const html = (data?.getData("text/html") ?? "").slice(0, MAX_TEXT);
  const list = [...(data?.files ?? [])].slice(0, 20);
  /** @type {{ name: string, type: string, size: number, text?: string, dataUrl?: string }[]} */
  const files = [];
  for (const file of list) {
    /** @type {(typeof files)[number]} */
    const entry = { name: file.name, type: file.type, size: file.size };
    if (file.size <= MAX_FILE) {
      if (isText(file)) entry.text = await file.text();
      else if (file.type.startsWith("image/")) entry.dataUrl = await dataUrl(file);
    }
    files.push(entry);
  }
  return { text, html, files };
}

/**
 * The browser's spell checker, on (spellcheck="true") or off (anything else, as CodeMirror has it).
 * @param {any} cm @param {string | null} value
 */
const spelling = (cm, value) => cm.EditorView.contentAttributes.of({ spellcheck: value === "true" ? "true" : "false", autocorrect: "off" });

/** The words this page added to the browser's custom dictionary, so a later list can take some away. */
let taught = new Set();

/**
 * Makes the browser's spell check custom dictionary (Chrome 159's document.spellCheckCustomDictionary)
 * hold exactly these words: a JSON list in the `words` attribute. A browser without one ignores it.
 * @param {string | null} value
 */
function teach(value) {
  const dictionary = /** @type {any} */ (document).spellCheckCustomDictionary;
  if (!dictionary || value === null) return;
  /** @type {unknown} */
  let list;
  try {
    list = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const next = new Set(list.filter((w) => typeof w === "string" && w && w.length <= 64 && !/\s/.test(w)).slice(0, 5000));
  const gone = [...taught].filter((w) => !next.has(w));
  const fresh = [...next].filter((w) => !taught.has(w));
  try {
    if (gone.length) dictionary.removeWords(gone);
    if (fresh.length) dictionary.addWords(fresh);
    taught = next;
  } catch {
    // An early version of the API, with other method names: the words just stay marked.
  }
}

/**
 * The smallest edit that turns `a` into `b`: what they share at the start and the end stays, so the
 * selection and undo history around it are kept.
 * @param {string} a @param {string} b
 */
function difference(a, b) {
  let start = 0;
  const shorter = Math.min(a.length, b.length);
  while (start < shorter && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

export default class UiEditor extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = ["document", "revision", "readonly", "label", "select", "annotations", "placeholder", "spellcheck", "words"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-editor.html */
  static template;

  /** @type {ElementInternals} */
  #internals;
  /** @type {any} the CodeMirror EditorView */
  #view;
  /** @type {any} */
  #cm;
  /** @type {any} */
  #compartments;
  /** @type {any} the effect that replaces the annotations */
  #setNotes;
  /** Edits the element makes itself (a new revision), which aren't the person's. */
  #quiet = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #changeTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #selectionTimer;
  #lastSelection = "";
  /** A paste or drop the plugin will put in: the caret goes after it when it arrives. @type {{ head: string, tail: string } | undefined} */
  #expecting;

  constructor() {
    super();
    this.#internals = this.attachInternals();
    // Typing still waiting to be sent goes now when the person leaves the editor (a Save button) or
    // presses a shortcut (Mod+S), so the plugin has it before the action that follows.
    this.addEventListener("focusout", () => this.#flush());
    this.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) this.#flush();
    });
  }

  async connectedCallback() {
    if (this.shadowRoot) return;
    const template = /** @type {typeof UiEditor} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    root.append(document.importNode(template.content, true));
    const cm = (this.#cm = await codemirror());
    const frame = /** @type {HTMLElement} */ (root.querySelector(".frame"));
    this.#compartments = { readonly: new cm.Compartment(), placeholder: new cm.Compartment(), label: new cm.Compartment(), spellcheck: new cm.Compartment() };
    this.#view = new cm.EditorView({
      root,
      parent: frame,
      state: cm.EditorState.create({ doc: this.textContent ?? "", extensions: this.#extensions(cm) }),
    });
    this.#internals.setFormValue(this.value);
    this.#annotate();
    this.#select();
    teach(this.getAttribute("words"));
  }

  disconnectedCallback() {
    // A redraw that moves the element keeps it; one that takes it out for good lets it go.
    queueMicrotask(() => {
      if (this.isConnected || !this.#view) return;
      this.#view.destroy();
      this.#view = undefined;
      this.shadowRoot?.replaceChildren();
    });
  }

  /** @param {any} cm */
  #extensions(cm) {
    const t = cm.tags;
    const style = cm.HighlightStyle.define([
      { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
      { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
      { tag: t.heading3, fontSize: "1.12em", fontWeight: "650" },
      { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
      { tag: t.strong, fontWeight: "700" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
      { tag: t.url, color: "var(--fg-2)" },
      { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
      // Markdown's own marks (#, *, >, backticks) recede, so the words stand out.
      { tag: [t.processingInstruction, t.meta], color: "var(--fg-2)" },
      { tag: t.quote, color: "var(--fg-2)", fontStyle: "italic" },
      { tag: t.contentSeparator, color: "var(--fg-2)" },
    ]);
    // Hugo shortcodes, {{< name >}} and {{% name %}}.
    const shortcodeMatcher = new cm.MatchDecorator({ regexp: /\{\{[<%][\s\S]*?[%>]\}\}/g, decoration: cm.Decoration.mark({ class: "cm-shortcode" }) });
    const shortcodes = cm.ViewPlugin.fromClass(
      class {
        /** @param {any} view */
        constructor(view) {
          this.decorations = shortcodeMatcher.createDeco(view);
        }
        /** @param {any} update */
        update(update) {
          this.decorations = shortcodeMatcher.updateDeco(update, this.decorations);
        }
      },
      { decorations: (/** @type {any} */ v) => v.decorations },
    );
    // The front matter (--- or +++ fences at the very top) is drawn plainly: Markdown would read its last line as a heading.
    const frontMatterMark = cm.Decoration.mark({ class: "cm-frontmatter" });
    const frontMatter = cm.ViewPlugin.fromClass(
      class {
        /** @param {any} view */
        constructor(view) {
          this.decorations = this.find(view);
        }
        /** @param {any} update */
        update(update) {
          if (update.docChanged) this.decorations = this.find(update.view);
        }
        /** @param {any} view */
        find(view) {
          const head = view.state.sliceDoc(0, Math.min(view.state.doc.length, 20000));
          const fence = /^(---|\+\+\+)[ \t]*\n/.exec(head);
          if (!fence) return cm.Decoration.none;
          const close = head.indexOf(`\n${fence[1]}`, fence[0].length - 1);
          if (close < 0) return cm.Decoration.none;
          return cm.Decoration.set([frontMatterMark.range(0, close + 1 + fence[1].length)]);
        }
      },
      { decorations: (/** @type {any} */ v) => v.decorations },
    );
    // Notes a plugin puts on ranges (the annotations attribute). They move with edits until the next set.
    const setNotes = (this.#setNotes = cm.StateEffect.define());
    const notes = cm.StateField.define({
      create: () => cm.Decoration.none,
      /** @param {any} deco @param {any} tr */
      update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const effect of tr.effects) {
          if (!effect.is(setNotes)) continue;
          const length = tr.state.doc.length;
          const ranges = /** @type {{ from: number, to: number, severity?: string, message?: string }[]} */ (effect.value)
            .filter((a) => a.from < a.to && a.to <= length)
            .sort((a, b) => a.from - b.from)
            .map((a) => cm.Decoration.mark({ class: `cm-note cm-note-${a.severity ?? "info"}`, attributes: { title: String(a.message ?? "") } }).range(a.from, a.to));
          deco = cm.Decoration.set(ranges, true);
        }
        return deco;
      },
      provide: (/** @type {any} */ field) => cm.EditorView.decorations.from(field),
    });

    return [
      cm.history(),
      cm.drawSelection(),
      cm.highlightActiveLine(),
      cm.search({ top: true }),
      cm.highlightSelectionMatches(),
      cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap, ...cm.searchKeymap, cm.indentWithTab]),
      cm.markdown({ base: cm.markdownLanguage }),
      cm.syntaxHighlighting(style),
      cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
      cm.EditorView.lineWrapping,
      shortcodes,
      frontMatter,
      notes,
      this.#compartments.readonly.of(cm.EditorState.readOnly.of(this.hasAttribute("readonly"))),
      this.#compartments.placeholder.of(this.getAttribute("placeholder") ? cm.placeholder(this.getAttribute("placeholder")) : []),
      this.#compartments.label.of(cm.EditorView.contentAttributes.of({ "aria-label": this.getAttribute("label") ?? "Text", "aria-multiline": "true" })),
      this.#compartments.spellcheck.of(spelling(cm, this.getAttribute("spellcheck"))),
      cm.EditorView.updateListener.of((/** @type {any} */ update) => this.#updated(update)),
      cm.EditorView.domEventHandlers({
        paste: (/** @type {ClipboardEvent} */ e) => this.#take("paste-action", e, e.clipboardData, null),
        drop: (/** @type {DragEvent} */ e, /** @type {any} */ view) => {
          // Text moved within the editor is CodeMirror's to move.
          if (view.dragging) return false;
          const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
          return this.#take("drop-action", e, e.dataTransfer, at);
        },
      }),
    ];
  }

  /** @param {string} action @param {unknown} value */
  #send(action, value) {
    this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value } }));
  }

  /** Sends the text now if a change is waiting to be sent, so the plugin has it before the event that follows. */
  #flush() {
    if (this.#changeTimer === undefined) return;
    clearTimeout(this.#changeTimer);
    this.#changeTimer = undefined;
    const action = this.getAttribute("action");
    if (action) this.#send(action, this.value);
  }

  /**
   * A paste or drop the plugin asked for: it is sent instead of going in.
   * @param {string} attribute @param {Event} e @param {DataTransfer | null} data @param {number | null} at
   */
  #take(attribute, e, data, at) {
    const action = this.getAttribute(attribute);
    if (!action || !this.#view) return false;
    e.preventDefault();
    this.#flush();
    const main = this.#view.state.selection.main;
    const from = at ?? main.from;
    const to = at ?? main.to;
    const text = this.value;
    this.#expecting = { head: text.slice(0, from), tail: text.slice(to) };
    void transferred(data).then((value) => this.#send(action, { from, to, ...value }));
    return true;
  }

  /** @param {any} update */
  #updated(update) {
    if (update.docChanged) {
      this.#internals.setFormValue(this.value);
      const action = this.getAttribute("action");
      if (action && !this.#quiet) {
        clearTimeout(this.#changeTimer);
        this.#changeTimer = setTimeout(() => {
          this.#changeTimer = undefined;
          this.#send(action, this.value);
        }, CHANGE_WAIT_MS);
      }
    }
    if (update.selectionSet || update.docChanged) {
      const action = this.getAttribute("selection-action");
      if (!action) return;
      clearTimeout(this.#selectionTimer);
      this.#selectionTimer = setTimeout(() => {
        if (!this.#view) return;
        const { from, to } = this.#view.state.selection.main;
        const key = `${from}:${to}`;
        if (key === this.#lastSelection) return;
        this.#lastSelection = key;
        this.#flush();
        this.#send(action, { from, to, text: this.#view.state.sliceDoc(from, to).slice(0, MAX_TEXT) });
      }, SELECTION_WAIT_MS);
    }
  }

  /** @param {string} name @param {string | null} before @param {string | null} after */
  attributeChangedCallback(name, before, after) {
    if (!this.#view || before === after) return;
    const cm = this.#cm;
    // A redraw may set the new revision before it changes the text content, so read it once the redraw is done.
    if (name === "document") queueMicrotask(() => this.#replace());
    else if (name === "revision") queueMicrotask(() => this.#reset());
    else if (name === "select") queueMicrotask(() => this.#select());
    else if (name === "annotations") queueMicrotask(() => this.#annotate());
    else if (name === "readonly") this.#view.dispatch({ effects: this.#compartments.readonly.reconfigure(cm.EditorState.readOnly.of(after !== null)) });
    else if (name === "placeholder") this.#view.dispatch({ effects: this.#compartments.placeholder.reconfigure(after ? cm.placeholder(after) : []) });
    else if (name === "spellcheck") this.#view.dispatch({ effects: this.#compartments.spellcheck.reconfigure(spelling(cm, after)) });
    else if (name === "words") teach(after);
    else if (name === "label") this.#view.dispatch({ effects: this.#compartments.label.reconfigure(cm.EditorView.contentAttributes.of({ "aria-label": after ?? "Text", "aria-multiline": "true" })) });
  }

  /**
   * Another document: its text goes in with a history of its own, so Undo never brings back the last
   * document's text. Typing not yet sent was the last document's, and is dropped.
   */
  #replace() {
    if (!this.#view) return;
    clearTimeout(this.#changeTimer);
    this.#changeTimer = undefined;
    this.#expecting = undefined;
    this.#lastSelection = "";
    this.#quiet = true;
    try {
      this.#view.setState(this.#cm.EditorState.create({ doc: this.textContent ?? "", extensions: this.#extensions(this.#cm) }));
    } finally {
      this.#quiet = false;
    }
    this.#internals.setFormValue(this.value);
    this.#annotate();
  }

  /** The text content goes in, as an edit, so history and the selection are kept. */
  #reset() {
    if (!this.#view) return;
    const next = this.textContent ?? "";
    const now = this.value;
    if (next === now) return;
    const change = difference(now, next);
    /** @type {Record<string, unknown>} */
    const spec = { changes: change };
    // A paste or drop the plugin put in: the caret goes after it, as if the browser had.
    const expecting = this.#expecting;
    this.#expecting = undefined;
    if (expecting && next.startsWith(expecting.head) && next.endsWith(expecting.tail)) {
      const caret = next.length - expecting.tail.length;
      spec.selection = { anchor: caret };
    }
    this.#quiet = true;
    try {
      this.#view.dispatch(spec);
    } finally {
      this.#quiet = false;
    }
  }

  /** Selects the range in `select` ("from,to") and scrolls to it. */
  #select() {
    const value = this.getAttribute("select");
    if (!this.#view || !value) return;
    const [from, to = from] = value.split(",").map((n) => Number(n));
    if (!Number.isFinite(from)) return;
    const max = this.#view.state.doc.length;
    const anchor = Math.max(0, Math.min(from, max));
    const head = Math.max(0, Math.min(Number.isFinite(to) ? to : anchor, max));
    this.#view.dispatch({ selection: { anchor, head }, effects: this.#cm.EditorView.scrollIntoView(anchor, { y: "center" }) });
    this.#view.focus();
  }

  #annotate() {
    if (!this.#view) return;
    let list = [];
    try {
      list = JSON.parse(this.getAttribute("annotations") || "[]");
    } catch {
      list = [];
    }
    this.#view.dispatch({ effects: this.#setNotes.of(Array.isArray(list) ? list.filter((a) => a && Number.isFinite(a.from) && Number.isFinite(a.to)) : []) });
  }

  /** The text, as the person has it now. */
  get value() {
    return this.#view ? this.#view.state.doc.toString() : (this.textContent ?? "");
  }

  set value(text) {
    if (!this.#view) return;
    this.#view.dispatch({ changes: { from: 0, to: this.#view.state.doc.length, insert: String(text) } });
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  focus() {
    this.#view?.focus();
  }
}
