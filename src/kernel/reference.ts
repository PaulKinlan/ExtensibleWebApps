// Self-description: the kernel's API reference, built at run time from the
// same tables the kernel enforces. Hooks come from the hook registry,
// services and their methods from the service providers (a method that isn't
// described there can't be called), and the plugin API, views, slots and
// manifest fields from tables typed against their TypeScript types, so the
// compiler refuses a member that has no entry.
//
// `reference()` returns it as data (plugins read it with
// `ctx.call("kernel", "reference")`); `toMarkdown()` prints it. docs/api.md is
// that print, checked against the running kernel by the tests.

import type { Api, ApiMember } from "../shared/api";
import type { Command, Slot, View } from "../shared/protocol";
import { EDITOR_PERMISSIONS } from "./gate";
import { capabilityFor, hooks, type Mode } from "./hooks";
import { ACTIONS, COMPONENTS, ELEMENT_ATTRIBUTES, ELEMENTS, GLOBAL_ATTRIBUTES, HTML_MAX, INPUT_TYPES } from "../shared/html";
import { MANIFEST_FIELDS, RESERVED } from "./manifest";
import { RECORD_FIELDS } from "./records";
import { SCHEMA_KEYWORDS } from "./schema";
import { PLATFORM } from "./paths";
import type { RemotePlugins, ServiceProvider } from "./remote";

/** `needs` is Markdown: capabilities in backticks, or empty for nothing. */
type Doc = { signature: string; needs: string; description: string };

/** The `ctx` a plugin gets. Keyed by every member of `Api`. */
const CTX: Record<ApiMember<Api>, Doc> = {
  on: {
    signature: "ctx.on(hook, handler) → off()",
    needs: "`hook:listen:<hook>` (emit, parallel) or `hook:intercept:<hook>` (serial, bail, waterfall)",
    description: "Listens to a hook. In a `function` handler, `this` is a copy of ctx pinned to the action's trace. What it returns matters only for hooks that can change or stop an action.",
  },
  call: {
    signature: "ctx.call(service, method, ...args) → Promise",
    needs: "What the method needs (see Services)",
    description: "Calls a kernel service. Rejects if the capability is missing, the method doesn't exist, or the service refuses.",
  },
  "ui.render": {
    signature: "ctx.ui.render(slot, key, view, order?)",
    needs: "`ui`",
    description: "Draws a view in a slot, under a key of the plugin's own: an HTML string (see HTML views), a JSON view, or null to remove it. Drawing again updates it in place. Plugins never touch the DOM.",
  },
  "ui.html": {
    signature: "ctx.ui.html`…${value}…` → view",
    needs: "",
    description: "Builds an HTML view from a template, escaping every value (arrays are joined, nested html results go in as they are). Use it whenever text comes from data.",
  },
  "ui.live": {
    signature: "ctx.ui.live(slot, key, (ctx) => view, order?) → { refresh(), stop() }",
    needs: "`ui`",
    description: "Draws what the function returns, like `ui.render`, and draws it again whenever a collection it read (with `data.list` or `data.get` on the ctx it is given) or the plugin's settings change. Call `refresh()` after the plugin's own state changes. A collection that doesn't exist yet is followed too, so the view fills in when it appears.",
  },
  "ui.views": {
    signature: "ctx.ui.views(file) → { render(slot, id, data?, { key?, order? }?), live(slot, id, (ctx) => data, { key?, order? }?) }",
    needs: "`ui` (to render)",
    description: "The `<template id>` elements in an .html file next to the plugin (only for plugins an app links). `render` draws one, filled with `data`: `{{path}}` holes in text and attribute values (an attribute that is one whole hole is left out when its value is false or missing, and bare when true), `<template for=\"x of path\">` and `<template if=\"path\">`. Values go in as text, and the result is checked like any HTML view. A `<style>` in the file styles only this plugin's views, below the page's own styles. `live` fills it with what the function returns, again whenever what it read changes (see `ui.live`).",
  },
  "ui.onEvent": {
    signature: "ctx.ui.onEvent((action, value) => …) → off()",
    needs: "",
    description: "Hears the person use the plugin's views: a button's or field's `action`, with a field's new value.",
  },
  "ui.onCanvas": {
    signature: "ctx.ui.onCanvas(id, (canvas) => …)",
    needs: "",
    description: "Receives the OffscreenCanvas for a canvas view the plugin rendered. Use scope \"tab\" for plugins that draw.",
  },
  "settings.get": {
    signature: "ctx.settings.get() → Promise<values>",
    needs: "",
    description: "The plugin's own settings: saved values over the manifest's defaults.",
  },
  "settings.onChange": {
    signature: "ctx.settings.onChange((values) => …) → off()",
    needs: "",
    description: "Hears the person change the plugin's settings.",
  },
  "storage.get": {
    signature: "ctx.storage.get(key) → Promise<value | null>",
    needs: "",
    description: "Reads the plugin's own data.",
  },
  "storage.set": {
    signature: "ctx.storage.set(key, value) → Promise",
    needs: "",
    description: "Saves a JSON value in the plugin's own data (null removes it), up to 1 MB in all. Never reviewed.",
  },
  traced: {
    signature: "ctx.traced() → ctx",
    needs: "",
    description: "A copy of ctx whose calls keep the current trace id after an `await`.",
  },
  log: {
    signature: "ctx.log(text, level?)",
    needs: "",
    description: "Writes to the trace, as info or error.",
  },
};

