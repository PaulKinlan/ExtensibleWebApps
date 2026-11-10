// @ts-check
// ui-dialog: see ui-dialog.html for what it does and its attributes.

export default class UiDialog extends HTMLElement {
  static observedAttributes = ["open", "label"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-dialog.html */
  static template;

  /** @type {((e: PointerEvent) => void) | undefined} */
  outside;
  /** @type {HTMLElement | null} */
  opener = null;

  connectedCallback() {
    if (this.outside) document.addEventListener("pointerdown", this.outside);
    if (!this.shadowRoot) {
      const template = /** @type {typeof UiDialog} */ (this.constructor).template;
      if (!template) return;
      const root = this.attachShadow({ mode: "open" });
      root.append(document.importNode(template.content, true));
      const dialog = /** @type {HTMLElement} */ (root.querySelector("#dialog"));
      const dismiss = () => {
        const action = this.getAttribute("close");
        if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, detail: { action, value: false } }));
        else this.removeAttribute("open");
      };
      /** @type {HTMLElement} */ (root.querySelector(".close")).onclick = dismiss;
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && dialog.matches(":popover-open")) {
          e.stopPropagation();
          dismiss();
        }
      });
      this.outside = (/** @type {PointerEvent} */ e) => {
        if (!dialog.matches(":popover-open")) return;
        const path = e.composedPath();
        const box = dialog.getBoundingClientRect();
        const onBackdrop = e.target === this && path[0] === dialog && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom);
        if (onBackdrop) return dismiss();
        if (path.includes(dialog)) return;
        if (path.some((el) => el instanceof HTMLElement && el.matches(":popover-open, dialog[open]"))) return;
        dismiss();
      };
      document.addEventListener("pointerdown", this.outside);
      this.addEventListener("click", (e) => {
        const button = /** @type {Element} */ (e.target).closest("[data-close]");
        if (button && this.contains(button)) dismiss();
      });
    }
    this.sync();
  }

  disconnectedCallback() {
    if (this.outside) document.removeEventListener("pointerdown", this.outside);
  }

  attributeChangedCallback() {
    this.sync();
  }

  sync() {
    const root = this.shadowRoot;
    if (!root) return;
    /** @type {HTMLElement} */ (root.querySelector("#title")).textContent = this.getAttribute("label") || "Details";
    const dialog = /** @type {HTMLElement} */ (root.querySelector("#dialog"));
    const shouldOpen = this.hasAttribute("open") && this.getAttribute("open") !== "false";
    const isOpen = dialog.matches(":popover-open");
    if (shouldOpen && !isOpen) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showPopover();
      /** @type {HTMLElement} */ (root.querySelector(".close")).focus();
    } else if (!shouldOpen && isOpen) {
      dialog.hidePopover();
      this.opener?.focus();
      this.opener = null;
    }
  }
}
