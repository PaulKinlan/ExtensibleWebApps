// What a plugin may put in an HTML view. Plugins describe UI as plain HTML,
// because that is what models (and people) already write well; the host
// parses it inertly, keeps only what is listed here, and draws it. No
// script, no styles, no frames, no event attributes. The kernel's API
// reference prints these tables, so the builder reads the same list the
// sanitiser enforces.

/** The largest HTML view the kernel passes on, in characters. */
export const HTML_MAX = 200_000;

/** Plain HTML elements, and what each is for. */
export const ELEMENTS: Record<string, string> = {
  div: "A block",
  span: "An inline run",
  p: "A paragraph",
  h1: "Headings; the host styles them to the app's scale",
  h2: "",
  h3: "",
  h4: "",
  strong: "Text styles",
  em: "",
  small: "",
  code: "",
  pre: "",
  kbd: "",
  mark: "",
  s: "",
  sub: "",
  sup: "",
  br: "",
  hr: "",
  blockquote: "",
  a: "A link; opens in a new tab. href must be https:, http:, mailto: or #",
  img: "An image; src must be https: or a data: image",
  figure: "",
  figcaption: "",
  ul: "Lists",
  ol: "",
  li: "",
  dl: "",
  dt: "",
  dd: "",
  table: "Tables; styled to the app's tokens",
  caption: "",
  thead: "",
  tbody: "",
  tfoot: "",
  tr: "",
  th: "",
  td: "",
  section: "Grouping",
  header: "",
  footer: "",
  article: "",
  aside: "",
  nav: "",
  details: "A disclosure, with summary",
  summary: "",
  form: "A form; with data-action, submitting it sends the action with every named field's value",
  label: "Form controls; with data-action, a change sends the action with the new value",
  input: "",
  select: "",
  option: "",
  textarea: "",
  button: "A button; with data-action, a click sends the action (and data-value, if set)",
  fieldset: "",
  legend: "",
  progress: "",
  meter: "",
  time: "",
  abbr: "",
};

/** Attributes allowed on every element. `aria-*` and `data-*` are allowed too. */
export const GLOBAL_ATTRIBUTES = ["title", "role", "hidden", "lang", "dir", "tabindex", "key"];

/** Attributes allowed on particular elements. */
export const ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height", "loading"],
  ol: ["start", "reversed"],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  details: ["open"],
  form: ["novalidate"],
  label: ["for"],
  input: ["type", "name", "value", "placeholder", "checked", "disabled", "readonly", "required", "min", "max", "step", "minlength", "maxlength", "pattern", "autocomplete", "id"],
  select: ["name", "disabled", "required", "multiple", "id"],
  option: ["value", "selected", "disabled"],
  textarea: ["name", "placeholder", "disabled", "readonly", "required", "rows", "minlength", "maxlength", "id"],
  button: ["type", "disabled", "name", "value"],
  fieldset: ["disabled"],
  progress: ["value", "max"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  time: ["datetime"],
};

/** Input types a plugin may use. */
export const INPUT_TYPES = ["text", "search", "email", "url", "tel", "number", "range", "date", "time", "datetime-local", "month", "week", "color", "checkbox", "radio", "hidden"];

/** The host's own components. Any attribute is allowed on these except event handlers and `style`. */
export const COMPONENTS: Record<string, { attributes: string; about: string }> = {
  "ui-stack": { attributes: "direction=\"row\", gap=\"1\"…\"6\", align=\"start|center|end|stretch\", justify=\"start|center|end|between\", wrap", about: "Lays its children out in a column (or a row) with even spacing." },
  "ui-grid": { attributes: "min=\"12rem\", gap=\"1\"…\"6\"", about: "As many columns as fit, each at least `min` wide." },
  "ui-card": { attributes: "tone=\"accent|ok|warn|danger\"", about: "A bordered surface for one thing." },
  "ui-badge": { attributes: "tone=\"neutral|accent|ok|warn|danger\"", about: "A short status word." },
  "ui-stat": { attributes: "label, value, delta, tone", about: "A number with its label, and an optional change." },
  "ui-empty": { attributes: "heading", about: "What to show when there is nothing yet; put a sentence and a button inside." },
  "ui-table": { attributes: "collection, columns=\"title,author\", sort=\"title|-title\", empty, row-action, deletable", about: "A sortable table of a collection's records, kept up to date. The first column becomes a button that sends `row-action` with the record's id; `deletable` adds a Delete button. Acts with the rights of the plugin that drew it." },
  "ui-form": { attributes: "collection, fields=\"title,author\", record, submit, action", about: "A form built from the collection's schema: labels, input types, required fields and errors from the kernel's checks. Saves a new record, or edits `record`; sends `action` with the saved record's id." },
  "ui-toolbar": { attributes: "", about: "A row of controls that wraps, with the last group pushed to the end by a ui-spacer." },
  "ui-spacer": { attributes: "", about: "Takes up the free space in a row." },
};

export const DROPPED_WITH_CONTENT = new Set(["script", "style", "template", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "noscript", "svg", "math", "canvas", "video", "audio", "source", "track", "portal", "slot"]);

/** How a plugin's view reports what the person did. */
export const ACTIONS = [
  "A click on an element with `data-action` sends that action, with `data-value` as the value if it has one.",
  "An `input`, `select` or `textarea` with `data-action` sends it when the change is committed, with the new value (a boolean for a checkbox, a number for a number). Add `data-live` to send it as the person types, after a 300 ms pause.",
  "A `form` with `data-action` sends it on submit, with `{ name: value }` for every named field.",
  "Give repeated elements a `key` attribute so an update moves them instead of redrawing them; focus, typing and scroll survive updates either way.",
];