const VIEWS: Record<View["type"], string> = {
  html: "{ html }: plain HTML (see HTML views). The usual way to build UI; a string passed to ctx.ui.render becomes one.",
  template: "{ src, id, data? }: a template from an .html file next to the plugin, filled with data. Made by ctx.ui.views(file).render().",
  stack: "{ children, direction? }: views in a column, or a row.",
  heading: "{ text }",
  text: "{ text, title?, tone? }: tone is muted, error or ok.",
  button: "{ label, action, primary? }: sends `action` when pressed.",
  list: "{ items: [{ label, action, selected? }] }",
  textarea: "{ name, value, action, placeholder? }: sends `action` with the text as the person types.",
  canvas: "{ id, width, height }: the plugin receives an OffscreenCanvas through ctx.ui.onCanvas.",
  diff: "{ lines: [{ op, text }] }: a line diff; op is same, add or del.",
  field: "{ name, label, kind, value, action, options?, description? }: kind is text, number, checkbox or select; sends `action` with the new value.",
};

/** The slots the platform's own page has. An app names its own with `<slot name>` in its app.html. */
const SLOTS: Record<Slot, string> = {
  nav: "The column on the left.",
  main: "The middle of the page. Review cards appear here too.",
  side: "The column on the right, where the plugins panel is.",
  status: "The bar at the bottom.",
  devtools: "Inside the trace panel, under its buttons.",
};

const MODES: Record<Mode, string> = {
  emit: "Every listener is told; nothing comes back. Listening needs hook:listen.",
  parallel: "Every listener is told at once; nothing comes back. Listening needs hook:listen.",
  serial: "Listeners answer one after another; returning { block } stops the action. Listening needs hook:intercept.",
  bail: "Listeners answer one after another; the first answer wins. Listening needs hook:intercept.",
  waterfall: "Each listener can change the value before the next sees it, or return { block }. Listening needs hook:intercept.",
};

export const COMMANDS: Record<Command, string> = {
  bench: "(n) Times a hook round trip to a plugin worker against one answered in the kernel.",
  "reload-test": "(n) Reloads word-count n times and counts listeners and workers before and after.",
  reload: "(id) Restarts a plugin's workers.",
  install: "(source) Installs a plugin and keeps it with the data.",
  uninstall: "(id) Removes a plugin kept with the data.",
  trace: "() The most recent trace events.",
  changes: "() The change log.",
  reference: "() This reference, as { data, markdown }.",
};

export interface Reference {
  modes: { mode: string; about: string }[];
  hooks: { name: string; mode: Mode; listen: string; args?: string; timeoutMs?: number; onFailure?: string; description?: string }[];
  ctx: ({ member: string } & Doc)[];
  services: { name: string; description: string; methods: { name: string; args: string; returns: string; needs?: string; reviewed?: boolean; description: string }[] }[];
  capabilities: { name: string; about: string }[];
  editorPermissions: { permission: string; capabilities: string[] }[];
  manifest: { field: string; about: string }[];
  reservedIds: string[];
  schema: { keyword: string; about: string }[];
  recordFields: string[];
  platformPaths: string[];
  views: { type: string; about: string }[];
  html: {
    maxLength: number;
    elements: { tag: string; attributes: string[]; about: string }[];
    globalAttributes: string[];
    inputTypes: string[];
    components: { tag: string; attributes: string; about: string }[];
    actions: string[];
  };
  slots: { slot: string; about: string }[];
  commands: { name: string; about: string }[];
  /** What is installed right now. Not part of the contract, so not in docs/api.md. */
  plugins: { id: string; name: string; origin: string; enabled: boolean; scope: string; permissions: string[]; instances: string[]; hooks: string[] }[];
}

