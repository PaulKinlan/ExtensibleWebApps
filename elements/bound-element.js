// @ts-check
// The base of the elements bound to a collection: ui-table and ui-form.
//
// A bound element acts with the rights of the plugin whose view it sits in.
// It never learns how the host talks to the kernel: it asks the host with
// three DOM events, and the host fills in the event's `detail`:
//
//   ui-owner  {}                              → owner: the plugin that drew it
//   ui-bind   { collection, listener }        → unbind: call to stop listening
//   ui-save   { collection, recordId, fields } → result: a promise of the outcome
//
// So this file, and the elements built on it, import nothing from the host.

/**
 * @typedef {{ type?: string, items?: Schema, title?: string, description?: string, enum?: unknown[], format?: string,
 *   minimum?: number, maximum?: number, maxLength?: number, default?: unknown, properties?: Record<string, Schema>,
 *   required?: string[], "x-multiline"?: boolean }} Schema
 * @typedef {Record<string, unknown> & { id: string }} Row
 * @typedef {{ schema?: Schema, records?: Row[], title?: string, writable?: boolean, error?: string }} Bound
 * @typedef {{ ok: boolean, recordId?: string, error?: string, errors?: { path: string, message: string }[] }} SaveResult
 */

/** Sends `type` to the host and returns the detail it filled in. */
function ask(/** @type {Element} */ el, /** @type {string} */ type, /** @type {Record<string, unknown>} */ detail = {}) {
  el.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  return detail;
}

export class BoundElement extends HTMLElement {
  /** Set by the platform from the element's .html file before it is defined. */
  /** @type {HTMLTemplateElement | undefined} */
  static template;

  static observedAttributes = ["collection"];

  /** @type {Bound | undefined} what the kernel last sent */
  state;
  root = this.attachShadow({ mode: "open" });
  /** @type {(() => void) | undefined} */
  #unbind;
  /** @type {string | undefined} which owner and collection we are bound to */
  #bound;

  connectedCallback() {
    this.#connect();
  }

  disconnectedCallback() {
    this.#unbind?.();
    this.#unbind = undefined;
    this.#bound = undefined;
  }

  attributeChangedCallback(/** @type {string} */ name) {
    if (!this.isConnected) return;
    if (name === "collection") this.#connect();
    else if (this.state) this.draw();
  }

  #connect() {
    const collection = this.getAttribute("collection") ?? "";
    const owner = /** @type {string | undefined} */ (ask(this, "ui-owner").owner);
    if (!owner || this.#bound === `${owner}/${collection}`) return;
    this.#unbind?.();
    // A new binding starts clean: nothing from the last collection (an error, records, a schema) carries over.
    this.state = undefined;
    this.show();
    this.reset();
    this.#bound = `${owner}/${collection}`;
    const listener = (/** @type {Bound} */ message) => {
      this.state = { ...this.state, ...message };
      this.draw();
    };
    this.#unbind = /** @type {(() => void) | undefined} */ (ask(this, "ui-bind", { collection, listener }).unbind);
  }

  /** Saves `fields` as a record, or deletes the record when `fields` is null. */
  save(/** @type {string | undefined} */ recordId, /** @type {Record<string, unknown> | null} */ fields) {
    const collection = this.getAttribute("collection") ?? "";
    const result = ask(this, "ui-save", { collection, recordId, fields }).result;
    return /** @type {Promise<SaveResult>} */ (result ?? Promise.resolve({ ok: false, error: "Not in a plugin's view." }));
  }

  /** @returns {Schema} */
  get schema() {
    return this.state?.schema ?? {};
  }

  /** Replaces what the element shows, keeping the style from its template. */
  show(/** @type {(Node | string)[]} */ ...nodes) {
    const template = /** @type {typeof BoundElement} */ (this.constructor).template;
    const chrome = template ? document.importNode(template.content, true) : "";
    this.root.replaceChildren(chrome, ...nodes);
  }

  /** Tells the plugin, as a click on `data-action` would. */
  act(/** @type {string | null} */ action, /** @type {unknown} */ value) {
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value } }));
  }

  /** Draws from `this.state`. */
  draw() {}

  /** Forgets anything kept for the last binding. */
  reset() {}
}

// ---- Helpers both elements use ----

/** A field's label: the schema's title, or the name made readable. */
export const label = (/** @type {Schema | undefined} */ schema, /** @type {string} */ name) =>
  schema?.title ?? name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** "a, b" → ["a", "b"]; no attribute → undefined. */
export const list = (/** @type {string | null} */ value) =>
  value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

/**
 * Builds an element. Attributes left undefined are skipped.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | undefined>} [attributes]
 * @param {(Node | string)[]} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attributes = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attributes)) if (v !== undefined) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

/**
 * A value as a person reads it, using the schema for dates and numbers.
 * @param {unknown} value
 * @param {Schema | undefined} schema
 * @returns {string}
 */
export function format(value, schema) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => format(v, schema?.items)).join(", ");
  // Whole numbers under 10,000 are often years or counts: no thousands separator.
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 10_000 ? String(value) : value.toLocaleString();
  if (schema?.format === "date" && typeof value === "string") return new Date(`${value}T00:00:00`).toLocaleDateString();
  if (schema?.format === "date-time" && typeof value === "string") return new Date(value).toLocaleString();
  // A group reads as its values in order: { amount: 200, unit: "g", item: "flour" } is "200 g flour".
  if (typeof value === "object") return Object.entries(value).map(([k, v]) => format(v, schema?.properties?.[k])).filter(Boolean).join(" ");
  return String(value);
}
