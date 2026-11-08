// @ts-check
// ui-commands: see ui-commands.html for what it does and its attributes.
//
// The element only shows, searches and picks, and catches keys. Which
// commands there are, and what running one does, is up to the plugin that
// drew it (std/commands/palette.js): picking one sends the `run` action with
// the command's name, as a button's data-action would.

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** @typedef {{ name: string, title: string, keys: string[], group: string, description: string }} Command */

/** "Mod+Shift+K" as its modifiers and key. Mod is Cmd on a Mac and Ctrl elsewhere. */
function parse(/** @type {string} */ combo) {
  const parts = combo.split(/\+(?!$)/);
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => (m === "Mod" ? (MAC ? "Meta" : "Ctrl") : m)));
  return { mods, key };
}

/** Whether a key press is a shortcut. Letters match whatever the layout or Alt turns them into, by the key's position. */
function matches(/** @type {string} */ combo, /** @type {KeyboardEvent} */ e) {
  const { mods, key } = parse(combo);
  if (e.ctrlKey !== mods.has("Ctrl") || e.metaKey !== mods.has("Meta") || e.altKey !== mods.has("Alt")) return false;
  const symbol = key.length === 1 && !/[a-z0-9]/i.test(key);
  // "?" is typed with Shift on most keyboards: a symbol's own Shift doesn't count against it.
  if (!symbol && e.shiftKey !== mods.has("Shift")) return false;
  if (symbol) return e.key === key;
  if (key === "Space") return e.key === " ";
  if (key.length > 1) return e.key === key;
  const byPosition = /^(?:Key|Digit)(.)$/.exec(e.code)?.[1];
  return e.key.toLowerCase() === key.toLowerCase() || byPosition === key.toUpperCase();
}

