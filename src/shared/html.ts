// What a plugin may put in an HTML view. Plugins describe UI as plain HTML,
// because that is what models (and people) already write well; the host
// parses it inertly, keeps only what is listed here, and draws it. No
// script, no styles, no frames, no event attributes. The kernel's API
// reference prints these tables, so the builder reads the same list the
// sanitiser enforces.

/** The attributes of a <canvas> in a view (each side at most 4096 pixels). */
export const CANVAS_ATTRIBUTES = ["id", "width", "height", "pointer"];

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
  a: "A link; opens in a new tab. href must be https:, http:, mailto:, # or relative. A relative one (book/42, ./) stays on this site and opens in the same tab: a link to a screen of the app moves to it without loading the page (see the router service)",
  img: "An image; src must be https: (with the network permission), a data: image, or a picture on this site with no ?query",
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
  svg: "", // what it is for: ELEMENT_NOTES in svg-docs.ts, kept out of the page script
  canvas: "",
  slot: "A room in this view that other plugins fill: `<slot name=\"<your plugin id>.<room>\" data-id=\"…\">`. The name must start with the plugin's own id and a dot; data-* attributes tell the plugins that fill it which thing it is for (page.slots). What it holds is shown until a plugin draws there. See docs/guide/slots-and-transforms.md",
};

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

