// @ts-check
// <ui-diagram>: draws its text content as a Mermaid diagram. See ui-diagram.html.

import { draw } from "./mermaid.js";

export default class UiDiagram extends HTMLElement {
  /** @type {HTMLTemplateElement | undefined} */
  static template;
  static observedAttributes = ["label"];
  #drawn = "";
  /** Counts draws, so one that a newer draw (or clearing the text) overtook is dropped. */
  #count = 0;
  #observer = new MutationObserver(() => this.#draw());

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      const template = /** @type {typeof UiDiagram} */ (this.constructor).template;
      if (template) root.append(document.importNode(template.content, true));
    }
    this.#observer.observe(this, { childList: true, characterData: true, subtree: true });
    this.#draw();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this.#drawn = "";
      this.#draw();
    }
  }

  #draw() {
    const text = this.textContent ?? "";
    const figure = this.shadowRoot?.querySelector("figure");
    if (!figure || text === this.#drawn) return;
    this.#drawn = text;
    const count = ++this.#count;
    if (!text.trim()) {
      figure.replaceChildren();
      return;
    }
    // Draw off the page, and show it only if nothing newer started meanwhile.
    const next = document.createElement("div");
    void draw(text, next, this.getAttribute("label") ?? "").then(() => {
      if (count === this.#count) figure.replaceChildren(...next.childNodes);
    });
  }
}
