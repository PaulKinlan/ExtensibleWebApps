// @ts-check
// ui-form: see ui-form.html for what it does and its attributes.

import { BoundElement, h, label, list } from "./bound-element.js";

/** @typedef {import("./bound-element.js").Schema} Schema */

export default class UiForm extends BoundElement {
  static observedAttributes = ["collection", "fields", "record", "submit", "action"];

  /** @type {Record<string, string>} error messages by field; "_" is for the whole form */
  errors = {};
  status = "";
  busy = false;
  /** @type {string | undefined} which record the typed values belong to; a different one starts from its saved values */
  draftFor;

  reset() {
    this.errors = {};
    this.status = "";
    this.draftFor = undefined;
  }

  draw() {
    if (this.state?.error) return this.show(h("p", { class: "error", role: "alert" }, this.state.error));
    if (!this.state?.schema) return this.show();
    if (!this.state.writable) return this.show(h("p", { class: "error", role: "alert" }, `This plugin can't write ${this.state.title ?? "this collection"}.`));

    const editing = this.getAttribute("record");
    // Keep what the person has typed across redraws, but only for the same record.
    const identity = `${this.getAttribute("collection")}/${editing ?? ""}`;
    if (this.draftFor !== undefined && this.draftFor !== identity) {
      this.errors = {};
      this.status = "";
    }
    const typed = this.edited ?? (this.draftFor === identity ? this.values() : undefined);
    this.edited = undefined;
    this.draftFor = identity;

    const props = this.schema.properties ?? {};
    const required = new Set(this.schema.required ?? []);
    // A field the form can't edit (lists nested too deep) is left out, and keeps its saved value.
    const names = (list(this.getAttribute("fields")) ?? Object.keys(props)).filter((n) => props[n] && editable(props[n]));
    const current = editing ? this.state.records?.find((r) => r.id === editing) : undefined;

    /** @type {Set<string>} the paths the form shows, so errors for anything else go at the bottom */
    const shown = new Set();
    const ctx = { errors: this.errors, shown, edit: (/** @type {(values: Values) => void} */ change) => this.edit(change) };
    const fields = names.map((name) => {
      // A field the person cleared stays cleared.
      const value = typed && Object.hasOwn(typed, name) ? typed[name] : (current?.[name] ?? props[name].default);
      return field(name, name, props[name], value, required.has(name), ctx);
    });

    const submit = h("button", { type: "submit" }, this.getAttribute("submit") ?? (editing ? "Save" : "Add"));
    submit.disabled = this.busy;
    const stray = Object.entries(this.errors).find(([path]) => path !== "_" && !shown.has(path));
    const problem = this.errors._ ?? (stray && stray[1]);
    const message = h("span", { class: problem ? "error" : "status", role: "status" }, problem ?? this.status);
    const form = h("form", { novalidate: "" }, h("div", { class: "fields" }, ...fields), h("div", { class: "actions" }, message, submit));
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.submit(form);
    };

    const focused = this.focusNext ?? this.root.activeElement?.getAttribute("name");
    this.focusNext = undefined;
    this.show(form);
    if (focused) /** @type {HTMLElement | null} */ (this.root.querySelector(`[name="${CSS.escape(focused)}"]`))?.focus();
  }

  /** @type {Values | undefined} values to draw next instead of the form's, after an item is added or removed */
  edited;
  /** @type {string | undefined} the control to focus after the next draw */
  focusNext;

  /** Changes the values the form holds (adding or removing an item), and redraws. */
  edit(/** @type {(values: Values) => void} */ change) {
    const values = this.values() ?? {};
    change(values);
    this.edited = values;
    this.draw();
  }

  /**
   * What the form holds now, typed by the schema; undefined before it is drawn.
   * For saving, empty items are left out of lists.
   */
  values(form = this.root.querySelector("form"), { saving = false } = {}) {
    if (!form) return undefined;
    const props = this.schema.properties ?? {};
    /** @type {Values} */
    const out = Object.create(null);
    for (const [name, s] of Object.entries(props)) {
      if (!editable(s) || !form.querySelector(`[data-path="${CSS.escape(name)}"], [name="${CSS.escape(name)}"]`)) continue;
      out[name] = read(form, name, s, saving);
    }
    return out;
  }

  async submit(/** @type {HTMLFormElement} */ form) {
    const fields = { ...this.values(form, { saving: true }) };
    const editing = this.getAttribute("record") ?? undefined;
    const current = editing ? this.state?.records?.find((r) => r.id === editing) : undefined;
    this.busy = true;
    this.errors = {};
    this.status = "Saving…";
    this.edited = this.values(form);
    this.draw();
    // Fields the form doesn't show keep their values.
    const result = await this.save(editing, { ...current, ...fields });
    this.busy = false;
    if (result.ok) {
      this.status = "Saved";
      // A new record was added: the next draw starts a fresh one from the schema's defaults.
      if (!editing) this.draftFor = undefined;
      this.draw();
      this.act(this.getAttribute("action"), result.recordId);
    } else {
      // Errors arrive by path (ingredients[0].item), and show beside that control.
      for (const e of result.errors ?? []) this.errors[e.path || "_"] = e.message;
      if (result.error) this.errors._ = result.error;
      this.status = "";
      this.draw();
    }
  }
}