/** The host's own components. Any attribute is allowed on these except event handlers, `style` and `data-plugin`. */
export const COMPONENTS: Record<string, { attributes: string; about: string }> = {
  "ui-stack": { attributes: "direction=\"row\", gap=\"1\"…\"6\", align=\"start|center|end|stretch\", justify=\"start|center|end|between\", wrap", about: "Lays its children out in a column (or a row) with even spacing." },
  "ui-grid": { attributes: "min=\"12rem\", gap=\"1\"…\"6\"", about: "As many columns as fit, each at least `min` wide." },
  "ui-card": { attributes: "tone=\"accent|ok|warn|danger\"", about: "A bordered surface for one thing." },
  "ui-badge": { attributes: "tone=\"neutral|accent|ok|warn|danger\"", about: "A short status word." },
  "ui-stat": { attributes: "label, value, delta, tone", about: "A number with its label, and an optional change." },
  "ui-empty": { attributes: "heading", about: "What to show when there is nothing yet; put a sentence and a button inside." },
  "ui-table": { attributes: "collection, columns=\"title,author\", sort=\"title|-title\", empty, row-action, deletable", about: "A sortable table of a collection's records, kept up to date. The first column becomes a button that sends `row-action` with the record's id; `deletable` adds a Delete button. Acts with the rights of the plugin that drew it." },
  "ui-form": { attributes: "collection, fields=\"title,author\", record, submit, action", about: "A form built from the collection's schema: labels, input types, required fields and errors from the kernel's checks, beside the control they are about. A list field gets a row per item with Add and Remove buttons, and a group gets a fieldset, two levels deep. Saves a new record, or edits `record`; sends `action` with the saved record's id." },
  "ui-toolbar": { attributes: "", about: "A row of controls that wraps, with the last group pushed to the end by a ui-spacer." },
  "ui-spacer": { attributes: "", about: "Takes up the free space in a row." },
  "ui-code": { attributes: "name, label, rows=\"20\", readonly, revision", about: "A plain code editor: a textarea with line numbers, where Tab indents (Escape, then Tab, leaves it). Its text content is the starting code; edits survive redraws until `revision` changes. In a `form` it is sent under its `name`." },
  "ui-editor": { attributes: "name, label, placeholder, readonly, revision, action, selection-action, paste-action, drop-action, select=\"from,to\", annotations, spellcheck=\"true\", words", about: "A Markdown editor (CodeMirror): styled as you type, with undo, search and Tab to indent. Its text content is the starting text; edits survive redraws until `revision` changes, and then the new text goes in as an edit. `action` is sent with the text after a pause in typing, `selection-action` with { from, to, text }, and `paste-action` and `drop-action` take pastes and drops for the plugin to put in ({ from, to, text, html, files }). `select` selects a range; `annotations` is JSON [{ from, to, severity, message }] to underline. `spellcheck=\"true\"` turns the browser's spell check on, and `words` is a JSON list of words it should accept (where the browser has a custom dictionary)." },
  "ui-commands": { attributes: "label, open-keys=\"Mod+K\", run, no-button, message, message-at", about: "A command palette: a button (and the `open-keys` shortcut) opens a searchable list of the commands inside it, each a `<button data-command=\"name\" data-keys='[\"Mod+B\",\"Shift+N\"]' data-group data-description>Title</button>`. Picking one, or pressing one of its keys anywhere on the page, sends `run` with its name. `message` is announced briefly whenever `message-at` changes." },
  "ui-diagram": { attributes: "label", about: "A Mermaid diagram: its text content is the diagram, in Mermaid's language (flowchart, sequenceDiagram, …). `label` says what it shows, for screen readers. Mermaid loads the first time one is drawn." },
  "ui-markdown": { attributes: "src, pages=\"/docs/\", repo, sets-title, compact", about: "A Markdown file in the template's folder (or below it), drawn as a page, with ```mermaid blocks as diagrams. Raw HTML in it shows as text. `pages` is a folder whose .md files are this app's screens (links to them drop .md); `repo` is where links to source go; `sets-title` makes its first heading the page's title; `compact` is for a list of contents." },
  "ui-debug": { attributes: "corner=\"bottom-left|bottom-right|top-left|top-right|inline\", problems, label, toggle", about: "A bug button that stays on screen and opens a panel holding the element's content. `problems` is a count shown on the bug; `toggle` is sent with true or false as the panel opens and closes. A button inside with `data-copy=\"name\"` copies the text of the element with `data-copy-source=\"name\"`, headed with the page's address, browser and time." },
  "ui-panel": { attributes: "label, toggle", about: "A button labelled `label` that opens a panel above the page, holding the element's content; where the button sits is up to the slot. `toggle` is sent with true or false as the panel opens and closes. A button inside with `data-close` closes the panel as well as sending its action." },
  "ui-preview": { attributes: "app=\"<name>\", revision, label", about: "A working copy of an app the person made in the browser (std/maker/), from /apps/<name>/, in a frame, with a link to open it in its own tab. Changing `revision` opens it again." },
  "ui-dictation": { attributes: "action, label, lang", about: "A button that listens, with the browser's speech recognition, while it is pressed in. `action` is sent with { listening: true } when the microphone is on, { text, final } for what it hears (final: false while a phrase is still changing), and { listening: false, error? } when it stops. Disabled, saying why, in a browser without speech recognition." },
  "ui-site-preview": { attributes: "address=\"http://localhost:1313/…\", revision, label, action", about: "A page from a web server on the person's own device (localhost, 127.0.0.1), such as a site's `hugo server`, in a frame; any other address isn't shown. It checks the server first, and sends `action` with \"up\", \"down\" or \"blocked\" (the browser won't let the site reach the device). Changing `revision` checks again and reloads it." },
  "ui-waveform": { attributes: "peaks=\"-12,30,…\", duration, select=\"from,to\", action, playing=\"at,from,to\", label", about: "A sound's waveform, from `peaks` (a low and a high from -100 to 100 for each column) and its `duration` in seconds. Dragging across it (or Shift and the arrow keys) picks a part, sent as `action` with { from, to } in seconds; a click sends a cursor. `select` sets the part shown as picked; `playing` runs a playhead from `from` to `to` starting at `at` (ms since the epoch)." },
};

export const DROPPED_WITH_CONTENT = new Set(["script", "style", "template", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "noscript", "math", "video", "audio", "source", "track", "portal"]);

/** How a plugin's view reports what the person did. */
export const ACTIONS = [
  "A click on an element with `data-action` sends that action, with `data-value` as the value if it has one.",
  "An `input`, `select` or `textarea` with `data-action` sends it when the change is committed, with the new value (a boolean for a checkbox, a number for a number). Add `data-live` to send it as the person types, after a 300 ms pause.",
  "A `form` with `data-action` sends it on submit, with `{ name: value }` for every named field.",
  "A submit button with `data-action` of its own, in such a form, sends its action instead, with the same fields.",
  "An element with `data-drag=\"<item>\"` can be picked up, and dropping it on an element with `data-drop=\"<action>\"` sends that action with `{ item, value, before? }`: `value` is the drop place's `data-value`, and `before` the `data-drag` of the item it landed on. Drags stay inside the view; `data-dragging` and `data-over` mark them for CSS. Offer the same move with a button too.",
  "Give repeated elements a `key` attribute so an update moves them instead of redrawing them; focus, typing and scroll survive updates either way.",
];
