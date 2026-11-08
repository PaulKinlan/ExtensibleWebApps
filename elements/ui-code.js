// @ts-check
// ui-code: see ui-code.html for what it does and its attributes.
//
// It is form-associated, so a <form data-action> that holds it sends its
// code like any other field. The text content is the starting code; it is
// read again only when `revision` changes, so a view that redraws while the
// person types doesn't throw their edits away.

export default class UiCode extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = ["revision", "rows", "readonly", "label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-code.html */
  static template;

  /** @type {ElementInternals} */
  #internals;
  /** @type {HTMLTextAreaElement | undefined} */
  #area;
  /** @type {HTMLElement | undefined} */
  #lines;

  constructor() {
    super();
    this.#internals = this.attachInternals();
  }

  connectedCallback() {
    if (this.shadowRoot) return;
    const template = /** @type {typeof UiCode} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    root.append(document.importNode(template.content, true));
    const area = /** @type {HTMLTextAreaElement} */ (root.querySelector("textarea"));
    const lines = /** @type {HTMLElement} */ (root.querySelector(".lines"));
    this.#area = area;
    this.#lines = lines;
    area.addEventListener("input", () => this.#changed());
    area.addEventListener("scroll", () => (lines.scrollTop = area.scrollTop));
    area.addEventListener("keydown", (e) => this.#key(e));
    this.#apply();
    this.#reset();
  }

  attributeChangedCallback(/** @type {string} */ name, /** @type {string | null} */ before, /** @type {string | null} */ after) {
    if (!this.#area) return;
    // A redraw may set the new revision before it changes the text content, so read it once the redraw is done.
    if (name === "revision" && before !== after) queueMicrotask(() => this.#reset());
    else this.#apply();
  }

  /** The code, as the person has it now. */
  get value() {
    return this.#area?.value ?? this.textContent ?? "";
  }

  set value(text) {
    if (!this.#area) return;
    this.#area.value = String(text);
    this.#changed();
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  /** Starts again from the text content. */
  #reset() {
    if (this.#area) this.value = this.textContent ?? "";
  }

  #apply() {
    if (!this.#area) return;
    this.#area.rows = Number(this.getAttribute("rows")) || 20;
    this.#area.readOnly = this.hasAttribute("readonly");
    this.#area.setAttribute("aria-label", this.getAttribute("label") ?? "Code");
  }

  #changed() {
    const area = /** @type {HTMLTextAreaElement} */ (this.#area);
    const count = area.value.split("\n").length;
    /** @type {HTMLElement} */ (this.#lines).textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
    this.#internals.setFormValue(area.value);
  }

  /** Tab and Shift+Tab indent and outdent; Escape then Tab leaves the field, so the keyboard is never trapped. */
  #key(/** @type {KeyboardEvent} */ e) {
    const area = /** @type {HTMLTextAreaElement} */ (this.#area);
    if (e.key === "Escape") {
      this.dataset.escaped = "";
      return;
    }
    if (e.key !== "Tab" || "escaped" in this.dataset || area.readOnly) {
      delete this.dataset.escaped;
      return;
    }
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = area;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    if (!e.shiftKey && start === end) {
      area.setRangeText("  ", start, end, "end");
    } else if (start === end) {
      // Shift+Tab at the caret: take up to two spaces off the start of its line, and keep the caret where it was in the text.
      const removed = /^ {0,2}/.exec(value.slice(lineStart))?.[0].length ?? 0;
      if (!removed) return;
      area.setRangeText("", lineStart, lineStart + removed, "preserve");
      const caret = Math.max(lineStart, start - removed);
      area.setSelectionRange(caret, caret);
    } else {
      // Every line the selection touches.
      const block = value.slice(lineStart, end);
      const changed = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
      area.setRangeText(changed, lineStart, end, "select");
    }
    this.#changed();
  }
}