/** A shortcut as this computer writes it: ⌘⇧K on a Mac, Ctrl+Shift+K elsewhere. */
function show(/** @type {string} */ combo) {
  const { mods, key } = parse(combo);
  const name = key.length === 1 ? key.toUpperCase() : { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" }[key] ?? key;
  const order = ["Ctrl", "Alt", "Shift", "Meta"].filter((m) => mods.has(m));
  if (MAC) return order.map((m) => ({ Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" })[m]).join("") + name;
  return [...order.map((m) => (m === "Meta" ? "Win" : m)), name].join("+");
}

/** Typing in a field: a shortcut with no Ctrl, Cmd or Alt is text there, not a command. */
function typing(/** @type {KeyboardEvent} */ e) {
  const el = /** @type {HTMLElement | undefined} */ (e.composedPath()[0]);
  return !!el && (el.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ""));
}

/** data-keys is a JSON list, since a shortcut may itself be a comma: ["Mod+,"]. */
function keysOf(/** @type {string | null} */ value) {
  try {
    const keys = JSON.parse(value || "[]");
    return Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k) : [];
  } catch {
    return [];
  }
}

export default class UiCommands extends HTMLElement {
  static observedAttributes = ["label", "open-keys", "message-at"];
  /** @type {HTMLTemplateElement | undefined} set by the host from ui-commands.html */
  static template;

  /** @type {Command[]} */
  commands = [];
  /** @type {Command[]} the ones the search shows, in order */
  shown = [];
  selected = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  toastTimer;

  connectedCallback() {
    document.addEventListener("keydown", this.onKey);
    if (this.shadowRoot) return;
    const template = /** @type {typeof UiCommands} */ (this.constructor).template;
    if (!template) return;
    const root = this.attachShadow({ mode: "open" });
    root.append(document.importNode(template.content, true));
    const dialog = this.dialog;
    const input = this.input;

    this.$(".open").onclick = () => this.openPalette();
    input.addEventListener("input", () => {
      this.selected = 0;
      this.draw();
    });
    input.addEventListener("keydown", (e) => {
      const last = this.shown.length - 1;
      if (e.key === "ArrowDown") this.selected = this.selected >= last ? 0 : this.selected + 1;
      else if (e.key === "ArrowUp") this.selected = this.selected <= 0 ? last : this.selected - 1;
      else if (e.key === "Home" && e.ctrlKey) this.selected = 0;
      else if (e.key === "End" && e.ctrlKey) this.selected = last;
      else if (e.key === "Enter") {
        e.preventDefault();
        const command = this.shown[this.selected];
        if (command) this.run(command.name);
        return;
      } else return;
      e.preventDefault();
      this.mark();
    });
    this.list.addEventListener("click", (e) => {
      const option = /** @type {HTMLElement} */ (e.target).closest("[role=option]");
      if (option) this.run(option.getAttribute("data-name") ?? "");
    });
    // A click on the backdrop (outside the box) closes it.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    // The commands are the element's children: read them again whenever the plugin redraws.
    new MutationObserver(() => this.read()).observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
    this.read();
    this.attributeChangedCallback("label");
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.onKey);
  }

  attributeChangedCallback(/** @type {string} */ name) {
    const root = this.shadowRoot;
    if (!root) return;
    if (name === "message-at") return this.toast(this.getAttribute("message") ?? "");
    const label = this.getAttribute("label") || "Commands";
    this.$(".label").textContent = label;
    this.dialog.setAttribute("aria-label", label);
    this.input.setAttribute("aria-label", label);
    this.$(".hint").textContent = show(this.openKeys);
  }

  /** @param {string} selector */
  $(selector) {
    return /** @type {HTMLElement} */ (this.shadowRoot?.querySelector(selector));
  }
  get dialog() {
    return /** @type {HTMLDialogElement} */ (this.$("dialog"));
  }
  get input() {
    return /** @type {HTMLInputElement} */ (this.$("input"));
  }
  get list() {
    return this.$("#list");
  }
  get openKeys() {
    return this.getAttribute("open-keys") || "Mod+K";
  }

  /** The commands, from the buttons inside. */
  read() {
    this.commands = [...this.querySelectorAll("[data-command]")].map((el) => ({
      name: el.getAttribute("data-command") ?? "",
      title: el.textContent?.trim() || el.getAttribute("data-command") || "",
      keys: keysOf(el.getAttribute("data-keys")),
      group: el.getAttribute("data-group") ?? "",
      description: el.getAttribute("data-description") ?? "",
    }));
    if (this.dialog?.open) this.draw();
  }

  /** Shortcuts work anywhere on the page, except a bare key while the person types in a field. */
  onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (matches(this.openKeys, e) && !(plain && typing(e) && !this.dialog?.open)) {
      e.preventDefault();
      if (this.dialog.open) this.dialog.close();
      else this.openPalette();
      return;
    }
    if (this.dialog?.open || (plain && typing(e))) return;
    const command = this.commands.find((c) => c.keys.some((k) => matches(k, e)));
    if (!command) return;
    e.preventDefault();
    this.run(command.name);
  };

  openPalette() {
    const dialog = this.dialog;
    if (!dialog || dialog.open) return;
    this.input.value = "";
    this.selected = 0;
    this.draw();
    dialog.showModal();
    this.input.focus();
  }

  /** Lists the commands that match what is typed: every word somewhere in its title, group, description or name. */
  draw() {
    const words = this.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const text = (/** @type {Command} */ c) => `${c.title} ${c.group} ${c.description} ${c.name}`.toLowerCase();
    const hits = this.commands.filter((c) => words.every((w) => text(c).includes(w)));
    // With a search, titles that start with it come first; without one, the plugin's order (by group) stays.
    const first = words.join(" ");
    this.shown = first ? hits.sort((a, b) => Number(b.title.toLowerCase().startsWith(first)) - Number(a.title.toLowerCase().startsWith(first))) : hits;
    this.selected = Math.min(this.selected, Math.max(0, this.shown.length - 1));

    /** @type {HTMLLIElement[]} */
    const items = [];
    /** @type {string | null} */
    let group = null;
    this.shown.forEach((c, i) => {
      if (!first && c.group !== group) {
        group = c.group;
        if (group) items.push(Object.assign(document.createElement("li"), { className: "group", role: "presentation", textContent: group }));
      }
      const li = document.createElement("li");
      li.id = `option-${i}`;
      li.setAttribute("role", "option");
      li.dataset.name = c.name;
      const what = Object.assign(document.createElement("span"), { className: "what" });
      what.append(Object.assign(document.createElement("span"), { className: "title", textContent: c.title }));
      if (c.description) what.append(Object.assign(document.createElement("span"), { className: "about", textContent: c.description }));
      const keys = Object.assign(document.createElement("span"), { className: "keys" });
      for (const k of c.keys) keys.append(Object.assign(document.createElement("kbd"), { textContent: show(k) }));
      li.append(what, keys);
      items.push(li);
    });
    this.list.replaceChildren(...items);
    this.$(".empty").hidden = this.shown.length > 0;
    this.mark();
  }

  /** Marks the selected option, for the eye and for screen readers, and keeps it in view. */
  mark() {
    const options = this.list.querySelectorAll("[role=option]");
    options.forEach((o, i) => o.setAttribute("aria-selected", String(i === this.selected)));
    const current = options[this.selected];
    if (current) {
      this.input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else this.input.removeAttribute("aria-activedescendant");
  }

  /** Closes the palette and tells the plugin which command to run. */
  run(/** @type {string} */ name) {
    if (!name) return;
    if (this.dialog?.open) this.dialog.close();
    const action = this.getAttribute("run");
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, detail: { action, value: name } }));
  }

  toast(/** @type {string} */ text) {
    const toast = this.$(".toast");
    if (!toast) return;
    clearTimeout(this.toastTimer);
    toast.textContent = text;
    if (!text) return toast.hidePopover();
    // Shown again, so it is on top of anything opened since.
    if (toast.matches(":popover-open")) toast.hidePopover();
    toast.showPopover();
    this.toastTimer = setTimeout(() => toast.hidePopover(), 4000);
  }
}