/** @typedef {Record<string, unknown>} Values */
/** @typedef {{ errors: Record<string, string>, shown: Set<string>, edit: (change: (values: Values) => void) => void }} Context */

/**
 * Whether the form can edit a value of this schema: plain values, and lists
 * and groups of them, two levels deep (a list of ingredients, each with an
 * amount, a unit and an item).
 */
/** @returns {boolean} */
function editable(/** @type {Schema} */ s, depth = 0) {
  if (s.type === "array") return depth < 2 && !!s.items && editable(s.items, depth + 1);
  if (s.type === "object") return depth < 2 && Object.values(s.properties ?? {}).every((p) => editable(p, depth + 1));
  return true;
}

/**
 * The value at `path` in the form, typed by its schema.
 * @returns {unknown}
 */
function read(/** @type {HTMLFormElement} */ form, /** @type {string} */ path, /** @type {Schema} */ s, /** @type {boolean} */ saving) {
  if (s.type === "array") {
    const holder = form.querySelector(`[data-path="${CSS.escape(path)}"]`);
    const count = Number(holder?.getAttribute("data-count") ?? 0);
    /** @type {unknown[]} */
    const items = Array.from({ length: count }, (_, i) => read(form, `${path}[${i}]`, /** @type {Schema} */ (s.items), saving));
    return saving ? items.filter((item) => !empty(item)) : items;
  }
  if (s.type === "object") {
    /** @type {Values} */
    const out = Object.create(null);
    for (const [name, child] of Object.entries(s.properties ?? {})) out[name] = read(form, `${path}.${name}`, child, saving);
    return out;
  }
  const el = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */ (form.querySelector(`[name="${CSS.escape(path)}"]`));
  if (!el) return undefined;
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
  if (el.value === "") return undefined;
  if (s.type === "number" || s.type === "integer") return Number(el.value);
  if (el instanceof HTMLInputElement && el.type === "datetime-local") return fromLocalInput(el.value);
  return el.value;
}

/** An item the person added but left blank. */
const empty = (/** @type {unknown} */ value) =>
  value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => v === undefined || v === false));

/** The values object at `path` ("ingredients[2]"), for adding or removing items. */
function at(/** @type {Values} */ values, /** @type {string} */ path) {
  /** @type {any} */
  let node = values;
  for (const part of path.match(/[^.[\]]+/g) ?? []) node = node?.[part];
  return node;
}

/**
 * A list: one row per item, each with a Remove button, and an Add button.
 * @returns {HTMLElement}
 */
function listField(/** @type {string} */ path, /** @type {string} */ name, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {Context} */ ctx) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = /** @type {Schema} */ (s.items);
  const title = label(s, name);
  const rows = items.map((/** @type {unknown} */ item, /** @type {number} */ i) => {
    const itemPath = `${path}[${i}]`;
    const remove = h("button", { type: "button", class: "remove", "aria-label": `Remove ${title.toLowerCase()} ${i + 1}` }, "Remove");
    remove.onclick = () => ctx.edit((values) => void at(values, path)?.splice(i, 1));
    /** @type {HTMLElement} */
    const control = itemSchema.type === "object"
      ? h("div", { class: "group" }, ...Object.entries(itemSchema.properties ?? {}).map(([n, p]) => field(`${itemPath}.${n}`, n, p, /** @type {any} */ (item)?.[n], (itemSchema.required ?? []).includes(n), ctx)))
      : field(itemPath, `${title} ${i + 1}`, itemSchema, item, false, ctx, { hideLabel: true });
    return h("li", {}, control, remove);
  });
  const add = h("button", { type: "button", class: "add" }, `Add ${itemSchema.title?.toLowerCase() ?? "one"}`);
  add.onclick = () =>
    ctx.edit((values) => {
      const list = at(values, path);
      const fresh = itemSchema.type === "object" ? Object.create(null) : itemSchema.default;
      if (Array.isArray(list)) list.push(fresh);
      else set(values, path, [fresh]);
    });
  ctx.shown.add(path);
  const error = ctx.errors[path];
  return h("fieldset", { class: "wide", "data-path": path, "data-count": String(items.length) },
    h("legend", {}, title),
    ...(s.description ? [h("small", {}, s.description)] : []),
    h("ol", {}, ...rows),
    h("div", {}, add),
    ...(error ? [h("span", { class: "error" }, error)] : []));
}

