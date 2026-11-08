// @ts-check
// <ui-diagram>: draws its text content as a Mermaid diagram. See ui-diagram.html.

import { draw } from "./mermaid.js";

export default class UiDiagram extends HTMLElement {
  /** @type {HTMLTemplateElement | undefined} */
  static template;
  static observedAttributes = ["label"];
  #drawn = "";
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
    if (!figure || !text.trim() || text === this.#drawn) return;
    this.#drawn = text;
    void draw(text, figure, this.getAttribute("label") ?? "");
  }
}
