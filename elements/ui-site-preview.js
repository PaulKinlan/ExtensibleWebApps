// @ts-check
// ui-site-preview: see ui-site-preview.html for what it does and its attributes.
//
// It first asks the server for its front page (no-cors: only whether it
// answers matters), then shows the address in the frame. Chrome's Local
// Network Access asks the person before a site on the web can reach their
// device; `targetAddressSpace` says that is what the request is for.

/** True for an http(s) address on this device. @param {URL} url */
const onDevice = (url) => /^https?:$/.test(url.protocol) && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]");

export default class UiSitePreview extends HTMLElement {
  static observedAttributes = ["address", "revision", "label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-site-preview.html */
  static template;
  /** What was last checked: the address and revision, so a redraw with the same ones leaves the frame alone. */
  #shown = "";
  /** Counts checks, so an older one finishing late changes nothing. */
  #checks = 0;

  connectedCallback() {
    if (!this.shadowRoot) {
      const template = /** @type {typeof UiSitePreview} */ (this.constructor).template;
      if (!template) return;
      this.attachShadow({ mode: "open" }).append(document.importNode(template.content, true));
    }
    void this.#show();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) void this.#show();
  }

  /** @param {string} state */
  #send(state) {
    const action = this.getAttribute("action");
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value: state } }));
  }

  async #show() {
    const root = this.shadowRoot;
    const frame = root?.querySelector("iframe");
    const none = /** @type {HTMLElement | null | undefined} */ (root?.querySelector(".none"));
    const link = root?.querySelector("a");
    const where = root?.querySelector(".where");
    const dot = /** @type {HTMLElement | null | undefined} */ (root?.querySelector(".dot"));
    if (!frame || !none || !link || !where || !dot) return;
    frame.title = this.getAttribute("label") ?? "A page from a server on this device";
    /** @type {URL | undefined} */
    let url;
    try {
      url = new URL(this.getAttribute("address") ?? "");
    } catch {}
    const key = `${url?.href ?? ""}#${this.getAttribute("revision") ?? ""}`;
    if (key === this.#shown) return;
    this.#shown = key;
    const check = ++this.#checks;
    where.textContent = url?.href ?? "";
    if (!url || !onDevice(url)) {
      frame.hidden = link.hidden = true;
      frame.removeAttribute("src");
      none.hidden = false;
      none.textContent = "Only a server on this device (localhost) can be shown here.";
      dot.dataset.state = "down";
      return;
    }
    dot.dataset.state = "checking";
    /** @type {string} */
    let state;
    try {
      /** @type {RequestInit & { targetAddressSpace?: string }} */
      const init = { mode: "no-cors", cache: "no-store", credentials: "omit", targetAddressSpace: "loopback" };
      await fetch(url.origin, init);
      state = "up";
    } catch {
      state = (await permission()) === "denied" ? "blocked" : "down";
    }
    if (check !== this.#checks) return;
    dot.dataset.state = state;
    const up = state === "up";
    frame.hidden = link.hidden = !up;
    none.hidden = up;
    none.textContent = up ? "" : state === "blocked" ? "This browser doesn't let the site reach your device." : `Nothing answered at ${url.origin}.`;
    if (up) {
      link.href = url.href;
      // A new revision loads it again, so a saved change shows even without the server's live reload.
      const shown = new URL(url.href);
      if (this.getAttribute("revision")) shown.searchParams.set("preview", this.getAttribute("revision") ?? "");
      frame.src = shown.href;
    } else frame.removeAttribute("src");
    this.#send(state);
  }
}

/** Whether the person let this site reach their device (Chrome's Local Network Access); "prompt" if the browser can't say. */
async function permission() {
  try {
    return (await navigator.permissions.query(/** @type {any} */ ({ name: "loopback-network" }))).state;
  } catch {
    return "prompt";
  }
}
