// @ts-check
// <ui-preview>: shows an app made in the browser, in a frame. See ui-preview.html.

/** A made app's name: it is shown from /apps/<name>/, served from the person's data folder (sw/routes/made.js). */
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

export default class UiPreview extends HTMLElement {
  /** @type {HTMLTemplateElement | undefined} */
  static template;
  static observedAttributes = ["app", "revision", "label"];
  #shown = "";

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      const template = /** @type {typeof UiPreview} */ (this.constructor).template;
      if (template) root.append(document.importNode(template.content, true));
    }
    this.#show();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) this.#show();
  }

  #show() {
    const root = this.shadowRoot;
    const frame = root?.querySelector("iframe");
    const none = /** @type {HTMLElement | null | undefined} */ (root?.querySelector(".none"));
    const link = root?.querySelector("a");
    const where = root?.querySelector(".where");
    if (!frame || !none || !link || !where) return;
    const name = this.getAttribute("app") ?? "";
    const ok = NAME.test(name);
    const src = `/apps/${name}/`;
    frame.hidden = !ok;
    none.hidden = ok;
    link.hidden = !ok;
    where.textContent = ok ? src : "";
    frame.title = this.getAttribute("label") ?? "A preview of the app";
    if (!ok) {
      this.#shown = "";
      frame.removeAttribute("src");
      return;
    }
    link.href = src;
    // A new revision opens it again; the same one leaves it as it is, with what the person typed in it.
    const key = `${src}#${this.getAttribute("revision") ?? ""}`;
    if (key === this.#shown) return;
    this.#shown = key;
    const url = new URL(src, location.href);
    url.searchParams.set("preview", this.getAttribute("revision") ?? "0");
    frame.src = url.pathname + url.search;
  }
}
