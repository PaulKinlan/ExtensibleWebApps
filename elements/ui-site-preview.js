// @ts-check
// ui-site-preview: see ui-site-preview.html for what it does and its attributes.
//
// It first asks the server for its front page (no-cors: only whether it
// answers matters), then shows the address in the frame. Chrome's Local
// Network Access asks the person before a site on the web can reach their
// device; `targetAddressSpace` says that is what the request is for.

/** How long after a save (the same address, a new revision) one more load is the server's live reload, not the frame going elsewhere. */
const RELOAD_GRACE = 5000;

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
  /** Loads of the frame since it was last pointed at the address. */
  #loads = 0;
  /** When the frame was last pointed again at the same address with a new revision: a save, which a live-reloading server follows with a reload of its own. */
  #savedAt = 0;
  /** The address the frame was last pointed at. */
  #pointed = "";

  connectedCallback() {
    if (!this.shadowRoot) {
      const template = /** @type {typeof UiSitePreview} */ (this.constructor).template;
      if (!template) return;
      const root = this.attachShadow({ mode: "open" });
      root.append(document.importNode(template.content, true));
      /** @type {HTMLIFrameElement} */ (root.querySelector("iframe")).addEventListener("load", () => this.#loaded());
      /** @type {HTMLButtonElement} */ (root.querySelector(".back")).onclick = () => {
        this.#shown = "";
        void this.#show();
      };
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
    const back = /** @type {HTMLElement | null} */ (root?.querySelector(".back") ?? null);
    if (back) back.hidden = true;
    if (!url || !onDevice(url) || url.origin === location.origin) {
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
      this.#loads = 0;
      this.#savedAt = this.#pointed === url.href ? Date.now() : 0;
      this.#pointed = url.href;
      frame.src = shown.href;
    } else frame.removeAttribute("src");
    this.#send(state);
  }

  /**
   * The frame loaded a page. The first load is the address; one more just after a new revision is a
   * live-reloading server catching up with the save. Any other means the frame went somewhere else, which
   * it can't be asked about (its page is another site's), so it is hidden rather than shown under this one.
   */
  #loaded() {
    const frame = this.shadowRoot?.querySelector("iframe");
    const src = frame?.getAttribute("src");
    if (!frame || !src || src === "about:blank") return;
    this.#loads++;
    if (this.#loads === 1 || (this.#loads === 2 && Date.now() - this.#savedAt < RELOAD_GRACE)) return;
    const root = this.shadowRoot;
    const none = /** @type {HTMLElement | null | undefined} */ (root?.querySelector(".none"));
    const back = /** @type {HTMLElement | null | undefined} */ (root?.querySelector(".back"));
    const link = root?.querySelector("a");
    frame.hidden = true;
    // Unloads the other page, which hiding alone would leave running.
    frame.src = "about:blank";
    if (link) link.hidden = true;
    if (none) {
      none.hidden = false;
      none.textContent = "The preview went to another page, so it is hidden: it only shows the address above.";
    }
    if (back) back.hidden = false;
    this.#send("left");
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
