// What a plugin may put in an HTML view, by name: the elements, the host's components and the attributes the
// page's sanitiser keeps (src/host/sanitize.ts). Only names, so every page carries a short list; what each is
// for is html.ts, which the API reference prints and which is typed against these lists, so the two can't differ.

/** The attributes of a <canvas> in a view (each side at most 4096 pixels). */
export const CANVAS_ATTRIBUTES = ["id", "width", "height", "pointer"];

/** Plain HTML elements a view may use. html.ts says what each is for. */
export const ELEMENT_NAMES = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "small",
  "code",
  "pre",
  "kbd",
  "mark",
  "s",
  "sub",
  "sup",
  "br",
  "hr",
  "blockquote",
  "a",
  "img",
  "figure",
  "figcaption",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "section",
  "header",
  "footer",
  "article",
  "aside",
  "nav",
  "details",
  "summary",
  "form",
  "label",
  "input",
  "select",
  "option",
  "textarea",
  "button",
  "fieldset",
  "legend",
  "progress",
  "meter",
  "time",
  "abbr",
  "svg",
  "canvas",
  "slot",
] as const;

/** The host's own components. Any attribute is allowed on these except event handlers, `style` and `data-plugin`. html.ts says what each is for. */
export const COMPONENT_NAMES = [
  "ui-stack",
  "ui-grid",
  "ui-card",
  "ui-badge",
  "ui-stat",
  "ui-empty",
  "ui-table",
  "ui-form",
  "ui-toolbar",
  "ui-spacer",
  "ui-code",
  "ui-editor",
  "ui-commands",
  "ui-diagram",
  "ui-markdown",
  "ui-debug",
  "ui-panel",
  "ui-preview",
  "ui-dictation",
  "ui-site-preview",
  "ui-summarizer",
  "ui-waveform",
] as const;

/**
 * Attributes allowed on every element. `aria-*` and `data-*` are allowed too.
 * `class` is for the plugin's own stylesheet, which only reaches its own views.
 */
export const GLOBAL_ATTRIBUTES = ["title", "role", "hidden", "lang", "dir", "tabindex", "key", "class"];

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
  slot: ["name"],
  svg: ["viewBox", "preserveAspectRatio", "width", "height", "focusable"],
  canvas: CANVAS_ATTRIBUTES,
};

/** Input types a plugin may use. */
export const INPUT_TYPES = ["text", "search", "email", "url", "tel", "number", "range", "date", "time", "datetime-local", "month", "week", "color", "checkbox", "radio", "hidden"];

export const DROPPED_WITH_CONTENT = new Set(["script", "style", "template", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "noscript", "math", "video", "audio", "source", "track", "portal"]);
