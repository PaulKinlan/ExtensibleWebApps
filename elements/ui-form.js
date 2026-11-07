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
    const typed = this.draftFor === identity ? this.values() : undefined;
    this.draftFor = identity;

    const props = this.schema.properties ?? {};
    const required = new Set(this.schema.required ?? []);
    // Lists and objects have no form control yet; they are left out and keep their saved values.
    const editable = (/** @type {Schema} */ s) => s.type !== "array" && s.type !== "object";
    const names = (list(this.getAttribute("fields")) ?? Object.keys(props)).filter((n) => props[n] && editable(props[n]));
    const current = editing ? this.state.records?.find((r) => r.id === editing) : undefined;

    const fields = names.map((name) => {
      // A field the person cleared stays cleared.
      const value = typed && Object.hasOwn(typed, name) ? typed[name] : (current?.[name] ?? props[name].default);
      return field(name, props[name], value, required.has(name), this.errors[name]);
    });

    const submit = h("button", { type: "submit" }, this.getAttribute("submit") ?? (editing ? "Save" : "Add"));
    submit.disabled = this.busy;
    const message = h("span", { class: this.errors._ ? "error" : "status", role: "status" }, this.errors._ ?? this.status);
    const form = h("form", { novalidate: "" }, h("div", { class: "fields" }, ...fields), h("div", { class: "actions" }, message, submit));
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.submit(form);
    };

    const focused = this.root.activeElement?.getAttribute("name");
    this.show(form);
    if (focused) /** @type {HTMLElement | null} */ (this.root.querySelector(`[name="${CSS.escape(focused)}"]`))?.focus();
  }

  /** What the form holds now, typed by the schema; undefined before it is drawn. */
  values(form = this.root.querySelector("form")) {
    if (!form) return undefined;
    const props = this.schema.properties ?? {};
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const el of /** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */ (form.querySelectorAll("[name]"))) {
      const s = props[el.name];
      if (el instanceof HTMLInputElement && el.type === "checkbox") out[el.name] = el.checked;
      else if (s?.type === "number" || s?.type === "integer") out[el.name] = el.value === "" ? undefined : Number(el.value);
      else if (el instanceof HTMLInputElement && el.type === "datetime-local") out[el.name] = el.value === "" ? undefined : fromLocalInput(el.value);
      else out[el.name] = el.value === "" ? undefined : el.value;
    }
    return out;
  }

  async submit(/** @type {HTMLFormElement} */ form) {
    const fields = { ...this.values(form) };
    const editing = this.getAttribute("record") ?? undefined;
    const current = editing ? this.state?.records?.find((r) => r.id === editing) : undefined;
    this.busy = true;
    this.errors = {};
    this.status = "Saving…";
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
      for (const e of result.errors ?? []) this.errors[e.path.split(".")[0] || "_"] = e.message;
      if (result.error) this.errors._ = result.error;
      this.status = "";
      this.draw();
    }
  }
}

/** One labelled control for a field, chosen from its schema. */
function field(/** @type {string} */ name, /** @type {Schema} */ s, /** @type {unknown} */ value, /** @type {boolean} */ required, /** @type {string | undefined} */ error) {
  const id = `f-${name}`;
  const errorText = error ? [h("span", { class: "error", id: `${id}-error` }, error)] : [];
  /** @type {Record<string, string | undefined>} */
  const common = { id, name, "aria-invalid": error ? "true" : undefined, "aria-describedby": error ? `${id}-error` : undefined, required: required ? "" : undefined };
  const text = value === undefined || value === null ? "" : String(value);

  if (s.type === "boolean") {
    const box = h("input", { ...common, type: "checkbox", required: undefined });
    box.checked = Boolean(value);
    return h("label", { class: "check" }, box, label(s, name), ...errorText);
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
  return h("label", { for: id, class: control.localName === "textarea" ? "wide" : undefined }, label(s, name) + (required ? " *" : ""), control, ...errorText);
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
