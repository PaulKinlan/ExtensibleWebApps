// @ts-check
// ui-summarizer: see ui-summarizer.html for what it does and its attributes.
//
// Chrome's Summarizer API runs here, in the page: a plugin's worker has
// none, and the first use may need a click to download the model, which only
// a page can give. The summary goes back as a `ui-action` event, which the
// host passes to the plugin whose view the element is in, like a click.

const KINDS = new Set(["tldr", "teaser", "key-points", "headline"]);
const LENGTHS = new Set(["short", "medium", "long"]);
/** Below this, halving a text the model says is too long would leave too little to summarise. */
const SHORTEST = 2000;

/** @returns {any} the browser's Summarizer, if it has one */
const Summarizer = () => /** @type {any} */ (globalThis).Summarizer;

export default class UiSummarizer extends HTMLElement {
  static observedAttributes = ["label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-summarizer.html */
  static template;

  /** What the button says while it works; empty when idle. */
  #busy = "";

  connectedCallback() {
    if (!this.shadowRoot) {
      const template = /** @type {typeof UiSummarizer} */ (this.constructor).template;
      if (!template) return;
      const root = this.attachShadow({ mode: "open", delegatesFocus: true });
      root.append(document.importNode(template.content, true));
      /** @type {HTMLButtonElement} */ (root.querySelector("button")).onclick = () => void this.draft();
    }
    this.#draw();
  }

  attributeChangedCallback() {
    this.#draw();
  }

  #draw() {
    const button = /** @type {HTMLButtonElement | null | undefined} */ (this.shadowRoot?.querySelector("button"));
    if (!button) return;
    button.classList.toggle("unsupported", !Summarizer());
    button.textContent = this.#busy || this.getAttribute("label") || "Draft";
    button.disabled = !!this.#busy;
    button.setAttribute("aria-busy", String(!!this.#busy));
    button.title = "Write a draft from the text with the browser's on-device summarizer: nothing leaves this device";
  }

  /** @param {string} text */
  #working(text) {
    this.#busy = text;
    this.#draw();
  }

  /** @param {unknown} value */
  #send(value) {
    const action = this.getAttribute("action");
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value } }));
  }

  /** Summarises the element's text and sends the summary (what a click on its button does). */
  async draft() {
    const Class = Summarizer();
    if (this.#busy) return;
    if (!Class) return this.#send({ error: "This browser has no on-device summarizer." });
    let text = (this.textContent ?? "").trim();
    if (!text) return this.#send({ error: "There's nothing to summarise yet." });
    const kind = this.getAttribute("kind") ?? "";
    const length = this.getAttribute("length") ?? "";
    const lang = (this.getAttribute("lang") || document.documentElement.lang || navigator.language || "en").split("-")[0];
    /** @type {any} */
    let summarizer;
    this.#working("Drafting on this device…");
    try {
      summarizer = await Class.create({
        type: KINDS.has(kind) ? kind : "tldr",
        format: "plain-text",
        length: LENGTHS.has(length) ? length : "short",
        expectedInputLanguages: [lang],
        outputLanguage: lang,
        sharedContext: this.getAttribute("context") || undefined,
        monitor: (/** @type {EventTarget} */ m) =>
          m.addEventListener("downloadprogress", (/** @type {any} */ e) => this.#working(`Downloading the model… ${Math.round(Number(e.loaded ?? 0) * 100)}%`)),
      });
      this.#working("Drafting on this device…");
      for (;;) {
        try {
          const summary = String(await summarizer.summarize(text)).trim();
          return this.#send(summary ? { text: summary } : { error: "The summarizer had nothing to say." });
        } catch (e) {
          // Too long for the model: summarise the opening, which carries the argument in most writing.
          if (!(e instanceof DOMException && e.name === "QuotaExceededError") || text.length < SHORTEST) throw e;
          text = text.slice(0, Math.floor(text.length / 2));
        }
      }
    } catch (e) {
      this.#send({ error: describe(e) });
    } finally {
      summarizer?.destroy?.();
      this.#working("");
    }
  }
}

/** A sentence for what went wrong. @param {unknown} e */
function describe(e) {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return "The browser needs a click to download its on-device model. Press the button again.";
    if (e.name === "NotSupportedError") return "The on-device summarizer can't handle this text (it may not support its language).";
  }
  return `The on-device summarizer stopped: ${e instanceof Error ? e.message : String(e)}`;
}
