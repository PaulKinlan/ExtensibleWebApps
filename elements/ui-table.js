// @ts-check
// ui-table: see ui-table.html for what it does and its attributes.

import { BoundElement, format, h, label, list } from "./bound-element.js";

/** @typedef {{ collection: string, label?: string }} XRef */
/** @typedef {import("./bound-element.js").Row} Row */
/** @typedef {import("./bound-element.js").Schema & { "x-ref"?: XRef, items?: FieldSchema, properties?: Record<string, FieldSchema> }} FieldSchema */
/** @typedef {import("./bound-element.js").Bound & { refs?: Record<string, Row[] | null> }} BoundWithRefs */

const KERNEL_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

export default class UiTable extends BoundElement {
  static observedAttributes = ["collection", "columns", "sort", "empty", "row-action", "deletable", "filterable", "page-size"];

  /** @type {string | undefined} the column the person sorted by, "-name" for descending */
  sortBy;
  /** @type {string} client-side filter text when `filterable` is set */
  filter = "";
  /** @type {number} zero-based page index when `page-size` is set */
  page = 0;
  /** @type {HTMLInputElement | undefined} */
  #search;
  /** @type {HTMLDivElement | undefined} */
  #results;

  reset() {
    this.sortBy = undefined;
    this.filter = "";
    this.page = 0;
    this.#search = undefined;
    this.#results = undefined;
  }

