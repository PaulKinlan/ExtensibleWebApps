// @ts-check
// ui-debug: see ui-debug.html for what it does and its attributes.
//
// The element only opens and closes the panel and copies text. What the
// panel shows, and what counts as a problem, is up to the plugin that drew
// it (std/debug-console.js is one), so a different debug plugin can reuse it.

export default class UiDebug extends HTMLElement {
  static observedAttributes = ["problems", "label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-debug.html */
  static template;

  open = false;
  /** Whether a log shown inside should keep its newest line in view: true until the person scrolls up. */
  stick = true;

  connectedCallback() {
    if (this.shadowRoot) return;
    const template = /** @type {typeof UiDebug} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open" });
    root.append(document.importNode(template.content, true));
    const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (root.querySelector(selector));

    $(".bug").onclick = () => this.toggle(!this.open);
    $(".close").onclick = () => this.toggle(false);
    this.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.open) {
        this.toggle(false);
        $(".bug").focus();
      }
    });
    // Copy buttons are in the view, not the shadow root: data-copy names what to copy.
    this.addEventListener("click", (e) => {
      const button = /** @type {Element} */ (e.target).closest("[data-copy]");
      if (button && this.contains(button)) void this.copy(button.getAttribute("data-copy") ?? "");
    });
    // `scroll` doesn't bubble, but a capturing listener here still hears a log inside scrolling.
    this.addEventListener("scroll", (e) => {
      const el = /** @type {HTMLElement} */ (e.target);
      this.stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    }, true);
    new MutationObserver(() => this.follow()).observe(this, { childList: true, subtree: true, characterData: true });
    this.attributeChangedCallback();
  }

  attributeChangedCallback() {
    const root = this.shadowRoot;
    if (!root) return;
    const problems = Number(this.getAttribute("problems") ?? 0) || 0;
    const label = this.getAttribute("label") || "Debug console";
    const bug = /** @type {HTMLElement} */ (root.querySelector(".bug"));
    bug.classList.toggle("problems", problems > 0);
    bug.setAttribute("aria-label", problems ? `${label}: ${problems} problem${problems === 1 ? "" : "s"}` : label);
    bug.title = bug.getAttribute("aria-label") ?? label;
    /** @type {HTMLElement} */ (root.querySelector(".count")).textContent = problems ? String(problems > 99 ? "99+" : problems) : "";
    /** @type {HTMLElement} */ (root.querySelector("#title")).textContent = label;
    /** @type {HTMLElement} */ (root.querySelector("#panel")).setAttribute("aria-label", label);
  }

  /** Opens or closes the panel, and tells the plugin so it only draws the log while someone is looking. */
  toggle(/** @type {boolean} */ open) {
    const root = this.shadowRoot;
    if (!root || open === this.open) return;
    this.open = open;
    this.stick = true;
    const panel = /** @type {HTMLElement} */ (root.querySelector("#panel"));
    if (open) panel.showPopover();
    else panel.hidePopover();
    root.querySelector(".bug")?.setAttribute("aria-expanded", String(open));
    const action = this.getAttribute("toggle");
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, detail: { action, value: open } }));
  }

  /** Keeps each log's newest line in view as lines arrive, unless the person scrolled up to read. */
  follow() {
    if (!this.open || !this.stick) return;
    for (const el of this.querySelectorAll("[data-copy-source]")) el.scrollTop = el.scrollHeight;
  }

  /** Copies the text of `[data-copy-source=name]`, headed with where and when it came from. */
  async copy(/** @type {string} */ name) {
    const source = [...this.querySelectorAll("[data-copy-source]")].find((el) => el.getAttribute("data-copy-source") === name);
    const body = source?.textContent?.trim() ?? "";
    const text = [`${document.title} · ${location.href}`, `${navigator.userAgent}`, `Copied ${new Date().toISOString()}`, "", body, ""].join("\n");
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // No clipboard permission (or not a secure page): fall back to a selection and the old copy command.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0";
      this.shadowRoot?.append(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    }
    const status = this.shadowRoot?.querySelector("#status");
    if (!status) return;
    const lines = body ? body.split("\n").length : 0;
    status.textContent = copied ? `Copied ${lines} line${lines === 1 ? "" : "s"}` : "Couldn't copy: select the text and copy it yourself";
    setTimeout(() => (status.textContent = ""), 2500);
  }
}