export function reference(services: Record<string, ServiceProvider>, remote: RemotePlugins): Reference {
  const serviceList = Object.entries(services).map(([name, s]) => ({
    name,
    description: s.description,
    methods: Object.entries(s.methods).map(([method, doc]) => ({ name: method, ...doc })),
  }));
  // Capabilities: the fixed ones, then each one a service method needs.
  const needs = new Map<string, string[]>();
  for (const s of serviceList) for (const m of s.methods) if (m.needs) needs.set(m.needs, [...(needs.get(m.needs) ?? []), `${s.name}.${m.name}`]);
  const capabilities = [
    { name: "ui", about: "Draw views with ctx.ui.render." },
    { name: "network", about: "Run in a worker whose policy allows fetch and WebSockets to https: hosts. Without it, a plugin can't connect anywhere." },
    { name: "hook:listen:<hook>", about: "Listen to an emit or parallel hook." },
    { name: "hook:intercept:<hook>", about: "Listen to a hook that can change or stop an action (serial, bail, waterfall)." },
    ...[...needs].map(([name, methods]) => ({ name, about: `Call ${methods.join(", ")}.` })),
  ];
  return {
    modes: Object.entries(MODES).map(([mode, about]) => ({ mode, about })),
    hooks: [...hooks].map(([name, spec]) => ({ name, ...spec, listen: capabilityFor(name) })),
    ctx: Object.entries(CTX).map(([member, doc]) => ({ member, ...doc })),
    services: serviceList,
    capabilities,
    editorPermissions: Object.entries(EDITOR_PERMISSIONS).map(([permission, caps]) => ({ permission, capabilities: caps })),
    manifest: Object.entries(MANIFEST_FIELDS).map(([field, about]) => ({ field, about })),
    reservedIds: [...RESERVED],
    schema: Object.entries(SCHEMA_KEYWORDS).map(([keyword, about]) => ({ keyword, about })),
    recordFields: RECORD_FIELDS,
    platformPaths: [...PLATFORM],
    views: Object.entries(VIEWS).map(([type, about]) => ({ type, about })),
    html: {
      maxLength: HTML_MAX,
      elements: Object.entries(ELEMENTS).map(([tag, about]) => ({ tag, attributes: ELEMENT_ATTRIBUTES[tag] ?? [], about })),
      globalAttributes: GLOBAL_ATTRIBUTES,
      inputTypes: INPUT_TYPES,
      components: Object.entries(COMPONENTS).map(([tag, c]) => ({ tag, ...c })),
      actions: ACTIONS,
    },
    slots: Object.entries(SLOTS).map(([slot, about]) => ({ slot, about })),
    commands: Object.entries(COMMANDS).map(([name, about]) => ({ name, about })),
    plugins: [...remote.installed.values()].map((p) => {
      const instances = remote.instances(p.id);
      return {
        id: p.id,
        name: p.manifest.name,
        origin: p.origin,
        enabled: p.enabled,
        scope: p.manifest.scope ?? "shared",
        permissions: p.manifest.permissions,
        instances,
        hooks: [...new Set(instances.flatMap((i) => remote.live.get(i)?.heard ?? []))],
      };
    }),
  };
}

/** Escapes a table cell. */
const cell = (text: unknown) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (text: string) => (text ? `\`${text}\`` : "");
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

