// Components bound to a collection: <ui-table> and <ui-form>. A plugin
// writes one line of HTML and gets a sortable table or a validated form built
// from the collection's schema, kept up to date as the records change. They
// act with the rights of the plugin whose view they sit in.

import { bind, ownerOf, saveRecord, type Bound } from "./bindings";

type Schema = { type?: string; items?: Schema; title?: string; description?: string; enum?: unknown[]; format?: string; minimum?: number; maximum?: number; maxLength?: number; default?: unknown; properties?: Record<string, Schema>; required?: string[]; "x-multiline"?: boolean };
type Row = Record<string, unknown> & { id: string };

const STYLES = `
  :host{display:block;min-width:0}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--border);vertical-align:top}
  th{font-size:var(--text-sm);color:var(--fg-2);font-weight:600;white-space:nowrap}
  th button{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center}
  th button:focus-visible,td button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:1px;border-radius:var(--radius-sm)}
  td.number,th.number{text-align:right}
  tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
  button.link{all:unset;cursor:pointer;color:var(--accent);font-weight:500}
  button.remove{font:inherit;font-size:var(--text-sm);height:24px;padding:0 var(--space-2);border:1px solid var(--border);border-radius:var(--radius);background:none;color:var(--fg-2);cursor:pointer}
  .empty,.status{color:var(--fg-2);font-size:var(--text-sm);padding:var(--space-3) 0}
  .error{color:var(--danger);font-size:var(--text-sm)}
  form{display:flex;flex-direction:column;gap:var(--space-3)}
  .fields{display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))}
  label{display:flex;flex-direction:column;gap:var(--space-1);font-size:var(--text-sm);color:var(--fg-2)}
  label.check{flex-direction:row;align-items:center;gap:var(--space-2);color:var(--fg);font-size:var(--text-md)}
  label.wide{grid-column:1/-1}
  input:not([type=checkbox]),select,textarea{font:inherit;font-size:var(--text-md);color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);min-height:32px;padding:0 var(--space-2)}
  textarea{padding:var(--space-2);min-height:88px;resize:vertical}
  [aria-invalid=true]{border-color:var(--danger)}
  .actions{display:flex;gap:var(--space-2);align-items:center;justify-content:flex-end}
  button[type=submit]{font:inherit;font-weight:500;height:32px;padding:0 var(--space-3);border-radius:var(--radius);border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
  button[type=submit]:disabled{opacity:.6;cursor:progress}
`;

const label = (schema: Schema | undefined, name: string) => schema?.title ?? name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
const list = (value: string | null) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v);
  el.append(...children);
  return el;
};

function format(value: unknown, schema: Schema | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => format(v, schema?.items)).join(", ");
  // Whole numbers under 10,000 are often years or counts: no thousands separator.
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 10_000 ? String(value) : value.toLocaleString();
  if (schema?.format === "date" && typeof value === "string") return new Date(`${value}T00:00:00`).toLocaleDateString();
  if (schema?.format === "date-time" && typeof value === "string") return new Date(value).toLocaleString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Shared by both components: binds when connected (or when `collection` changes), unbinds when removed. */
abstract class BoundElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["collection"];
  }
  protected root = this.attachShadow({ mode: "open" });
  protected state?: Bound;
  private unbind?: () => void;
  private bound?: string;

  connectedCallback() {
    this.connect();
  }
  disconnectedCallback() {
    this.unbind?.();
    this.unbind = undefined;
    this.bound = undefined;
  }
  attributeChangedCallback(name: string) {
    if (!this.isConnected) return;
    if (name === "collection") this.connect();
    else if (this.state) this.draw();
  }
  private connect() {
    const collection = this.getAttribute("collection") ?? "";
    const owner = ownerOf(this);
    if (!owner || this.bound === `${owner}/${collection}`) return;
    this.unbind?.();
    // A new binding starts clean: nothing from the last collection (an error, records, a schema) carries over.
    this.state = undefined;
    this.root.replaceChildren();
    this.reset();
    this.bound = `${owner}/${collection}`;
    this.unbind = bind(owner, collection, (message) => {
      this.state = { ...this.state, ...message };
      this.draw();
    });
  }
  protected get owner() {
    return ownerOf(this)!;
  }
  protected get schema(): Schema {
    return (this.state?.schema as Schema) ?? {};
  }
  /** Tells the plugin, as a click on `data-action` would. */
  protected act(action: string | null, value: unknown) {
    if (action) this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action, value } }));
  }
  abstract draw(): void;
  /** Forgets anything kept for the last binding. */
  protected reset(): void {}
}

