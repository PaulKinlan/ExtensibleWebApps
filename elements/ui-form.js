// @ts-check
// ui-form: see ui-form.html for what it does and its attributes.

import { BoundElement, h, label, list } from "./bound-element.js";

/** @typedef {{ collection: string, label?: string }} XRef */
/** @typedef {import("./bound-element.js").Row} Row */
/** @typedef {import("./bound-element.js").Schema & { "x-ref"?: XRef, items?: Schema, properties?: Record<string, Schema> }} Schema */
/** @typedef {import("./bound-element.js").Bound & { refs?: Record<string, Row[] | null> }} BoundWithRefs */

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

    const props = /** @type {Record<string, Schema>} */ (this.schema.properties ?? {});
    const refs = /** @type {BoundWithRefs | undefined} */ (this.state)?.refs;
    const required = new Set(this.schema.required ?? []);
    // A field the form can't edit (a list nested too deep) is left out, and keeps its saved value.
    const names = (list(this.getAttribute("fields")) ?? Object.keys(props)).filter((n) => props[n] && editable(props[n]));
    const current = editing ? this.state.records?.find((r) => r.id === editing) : undefined;

    /** @type {Set<string>} the paths the form shows, so errors for anything else go at the bottom */
    const shown = new Set();
    /** @type {Values} what each field was drawn from; reading the form merges into it, so keys the form doesn't show are kept */
    const drawn = Object.create(null);
    /** @type {Context} */
    const ctx = { errors: this.errors, shown, refs, edit: (change) => this.edit(change) };
    const fields = names.map((name) => {
      // A field the person cleared stays cleared.
      const value = typed && Object.hasOwn(typed, name) ? typed[name] : (current?.[name] ?? initial(props[name]));
      drawn[name] = value;
      return field(name, name, props[name], value, required.has(name), ctx, 0);
    });
    this.drawn = drawn;

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

    const name = this.root.activeElement?.getAttribute("name");
    const focus = this.focusNext ?? (name ? `[name="${CSS.escape(name)}"]` : undefined);
    this.focusNext = undefined;
    this.show(form);
    if (focus) /** @type {HTMLElement | null} */ (this.root.querySelector(focus))?.focus();
  }

  /** @type {Values | undefined} values to draw next instead of the form's, after an item is added or removed */
  edited;
  /** @type {string | undefined} a selector for the control to focus after the next draw */
  focusNext;
  /** @type {Values} what the fields were last drawn from */
  drawn = Object.create(null);

  /** Changes the values the form holds (adding or removing an item), and redraws. `focus` is a selector for what to focus after. */
  edit(/** @type {(values: Values) => string | undefined} */ change) {
    const values = this.values() ?? {};
    this.focusNext = change(values);
    this.edited = values;
    this.draw();
  }

  /**
   * What the form holds now, typed by the schema; undefined before it is drawn.
   * For saving, blank new items are left out of lists and an unfilled group is
   * left out; `renames` then maps each saved list item's path to the row it
   * came from, so the kernel's errors can be shown in the right row.
   */
  values(form = this.root.querySelector("form"), { saving = false, renames = new Map() } = {}) {
    if (!form) return undefined;
    const props = this.schema.properties ?? {};
    /** @type {Values} */
    const out = Object.create(null);
    /** @type {Reader} */
    const reader = { form, saving, renames };
    for (const [name, s] of Object.entries(props)) {
      if (!editable(s) || !form.querySelector(`[data-path="${CSS.escape(name)}"], [name="${CSS.escape(name)}"]`)) continue;
      out[name] = read(reader, name, name, s, this.drawn[name], 0);
    }
    return out;
  }

  async submit(/** @type {HTMLFormElement} */ form) {
    /** @type {Map<string, string>} */
    const renames = new Map();
    const fields = { ...this.values(form, { saving: true, renames }) };
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
      // Errors arrive by path (ingredients[0].item), and show beside that control, in the row it came from.
      for (const e of result.errors ?? []) this.errors[e.path ? translate(e.path, renames) : "_"] = e.message;
      if (result.error) this.errors._ = result.error;
      this.status = "";
      this.draw();
    }
  }
}

/** @typedef {Record<string, unknown>} Values */
/** @typedef {{ errors: Record<string, string>, shown: Set<string>, refs?: Record<string, Row[] | null>, edit: (change: (values: Values) => string | undefined) => void }} Context */
/** @typedef {{ form: HTMLFormElement, saving: boolean, renames: Map<string, string> }} Reader */