  draw() {
    if (this.state?.error) {
      this.#search = undefined;
      this.#results = undefined;
      return this.show(h("p", { class: "error", role: "alert" }, this.state.error));
    }
    if (!this.state?.records) {
      this.#search = undefined;
      this.#results = undefined;
      return this.show();
    }

    if (!this.hasAttribute("filterable")) {
      this.#search = undefined;
      this.#results = undefined;
      this.filter = "";
      this.show(...this.#buildContent());
      return;
    }

    const searchLabel = `Filter ${this.state.title ?? "records"}`;
    if (!this.#search || !this.#results || !this.root.contains(this.#search)) {
      const input = h("input", { type: "search", class: "filter", placeholder: "Filter…", "aria-label": searchLabel });
      input.value = this.filter;
      input.oninput = () => {
        this.filter = input.value;
        this.page = 0;
        this.#results?.replaceChildren(...this.#buildContent());
      };
      this.#search = input;
      this.#results = h("div", { class: "results" });
      this.show(h("div", { class: "toolbar" }, input), this.#results);
    } else {
      this.#search.setAttribute("aria-label", searchLabel);
      if (this.root.activeElement !== this.#search && this.#search.value !== this.filter) this.#search.value = this.filter;
    }
    this.#results.replaceChildren(...this.#buildContent());
  }

  /** @returns {HTMLElement[]} */
  #buildContent() {
    const props = /** @type {Record<string, FieldSchema>} */ (this.schema.properties ?? {});
    const refs = /** @type {BoundWithRefs | undefined} */ (this.state)?.refs;
    const columns = list(this.getAttribute("columns")) ?? Object.keys(props).slice(0, 5);
    const allRows = this.state?.records ?? [];
    if (!allRows.length) return [h("p", { class: "empty" }, this.getAttribute("empty") ?? "Nothing here yet.")];

    const sort = this.sortBy ?? this.getAttribute("sort") ?? undefined;
    const sortedRows = sorted(allRows, sort, props, refs);
    const q = this.hasAttribute("filterable") ? this.filter.trim().toLowerCase() : "";
    const matched = q ? sortedRows.filter((row) => matchesFilter(row, columns, props, refs, q)) : sortedRows;
    if (!matched.length) return [h("p", { class: "empty" }, "No matching records.")];

    const rawPageSize = Number(this.getAttribute("page-size"));
    const pageSize = Number.isInteger(rawPageSize) && rawPageSize > 0 ? rawPageSize : 0;
    const total = matched.length;
    let rows = matched;
    /** @type {HTMLElement | undefined} */
    let pager;
    if (pageSize > 0 && total > pageSize) {
      const pages = Math.ceil(total / pageSize);
      if (this.page >= pages) this.page = pages - 1;
      if (this.page < 0) this.page = 0;
      const start = this.page * pageSize;
      rows = matched.slice(start, start + pageSize);
      const prev = h("button", { type: "button", class: "pager-btn", ...(this.page === 0 ? { disabled: "" } : {}) }, "Previous");
      prev.onclick = () => {
        this.page--;
        this.draw();
      };
      const next = h("button", { type: "button", class: "pager-btn", ...(start + rows.length >= total ? { disabled: "" } : {}) }, "Next");
      next.onclick = () => {
        this.page++;
        this.draw();
      };
      pager = h("div", { class: "pager" }, h("span", { class: "page-count" }, `${start + 1}–${start + rows.length} of ${total}`), h("div", { class: "pager-actions" }, prev, next));
    } else {
      this.page = 0;
    }

    const numeric = (/** @type {string} */ c) => props[c]?.type === "number" || props[c]?.type === "integer";
    const deletable = this.hasAttribute("deletable") && this.state?.writable;

    const head = h("tr", {}, ...columns.map((c) => {
      const active = sort?.replace(/^-/, "") === c;
      const descending = active && sort?.startsWith("-");
      const button = h("button", { type: "button" }, label(props[c], c), active ? (descending ? " ↓" : " ↑") : "");
      button.onclick = () => {
        this.sortBy = active && !descending ? `-${c}` : c;
        this.page = 0;
        this.draw();
      };
      return h("th", { scope: "col", class: numeric(c) ? "number" : undefined, "aria-sort": active ? (descending ? "descending" : "ascending") : undefined }, button);
    }), ...(deletable ? [h("th", {})] : []));

    const rowAction = this.getAttribute("row-action");
    const body = h("tbody", {}, ...rows.map((row) => {
      const cells = columns.map((c, i) => {
        const text = display(row[c], props[c], refs);
        if (i === 0 && rowAction) {
          const button = h("button", { type: "button", class: "link" }, text || "(untitled)");
          button.onclick = () => this.act(rowAction, row.id);
          return h("td", {}, button);
        }
        return h("td", { class: numeric(c) ? "number" : undefined }, text);
      });
      if (deletable) {
        const remove = h("button", { type: "button", class: "remove", "aria-label": `Delete ${display(row[columns[0]], props[columns[0]], refs)}` }, "Delete");
        remove.onclick = async () => {
          const result = await this.save(row.id, null);
          if (!result.ok) this.act("error", result.error);
        };
        cells.push(h("td", {}, remove));
      }
      return h("tr", { "data-id": row.id }, ...cells);
    }));

    const caption = this.state?.title ? h("caption", { class: "status" }, `${this.state.title} · ${total}`) : "";
    const table = h("table", {}, caption, h("thead", {}, head), body);
    return pager ? [table, pager] : [table];
  }
}

/** Formats `value`, resolving `x-ref` record ids to their label when readable. @returns {string} */
function display(/** @type {unknown} */ value, /** @type {FieldSchema | undefined} */ schema, /** @type {Record<string, Row[] | null> | undefined} */ refs) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.map((v) => display(v, schema?.items, refs)).join(", ");
  const xref = schema?.["x-ref"];
  if (xref && typeof value === "string") {
    const refRows = refs?.[xref.collection];
    if (Array.isArray(refRows)) {
      const found = refRows.find((r) => r.id === value);
      if (found) return String((xref.label ? found[xref.label] : undefined) ?? found.title ?? found.name ?? found.id);
    }
    return value;
  }
  return format(value, schema);
}

/** True when `row` matches `q` in any displayed column or string field. */
function matchesFilter(/** @type {Row} */ row, /** @type {string[]} */ columns, /** @type {Record<string, FieldSchema>} */ props, /** @type {Record<string, Row[] | null> | undefined} */ refs, /** @type {string} */ q) {
  for (const c of columns) {
    if (display(row[c], props[c], refs).toLowerCase().includes(q)) return true;
  }
  for (const [k, v] of Object.entries(row)) {
    if (!KERNEL_FIELDS.has(k) && typeof v === "string" && v.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** A sorted copy of `rows`; "name" sorts up, "-name" down, and empty values go last. */
function sorted(/** @type {Row[]} */ rows, /** @type {string | undefined} */ sort, /** @type {Record<string, FieldSchema>} */ props, /** @type {Record<string, Row[] | null> | undefined} */ refs) {
  const copy = [...rows];
  if (!sort) return copy;
  const key = sort.replace(/^-/, "");
  const dir = sort.startsWith("-") ? -1 : 1;
  const colSchema = props[key];
  const resolveRef = colSchema?.["x-ref"] && Array.isArray(refs?.[colSchema["x-ref"].collection]);
  const val = (/** @type {Row} */ r) => (resolveRef ? display(r[key], colSchema, refs) : r[key]);
  const blank = (/** @type {unknown} */ v) => v === undefined || v === null || v === "";
  return copy.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === y) return 0;
    if (blank(x)) return 1;
    if (blank(y)) return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}