/** Sets the value at `path`, making the objects on the way. */
function set(/** @type {Values} */ values, /** @type {string} */ path, /** @type {unknown} */ value) {
  const parts = path.match(/[^.[\]]+/g) ?? [];
  /** @type {any} */
  let node = values;
  for (const part of parts.slice(0, -1)) node = node[part] ??= Object.create(null);
  node[/** @type {string} */ (parts.at(-1))] = value;
}

/**
 * One labelled control for a field, chosen from its schema: a list, a group
 * of fields, or a single control. `path` names it in the form (ingredients[0].item).
 * @returns {HTMLElement}
 */
function field(/** @type {string} */ path, /** @type {string} */ name, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {boolean} */ required, /** @type {Context} */ ctx, { hideLabel = false } = {}) {
  if (s.type === "array") return listField(path, name, s, value, ctx);
  if (s.type === "object") {
    const group = /** @type {Values | undefined} */ (value && typeof value === "object" ? value : undefined);
    ctx.shown.add(path);
    const error = ctx.errors[path];
    return h("fieldset", { class: "wide", "data-path": path },
      h("legend", {}, label(s, name)),
      h("div", { class: "group" }, ...Object.entries(s.properties ?? {}).map(([n, p]) => field(`${path}.${n}`, n, p, group?.[n], (s.required ?? []).includes(n), ctx))),
      ...(error ? [h("span", { class: "error" }, error)] : []));
  }
  ctx.shown.add(path);
  const error = ctx.errors[path];
  const id = `f-${path}`;
  const errorText = error ? [h("span", { class: "error", id: `${id}-error` }, error)] : [];
  /** @type {Record<string, string | undefined>} */
  const common = { id, name: path, "aria-invalid": error ? "true" : undefined, "aria-describedby": error ? `${id}-error` : undefined, required: required ? "" : undefined, "aria-label": hideLabel ? name : undefined };
  const text = value === undefined || value === null ? "" : String(value);

  if (s.type === "boolean") {
    const box = h("input", { ...common, type: "checkbox", required: undefined });
    box.checked = Boolean(value);
    return h("label", { class: "check" }, box, hideLabel ? "" : label(s, name), ...errorText);
  }
  /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */
  let control;
  if (s.enum) {
    control = h("select", common, ...(required ? [] : [h("option", { value: "" }, "")]), ...s.enum.map((o) => h("option", { value: String(o) }, String(o))));
    control.value = text;
  } else if (s.type === "string" && (s["x-multiline"] || (s.maxLength ?? 0) > 200)) {
    control = h("textarea", common);
    control.value = text;
  } else {
    const type = inputType(s);
    control = h("input", { ...common, type, min: s.minimum?.toString(), max: s.maximum?.toString(), step: s.type === "integer" ? "1" : s.type === "number" ? "any" : undefined, maxlength: s.maxLength?.toString() });
    control.value = type === "datetime-local" ? toLocalInput(value) : text;
  }
  const wide = control.localName === "textarea" ? "wide" : undefined;
  if (hideLabel) return h("label", { for: id, class: wide }, control, ...errorText);
  return h("label", { for: id, class: wide }, label(s, name) + (required ? " *" : ""), control, ...errorText);
}

const inputType = (/** @type {Schema} */ s) =>
  s.type === "number" || s.type === "integer" ? "number"
  : s.format === "date" ? "date"
  : s.format === "date-time" ? "datetime-local"
  : s.format === "email" ? "email"
  : s.format === "uri" ? "url"
  : "text";

// `datetime-local` has no time zone: show stored UTC times in local time, and store what is entered as UTC.
const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
function toLocalInput(/** @type {unknown} */ value) {
  const date = typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fromLocalInput(/** @type {string} */ value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