/** Rows added with Add and not yet touched: left out when saving. */
const fresh = new WeakSet();

/**
 * Whether the form can edit a value of this schema: plain values, groups,
 * and lists, two levels deep (a list of ingredients, each with an amount, a
 * unit and an item). A group's fields are checked one by one, so a field
 * nested too deep is left out on its own and keeps its saved value.
 * @returns {boolean}
 */
function editable(/** @type {Schema} */ s, depth = 0) {
  if (s.type === "array") return depth < 2 && !!s.items && editable(s.items, depth + 1);
  if (s.type === "object") return depth < 2;
  return true;
}

/** What a new value starts as: the schema's default, and a group's fields' defaults. */
function initial(/** @type {Schema} */ s) {
  if (s.default !== undefined) return structuredClone(s.default);
  if (s.type !== "object") return undefined;
  /** @type {Values} */
  const out = {};
  for (const [name, child] of Object.entries(s.properties ?? {})) {
    const value = initial(child);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const isGroup = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The value at `path` in the form, typed by its schema, merged into `base`
 * (what it was drawn from). `saved` is its path in what is saved, which
 * differs from `path` once blank rows before it are left out.
 * @returns {unknown}
 */
function read(/** @type {Reader} */ r, /** @type {string} */ path, /** @type {string} */ saved, /** @type {Schema} */ s, /** @type {unknown} */ base, /** @type {number} */ depth) {
  if (s.type === "array") {
    const holder = r.form.querySelector(`[data-path="${CSS.escape(path)}"]`);
    const count = Number(holder?.getAttribute("data-count") ?? 0);
    const items = [];
    for (let i = 0; i < count; i++) {
      const before = Array.isArray(base) ? base[i] : undefined;
      const item = read(r, `${path}[${i}]`, `${saved}[${items.length}]`, /** @type {Schema} */ (s.items), before, depth + 1);
      if (r.saving && (item === undefined || (fresh.has(/** @type {object} */ (before)) && untouched(item, /** @type {Schema} */ (s.items))))) continue;
      if (r.saving) r.renames.set(`${saved}[${items.length}]`, `${path}[${i}]`);
      items.push(item);
    }
    return items;
  }
  if (s.type === "object") {
    /** @type {Values} */
    const out = Object.assign(Object.create(null), isGroup(base) ? base : {});
    for (const [name, child] of Object.entries(s.properties ?? {})) {
      if (!editable(child, depth + 1)) continue; // drawn without it; its saved value stays in `out`
      out[name] = read(r, `${path}.${name}`, `${saved}.${name}`, child, isGroup(base) ? /** @type {Values} */ (base)[name] : undefined, depth + 1);
    }
    if (fresh.has(/** @type {object} */ (base))) fresh.add(out);
    // A group with nothing filled in is left out when saving, so an optional group stays optional.
    if (r.saving && Object.values(out).every((v) => v === undefined)) return undefined;
    return out;
  }
  const el = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */ (r.form.querySelector(`[name="${CSS.escape(path)}"]`));
  if (!el) return base;
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
  if (el.value === "") return undefined;
  if (s.type === "number" || s.type === "integer") return Number(el.value);
  if (el instanceof HTMLInputElement && el.type === "datetime-local") return fromLocalInput(el.value);
  return el.value;
}

/** A new row still as Add made it: nothing typed beyond the defaults, and no box ticked. */
function untouched(/** @type {unknown} */ item, /** @type {Schema} */ s) {
  const plain = (/** @type {unknown} */ v) => JSON.stringify(v, (_, x) => (x === false ? undefined : x));
  return plain(item) === plain(initial(s));
}

/** An error's path in what was saved, as the path of the row it came from. */
function translate(/** @type {string} */ path, /** @type {Map<string, string>} */ renames) {
  let best = "";
  for (const saved of renames.keys()) {
    const next = path.charAt(saved.length);
    if (saved.length > best.length && path.startsWith(saved) && (next === "" || next === "." || next === "[")) best = saved;
  }
  return best ? /** @type {string} */ (renames.get(best)) + path.slice(best.length) : path;
}

/** The value at `path` ("ingredients[2]"), for adding or removing items. */
function at(/** @type {Values} */ values, /** @type {string} */ path) {
  /** @type {any} */
  let node = values;
  for (const part of path.match(/[^.[\]]+/g) ?? []) node = node?.[part];
  return node;
}

/** Sets the value at `path`, making the objects on the way. */
function set(/** @type {Values} */ values, /** @type {string} */ path, /** @type {unknown} */ value) {
  const parts = path.match(/[^.[\]]+/g) ?? [];
  /** @type {any} */
  let node = values;
  for (const part of parts.slice(0, -1)) node = node[part] ??= Object.create(null);
  node[/** @type {string} */ (parts.at(-1))] = value;
}

/** A selector for the first control in a row, or another element by its data attribute. */
const first = (/** @type {string} */ row) => `[data-row="${CSS.escape(row)}"] :is(input, select, textarea)`;

/**
 * A list: one row per item, each with a Remove button, and an Add button.
 * After Add, the new row's first control has focus; after Remove, the next
 * row's, or the previous row's, or the Add button.
 * @returns {HTMLElement}
 */
function listField(/** @type {string} */ path, /** @type {string} */ name, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {Context} */ ctx, /** @type {number} */ depth) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = /** @type {Schema} */ (s.items);
  const title = label(s, name);
  const addButton = `[data-add="${CSS.escape(path)}"]`;
  const rows = items.map((/** @type {unknown} */ item, /** @type {number} */ i) => {
    const itemPath = `${path}[${i}]`;
    const remove = h("button", { type: "button", class: "remove", "aria-label": `Remove ${title.toLowerCase()} ${i + 1}` }, "Remove");
    remove.onclick = () =>
      ctx.edit((values) => {
        const list = at(values, path);
        list?.splice(i, 1);
        const left = Array.isArray(list) ? list.length : 0;
        return left > i ? first(`${path}[${i}]`) : left > 0 ? first(`${path}[${left - 1}]`) : addButton;
      });
    /** @type {HTMLElement} */
    const control = itemSchema.type === "object"
      ? group(itemPath, itemSchema, item, ctx, depth + 1)
      : field(itemPath, `${title} ${i + 1}`, itemSchema, item, false, ctx, depth + 1, { hideLabel: true });
    return h("li", { "data-row": itemPath }, control, remove);
  });
  const add = h("button", { type: "button", class: "add", "data-add": path }, `Add ${itemSchema.title?.toLowerCase() ?? "one"}`);
  add.onclick = () =>
    ctx.edit((values) => {
      const list = at(values, path);
      const item = initial(itemSchema);
      if (isGroup(item)) fresh.add(/** @type {object} */ (item));
      if (Array.isArray(list)) list.push(item);
      else set(values, path, [item]);
      return first(`${path}[${Array.isArray(list) ? list.length - 1 : 0}]`);
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

/** A group's fields, each from its own schema; a field nested too deep is left out (and kept as saved). */
function group(/** @type {string} */ path, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {Context} */ ctx, /** @type {number} */ depth) {
  const values = /** @type {Values} */ (isGroup(value) ? value : initial(s));
  return h("div", { class: "group" }, ...Object.entries(s.properties ?? {})
    .filter(([, p]) => editable(p, depth + 1))
    .map(([n, p]) => field(`${path}.${n}`, n, p, values[n], (s.required ?? []).includes(n), ctx, depth + 1)));
}

/**
 * One labelled control for a field, chosen from its schema: a list, a group
 * of fields, or a single control. `path` names it in the form (ingredients[0].item).
 * @returns {HTMLElement}
 */
function field(/** @type {string} */ path, /** @type {string} */ name, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {boolean} */ required, /** @type {Context} */ ctx, /** @type {number} */ depth, { hideLabel = false } = {}) {
  if (s.type === "array") return listField(path, name, s, value, ctx, depth);
  if (s.type === "object") {
    ctx.shown.add(path);
    const error = ctx.errors[path];
    return h("fieldset", { class: "wide", "data-path": path }, h("legend", {}, label(s, name)), group(path, s, value, ctx, depth), ...(error ? [h("span", { class: "error" }, error)] : []));
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
  const xref = s["x-ref"];
  const refRows = xref ? ctx.refs?.[xref.collection] : undefined;
  if (xref && Array.isArray(refRows)) {
    const options = refRows.map((r) => h("option", { value: r.id }, String((xref.label ? r[xref.label] : undefined) ?? r.title ?? r.name ?? r.id)));
    if (text && !refRows.some((r) => r.id === text)) options.push(h("option", { value: text }, text));
    control = h("select", common, ...(required ? [] : [h("option", { value: "" }, "")]), ...options);
    control.value = text;
  } else if (s.enum) {
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
