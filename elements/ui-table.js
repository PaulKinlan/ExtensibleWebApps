// @ts-check
// ui-table: see ui-table.html for what it does and its attributes.

import { BoundElement, format, h, label, list } from "./bound-element.js";

/** @typedef {import("./bound-element.js").Row} Row */

export default class UiTable extends BoundElement {
  static observedAttributes = ["collection", "columns", "sort", "empty", "row-action", "deletable"];

  /** @type {string | undefined} the column the person sorted by, "-name" for descending */
  sortBy;

  draw() {
    if (this.state?.error) return this.show(h("p", { class: "error", role: "alert" }, this.state.error));
    const props = this.schema.properties ?? {};
    const columns = list(this.getAttribute("columns")) ?? Object.keys(props).slice(0, 5);
    const sort = this.sortBy ?? this.getAttribute("sort") ?? undefined;
    const rows = sorted(this.state?.records ?? [], sort);
    const numeric = (/** @type {string} */ c) => props[c]?.type === "number" || props[c]?.type === "integer";
    const deletable = this.hasAttribute("deletable") && this.state?.writable;

    const head = h("tr", {}, ...columns.map((c) => {
      const active = sort?.replace(/^-/, "") === c;
      const descending = active && sort?.startsWith("-");
      const button = h("button", { type: "button" }, label(props[c], c), active ? (descending ? " ↓" : " ↑") : "");
      button.onclick = () => {
        this.sortBy = active && !descending ? `-${c}` : c;
        this.draw();
      };
      return h("th", { scope: "col", class: numeric(c) ? "number" : undefined, "aria-sort": active ? (descending ? "descending" : "ascending") : undefined }, button);
    }), ...(deletable ? [h("th", {})] : []));

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
      if (deletable) {
        const remove = h("button", { type: "button", class: "remove", "aria-label": `Delete ${format(row[columns[0]], props[columns[0]])}` }, "Delete");
        remove.onclick = async () => {
          const result = await this.save(row.id, null);
          if (!result.ok) this.act("error", result.error);
        };
        cells.push(h("td", {}, remove));
      }
      return h("tr", { "data-id": row.id }, ...cells);
    }));

    if (this.state?.records && !rows.length) return this.show(h("p", { class: "empty" }, this.getAttribute("empty") ?? "Nothing here yet."));
    const caption = this.state?.title ? h("caption", { class: "status" }, `${this.state.title} · ${rows.length}`) : "";
    this.show(h("table", {}, caption, h("thead", {}, head), body));
  }
}

/** A sorted copy of `rows`; "name" sorts up, "-name" down, and empty values go last. */
function sorted(/** @type {Row[]} */ rows, /** @type {string | undefined} */ sort) {
  const copy = [...rows];
  if (!sort) return copy;
  const key = sort.replace(/^-/, "");
  const dir = sort.startsWith("-") ? -1 : 1;
  const blank = (/** @type {unknown} */ v) => v === undefined || v === null || v === "";
  return copy.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (blank(x)) return 1;
    if (blank(y)) return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}