/** The reference as Markdown. With `live`, it ends with what is installed right now. */
export function toMarkdown(ref: Reference, { live = false } = {}): string {
  const out: string[] = [
    "# API reference",
    "",
    "Printed by the kernel from its own registries (`npm run reference` writes this file; the tests fail if it falls behind). Plugins can read the same thing as data with `ctx.call(\"kernel\", \"reference\")`.",
    "",
    "## The plugin's `ctx`",
    "",
    table(["Call", "Needs", "What it does"], ref.ctx.map((c) => [code(c.signature), c.needs || "Nothing", c.description])),
    "",
    "## Services",
    "",
    "Called with `ctx.call(service, method, ...args)`. A method not listed here doesn't exist. Reviewed methods show the person a diff with the plugin's reason first; they accept once, allow that plugin in that place from then on, or decline.",
  ];
  for (const s of ref.services) {
    out.push("", `### ${s.name}`, "", s.description, "");
    out.push(table(["Method", "Returns", "Needs", "What it does"], s.methods.map((m) => [code(`${s.name}.${m.name}${m.args}`), m.returns, (code(m.needs ?? "") || "Nothing") + (m.reviewed ? ", and the person's review" : ""), m.description])));
  }
  out.push(
    "",
    "## Hooks",
    "",
    table(["Hook", "Mode", "Listening needs", "Listeners get", "What it means"], ref.hooks.map((h) => [code(h.name), h.mode + (h.timeoutMs ? `, ${h.timeoutMs} ms per listener, fails ${h.onFailure ?? "open"}` : ""), code(h.listen), h.args ? code(h.args) : "", h.description ?? ""])),
    "",
    "### Dispatch modes",
    "",
    table(["Mode", "What happens"], ref.modes.map((m) => [code(m.mode), m.about])),
    "",
    "## Capabilities",
    "",
    "A plugin lists what it needs in its manifest's `permissions`; the gate checks every message against them. A trailing `*` grants everything that starts with what comes before it.",
    "",
    table(["Capability", "Lets a plugin"], ref.capabilities.map((c) => [code(c.name), c.about])),
    "",
    "Plugins written for the Markdown editor can use its permissions, which stand for these capabilities:",
    "",
    table(["Editor permission", "Capabilities"], ref.editorPermissions.map((p) => [code(p.permission), p.capabilities.map(code).join(", ")])),
    "",
    "## Manifest",
    "",
    "`export const manifest = { ... }` must be the module's first statement, a plain literal, read before any of the plugin's code runs.",
    "",
    table(["Field", "Meaning"], ref.manifest.map((m) => [code(m.field), m.about])),
    "",
    `Reserved ids: ${ref.reservedIds.map(code).join(", ")}.`,
    "",
    `Paths that belong to the platform, which no plugin can read or write through \`files\`: ${ref.platformPaths.map(code).join(", ")}.`,
    "",
    "## Collections",
    "",
    `A plugin declares the collections it owns in its manifest, each with a schema, and reads and writes them through the \`data\` service without asking. Another plugin needs \`data:read:<collection>\` or \`data:write:<collection>\`, and its writes are reviewed. Every write runs \`data:beforeWrite:<collection>\` (a listener can block it) and then \`data:changed:<collection>\`; listening to either also needs \`data:read:<collection>\`. The kernel keeps ${ref.recordFields.map(code).join(", ")} on every record. Records are kept with the app's data in \`collections/<name>.json\`.`,
    "",
    "Schemas are a JSON Schema subset:",
    "",
    table(["Keyword", "Notes"], ref.schema.map((s) => [code(s.keyword), s.about])),
    "",
    "Views bind to a collection with `<ui-table collection=\"…\">` and `<ui-form collection=\"…\">` (see Components), acting with the rights of the plugin that drew them.",
    "",
    "## HTML views",
    "",
    `Plugins describe UI as plain HTML, up to ${ref.html.maxLength.toLocaleString("en")} characters. The host parses it inertly and keeps only what is listed here: no script, no style attributes, no frames, no event attributes. Unknown elements are unwrapped, so their text stays. Styling comes from the app's design tokens, so plain HTML already looks like the rest of the app; \`class\` is for a template file's own \`<style>\`, which reaches only that plugin's views. Images load from https: only for plugins with the \`network\` capability; others can use data: images.`,
    "",
    "### Components",
    "",
    table(["Element", "Attributes", "What it does"], ref.html.components.map((c) => [code(`<${c.tag}>`), c.attributes, c.about])),
    "",
    "### Actions",
    "",
    ...ref.html.actions.map((a) => `- ${a}`),
    "",
    "### Plain elements",
    "",
    `Allowed on every element: ${ref.html.globalAttributes.map(code).join(", ")}, \`aria-*\` and \`data-*\`. Input types: ${ref.html.inputTypes.map(code).join(", ")}.`,
    "",
    table(["Element", "Its own attributes", "Notes"], ref.html.elements.map((e) => [code(`<${e.tag}>`), e.attributes.map(code).join(", "), e.about])),
    "",
    "## Views and slots",
    "",
    table(["View", "Shape"], ref.views.map((v) => [code(v.type), v.about])),
    "",
    table(["Slot", "Where"], ref.slots.map((s) => [code(s.slot), s.about])),
    "",
    "## Commands",
    "",
    "For devtools and tests, from the page: `window.__host.command(name, arg)`.",
    "",
    table(["Command", "What it does"], ref.commands.map((c) => [code(c.name), c.about])),
  );
  if (live) {
    out.push(
      "",
      "## Installed now",
      "",
      table(["Plugin", "From", "State", "Permissions", "Listens to"], ref.plugins.map((p) => [`${p.name} (${code(p.id)})`, p.origin, `${p.enabled ? "on" : "off"}, ${p.scope}, ${p.instances.length} running`, p.permissions.map(code).join(", "), p.hooks.map(code).join(", ")])),
    );
  }
  return out.join("\n") + "\n";
}