/** `datetime-local` has no time zone: show stored UTC times in local time, and store what is entered as UTC. */
const pad = (n: number) => String(n).padStart(2, "0");
function toLocalInput(value: unknown): string {
  const date = typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const fromLocalInput = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

class UiTable extends BoundElement {
  static get observedAttributes() {
    return ["collection", "columns", "sort", "empty", "row-action", "deletable"];
  }
  private sortBy?: string;

  draw() {
    const style = h("style", {}, STYLES);
    if (this.state?.error) return this.root.replaceChildren(style, h("p", { class: "error", role: "alert" }, this.state.error));
    const props = this.schema.properties ?? {};
    const columns = list(this.getAttribute("columns")) ?? Object.keys(props).slice(0, 5);
    const sort = this.sortBy ?? this.getAttribute("sort") ?? undefined;
    const rows = [...((this.state?.records as Row[]) ?? [])];
    if (sort) {
      const key = sort.replace(/^-/, "");
      const dir = sort.startsWith("-") ? -1 : 1;
      rows.sort((a, b) => {
        const x = a[key], y = b[key];
        if (x === y) return 0;
        if (x === undefined || x === null || x === "") return 1;
        if (y === undefined || y === null || y === "") return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
      });
    }
    const numeric = (c: string) => props[c]?.type === "number" || props[c]?.type === "integer";
    const head = h("tr", {}, ...columns.map((c) => {
      const active = sort?.replace(/^-/, "") === c;
      const button = h("button", { type: "button" }, label(props[c], c), active ? (sort!.startsWith("-") ? " ↓" : " ↑") : "");
      button.onclick = () => {
        this.sortBy = active && !sort!.startsWith("-") ? `-${c}` : c;
        this.draw();
      };
      return h("th", { scope: "col", class: numeric(c) ? "number" : undefined, "aria-sort": active ? (sort!.startsWith("-") ? "descending" : "ascending") : undefined }, button);
    }), ...(this.hasAttribute("deletable") && this.state?.writable ? [h("th", {}, "")] : []));
    const rowAction = this.getAttribute("row-action");
    const body = h("tbody", {}, ...rows.map((row) => {
      const cells = columns.map((c, i) => {
        const text = format(row[c], props[c]);
        if (i === 0 && rowAction) {
          const button = h("button", { type: "button", class: "link" }, text || "(untitled)");
          button.onclick = () => this.act(rowAction, row.id);
          return h("td", {}, button);
        }
        return h("td", { class: numeric(c) ? "number" : undefined }, text);
      });
      if (this.hasAttribute("deletable") && this.state?.writable) {
        const remove = h("button", { type: "button", class: "remove", "aria-label": `Delete ${format(row[columns[0]], props[columns[0]])}` }, "Delete");
        remove.onclick = async () => {
          const result = await saveRecord(this.owner, this.getAttribute("collection")!, row.id, null);
          if (!result.ok) this.act("error", result.error);
        };
        cells.push(h("td", {}, remove));
      }
      return h("tr", { "data-id": row.id }, ...cells);
    }));
    const caption = this.state?.title ? h("caption", { class: "status", style: "text-align:left" }, `${this.state.title} · ${rows.length}`) : "";
    this.root.replaceChildren(style, rows.length || !this.state?.records ? h("table", {}, caption, h("thead", {}, head), body) : h("p", { class: "empty" }, this.getAttribute("empty") ?? "Nothing here yet."));
  }
}

class UiForm extends BoundElement {
  static get observedAttributes() {
    return ["collection", "fields", "record", "submit", "action"];
  }
  private errors: Record<string, string> = {};
  private status = "";
  private busy = false;
  /** Which record the form's typed values belong to; a different one starts from its saved values. */
  private draftFor?: string;

  protected reset() {
    this.errors = {};
    this.status = "";
    this.draftFor = undefined;
  }

  draw() {
    const style = h("style", {}, STYLES);
    if (this.state?.error) return this.root.replaceChildren(style, h("p", { class: "error", role: "alert" }, this.state.error));
    if (!this.state?.schema) return this.root.replaceChildren(style);
    if (!this.state.writable) return this.root.replaceChildren(style, h("p", { class: "error", role: "alert" }, `This plugin can't write ${this.state.title ?? "this collection"}.`));
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
    const editable = (s: Schema) => s.type !== "array" && s.type !== "object";
    const names = (list(this.getAttribute("fields")) ?? Object.keys(props)).filter((n) => props[n] && editable(props[n]));
    const current = editing ? (this.state.records as Row[] | undefined)?.find((r) => r.id === editing) : undefined;
    const fields = names.map((name) => {
      const s = props[name];
      // A field the person cleared stays cleared.
      const value = typed && Object.hasOwn(typed, name) ? typed[name] : (current?.[name] ?? s.default);
      const id = `f-${name}`;
      const error = this.errors[name];
      const common: Record<string, string | undefined> = { id, name, "aria-invalid": error ? "true" : undefined, "aria-describedby": error ? `${id}-error` : undefined, required: required.has(name) ? "" : undefined };
      let control: HTMLElement;
      if (s.type === "boolean") {
        control = h("input", { ...common, type: "checkbox", required: undefined });
        (control as HTMLInputElement).checked = Boolean(value);
        return h("label", { class: "check" }, control, label(s, name), ...(error ? [h("span", { class: "error", id: `${id}-error` }, error)] : []));
      }
      if (s.enum) {
        control = h("select", common, ...(required.has(name) ? [] : [h("option", { value: "" }, "")]), ...s.enum.map((o) => h("option", { value: String(o) }, String(o))));
        (control as HTMLSelectElement).value = value === undefined ? "" : String(value);
      } else if (s.type === "string" && (s["x-multiline"] || (s.maxLength ?? 0) > 200)) {
        control = h("textarea", common);
        (control as HTMLTextAreaElement).value = value === undefined ? "" : String(value);
      } else {
        const type = s.type === "number" || s.type === "integer" ? "number" : s.format === "date" ? "date" : s.format === "date-time" ? "datetime-local" : s.format === "email" ? "email" : s.format === "uri" ? "url" : "text";
        control = h("input", { ...common, type, min: s.minimum?.toString(), max: s.maximum?.toString(), step: s.type === "integer" ? "1" : s.type === "number" ? "any" : undefined, maxlength: s.maxLength?.toString() });
        (control as HTMLInputElement).value = value === undefined ? "" : type === "datetime-local" ? toLocalInput(value) : String(value);
      }
      return h("label", { for: id, class: control.localName === "textarea" ? "wide" : undefined }, label(s, name) + (required.has(name) ? " *" : ""), control, ...(error ? [h("span", { class: "error", id: `${id}-error` }, error)] : []));
    });
    const submit = h("button", { type: "submit" }, this.getAttribute("submit") ?? (editing ? "Save" : "Add"));
    (submit as HTMLButtonElement).disabled = this.busy;
    const form = h("form", { novalidate: "" }, h("div", { class: "fields" }, ...fields), h("div", { class: "actions" }, h("span", { class: this.errors._ ? "error" : "status", role: "status" }, this.errors._ ?? this.status), submit));
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.save(form);
    };
    const focused = this.root.activeElement?.getAttribute("name");
    this.root.replaceChildren(style, form);
    if (focused) (this.root.querySelector(`[name="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }

  /** What the form holds now, typed by the schema; undefined before it is drawn. */
  private values(form = this.root.querySelector("form")): Record<string, unknown> | undefined {
    if (!form) return undefined;
    const props = this.schema.properties ?? {};
    const out: Record<string, unknown> = Object.create(null);
    for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]")) {
      const s = props[el.name];
      if (el instanceof HTMLInputElement && el.type === "checkbox") out[el.name] = el.checked;
      else if (s?.type === "number" || s?.type === "integer") out[el.name] = el.value === "" ? undefined : Number(el.value);
      else if (el instanceof HTMLInputElement && el.type === "datetime-local") out[el.name] = el.value === "" ? undefined : fromLocalInput(el.value);
      else out[el.name] = el.value === "" ? undefined : el.value;
    }
    return out;
  }

  private async save(form: HTMLFormElement) {
    const fields = { ...this.values(form)! };
    const editing = this.getAttribute("record") ?? undefined;
    const current = editing ? (this.state?.records as Row[] | undefined)?.find((r) => r.id === editing) : undefined;
    this.busy = true;
    this.errors = {};
    this.status = "Saving…";
    this.draw();
    // Fields the form doesn't show keep their values.
    const result = await saveRecord(this.owner, this.getAttribute("collection")!, editing, { ...current, ...fields });
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

export function defineBoundComponents(): void {
  if (!customElements.get("ui-table")) customElements.define("ui-table", UiTable);
  if (!customElements.get("ui-form")) customElements.define("ui-form", UiForm);
}
