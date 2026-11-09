// @ts-check
// ui-panel: see ui-panel.html for what it does and its attributes.
//
// The element only opens and closes the panel. What the panel shows is up to
// the plugin that drew it (std/customize.js is one).

export default class UiPanel extends HTMLElement {
  static observedAttributes = ["label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-panel.html */
  static template;

  /** @type {((e: PointerEvent) => void) | undefined} closes the panel on a click outside it */
  outside;

  connectedCallback() {
    if (this.outside) document.addEventListener("pointerdown", this.outside);
    if (this.shadowRoot) return;
    const template = /** @type {typeof UiPanel} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open" });
    root.append(document.importNode(template.content, true));
    const panel = /** @type {HTMLElement} */ (root.querySelector("#panel"));
    const launch = /** @type {HTMLElement} */ (root.querySelector(".launch"));
    launch.onclick = () => panel.togglePopover();
    /** @type {HTMLElement} */ (root.querySelector(".close")).onclick = () => panel.hidePopover();
    // A manual popover, not an auto one: a review card the panel's actions bring up sits above it, and
    // answering one mustn't close the panel. So the panel closes itself on Escape and on a click outside
    // it, unless that click is in something else open above the page (a review card, another panel).
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.matches(":popover-open")) panel.hidePopover();
    });
    this.outside = (/** @type {PointerEvent} */ e) => {
      if (!panel.matches(":popover-open")) return;
      const path = e.composedPath();
      const box = panel.getBoundingClientRect();
      // A click on the backdrop is a click on the panel, outside its box.
      const onBackdrop = e.target === this && path[0] === panel && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom);
      if (onBackdrop) return panel.hidePopover();
      if (path.includes(panel) || path.includes(launch)) return;
      if (path.some((el) => el instanceof HTMLElement && el.matches(":popover-open, dialog[open]"))) return;
      panel.hidePopover();
    };
    document.addEventListener("pointerdown", this.outside);
    panel.addEventListener("toggle", (e) => {
      const open = /** @type {ToggleEvent} */ (e).newState === "open";
      launch.setAttribute("aria-expanded", String(open));
      const action = this.getAttribute("toggle");
      if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, detail: { action, value: open } }));
      if (!open) launch.focus();
    });
    // A button inside with data-close closes the panel as it does its action (one that starts something on the page).
    this.addEventListener("click", (e) => {
      const button = /** @type {Element} */ (e.target).closest("[data-close]");
      if (button && this.contains(button)) panel.hidePopover();
    });
    this.attributeChangedCallback();
  }

  disconnectedCallback() {
    if (this.outside) document.removeEventListener("pointerdown", this.outside);
  }

  attributeChangedCallback() {
    const root = this.shadowRoot;
    if (!root) return;
    const label = this.getAttribute("label") || "Open";
    /** @type {HTMLElement} */ (root.querySelector(".launch")).textContent = label;
    /** @type {HTMLElement} */ (root.querySelector("#title")).textContent = label;
  }
}
