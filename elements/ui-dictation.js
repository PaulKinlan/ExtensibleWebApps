// @ts-check
// ui-dictation: see ui-dictation.html for what it does and its attributes.
//
// The browser's SpeechRecognition (webkitSpeechRecognition in Chrome and
// Safari) runs here, in the page, because a plugin's worker has none. What it
// hears goes back as `ui-action` events, which the host passes to the plugin
// whose view the element is in, like a click.

/** How often what it has heard so far of a phrase is sent, at most. */
const INTERIM_MS = 250;

/** @returns {any} the browser's speech recognition class, if it has one */
const Recognition = () => /** @type {any} */ (window).SpeechRecognition ?? /** @type {any} */ (window).webkitSpeechRecognition;

export default class UiDictation extends HTMLElement {
  static observedAttributes = ["label", "lang"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-dictation.html */
  static template;

  /** @type {any} the recognition while it listens */
  #listening;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #interimTimer;
  #interim = "";

  connectedCallback() {
    if (this.shadowRoot) return this.#draw();
    const template = /** @type {typeof UiDictation} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    root.append(document.importNode(template.content, true));
    /** @type {HTMLButtonElement} */ (root.querySelector("button")).onclick = () => (this.#listening ? this.stop() : this.start());
    this.#draw();
  }

  disconnectedCallback() {
    // A redraw that moves the element keeps it listening; one that takes it out stops it.
    queueMicrotask(() => {
      if (!this.isConnected) this.stop();
    });
  }

  attributeChangedCallback() {
    this.#draw();
  }

  #draw() {
    const button = /** @type {HTMLButtonElement | null | undefined} */ (this.shadowRoot?.querySelector("button"));
    if (!button) return;
    const label = /** @type {HTMLElement} */ (button.querySelector(".label"));
    label.textContent = this.#listening ? "Listening…" : (this.getAttribute("label") ?? "Dictate");
    button.setAttribute("aria-pressed", String(!!this.#listening));
    const supported = !!Recognition();
    button.disabled = !supported;
    button.title = supported ? (this.#listening ? "Press to stop dictating" : "Press, then speak: what you say goes in at the cursor") : "This browser has no speech recognition";
  }

  /** @param {unknown} value */
  #send(value) {
    const action = this.getAttribute("action");
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value } }));
  }

  start() {
    const Class = Recognition();
    if (!Class || this.#listening) return;
    const recognition = new Class();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.getAttribute("lang") || document.documentElement.lang || navigator.language;
    recognition.onstart = () => this.#send({ listening: true });
    recognition.onresult = (/** @type {any} */ event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = String(result[0]?.transcript ?? "");
        if (result.isFinal) {
          clearTimeout(this.#interimTimer);
          this.#interimTimer = undefined;
          this.#interim = "";
          if (text.trim()) this.#send({ text, final: true });
        } else {
          this.#interim = text;
          this.#interimTimer ??= setTimeout(() => {
            this.#interimTimer = undefined;
            if (this.#interim) this.#send({ text: this.#interim, final: false });
          }, INTERIM_MS);
        }
      }
    };
    /** @type {string | undefined} */
    let error;
    recognition.onerror = (/** @type {any} */ event) => (error = String(event.error ?? "error"));
    recognition.onend = () => {
      if (this.#listening !== recognition) return;
      this.#listening = undefined;
      clearTimeout(this.#interimTimer);
      this.#interimTimer = undefined;
      this.#draw();
      this.#send(error ? { listening: false, error } : { listening: false });
    };
    this.#listening = recognition;
    this.#draw();
    try {
      recognition.start();
    } catch (e) {
      this.#listening = undefined;
      this.#draw();
      this.#send({ listening: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  stop() {
    const recognition = this.#listening;
    if (!recognition) return;
    // onend sends { listening: false } once the browser has stopped, with the last phrase sent before it.
    recognition.stop();
  }
}
