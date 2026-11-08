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
import { capabilityFor, hookOwners, hooks, type Mode } from "./hooks";
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
  "hooks.emit": {
    signature: "ctx.hooks.emit(key, value) → Promise",
    needs: "",
    description: "Tells every listener of one of the plugin's own emit or parallel hooks (the manifest's `hooks`), with value. No other plugin can run it. Listeners hear it with `ctx.on(\"<id>:<key>\", …)` and `hook:listen:<id>:<key>`.",
  },
  "hooks.call": {
    signature: "ctx.hooks.call(key, value) → Promise<answer>",
    needs: "",
    description: "Runs one of the plugin's own serial, bail or waterfall hooks and waits for its listeners, each within the hook's time limit: a serial hook answers `{ block }` when a listener stops the action, a bail hook with the first answer, and a waterfall with value as the listeners changed it. Listening needs `hook:intercept:<id>:<key>`.",
  },
  "commands.add": {
    signature: "ctx.commands.add({ id, title, description?, keys?, group?, args? }, (args, { by }) => result) → off()",
    needs: "",
    description: "Adds a command the plugin answers: a palette lists it, its `keys` run it, and plugins with `commands` (an agent, through its tools) run it with `commands.run(\"<plugin>/<id>\")`. The handler runs with this plugin's own rights; `by` says which plugin ran it, and what it returns goes back to the caller. Throwing fails the run. See the commands service.",
  },
  "schedule.every": {
    signature: "ctx.schedule.every(name, ms, handler) → off()",
    needs: "schedule",
    description: "Runs `handler` every `ms` milliseconds (at least 1000), first one interval from now. On a space's server the job wakes the space when it comes due, even after a restart, and a run missed while it was stopped happens once when it starts. Setting it again with the same interval keeps its timing. `off()` stops listening; the job stays until `cancel`.",
  },
  "schedule.at": {
    signature: "ctx.schedule.at(name, when, handler) → off()",
    needs: "schedule",
    description: "Runs `handler` once, at `when` (ms since 1970). Kept across restarts on a space's server.",
  },
  "schedule.cancel": {
    signature: "ctx.schedule.cancel(name) → Promise",
    needs: "schedule",
    description: "Stops one of this plugin's jobs and forgets it.",
  },
  "routes.add": {
    signature: "ctx.routes.add(method, path, (request) => response) → off()",
    needs: "`routes`",
    description: "Answers requests for a path inside the plugin's own folder (only for plugins an app links), so a link or a form can reach the plugin. The platform's service worker sends a matching request to the kernel through an open tab. `request` is `{ method, path, query, form }`; the handler returns `{ redirect }` (a 303 to a page on this site), `{ html }` (a page in which no script runs), `{ json }` or `{ text }`, each with an optional `status`. Returning nothing lets another plugin answer, and then 404.",
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
    signature: "ctx.ui.onCanvas(id, (canvas, theme) => …)",
    needs: "",
    description: "Receives the OffscreenCanvas for a canvas view the plugin rendered, with the page's theme: `{ scheme, colors, font }`, where colors holds fg, fg-2, bg, bg-2, surface, border, accent, accent-fg, danger, ok and warn, resolved. Use scope \"tab\" for plugins that draw.",
  },
  "ui.onTheme": {
    signature: "ctx.ui.onTheme((theme) => …) → off()",
    needs: "",
    description: "Hears the theme change (light and dark flip, a theme is turned on or off) in a tab where the plugin has a canvas, so it can draw again in the new colours.",
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
  sync: "() In a page at /s/<space>/…: this copy of the space's sync, as { seq, connected, pending, drafts }; elsewhere { space: false }.",
  reference: "() This reference, as { data, markdown }.",
  "user:list": "({ app }) The person's own plugins for an app: each file, its manifest's id, name, permissions and places, and whether it is on.",
  "user:add": "({ app, files: [{ name, data }] } or { app, url }) Adds plugins (.js) and the files they bring to an app's user folder; from a URL on this site, the files its manifest lists come too. They start off.",
  "user:on": "({ app, id }) Turns a user plugin on, and opens the app again in every tab that has it open.",
  "user:off": "({ app, id }) Turns a user plugin off, and opens the app again in every tab that has it open.",
  "user:remove": "({ app, id }) Removes a user plugin and the files it lists.",
  "place:ask": "({ app, plugin, place, target, what }) Asks the person, on a review card, to let a plugin change a place the author marked review.",
  "place:unlock": "({ app, plugin, place }) Lets a plugin into a place the author locked, because the person said so.",
  "place:lock": "({ app, plugin, place }) Takes that back.",
  route: "({ method, path, query, form }) Answers a request with the plugin route for it, or null. The service worker sends these through a tab.",
};

export interface Reference {
  modes: { mode: string; about: string }[];
  hooks: { name: string; mode: Mode; listen: string; args?: string; timeoutMs?: number; agentTimeoutMs?: number; onFailure?: string; description?: string }[];
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
  plugins: { id: string; name: string; origin: string; enabled: boolean; scope: string; permissions: string[]; instances: string[]; hooks: string[]; defines: string[] }[];
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
    { name: "schedule", about: "Run work later, once or every so often, with ctx.schedule. On a space's server a job wakes the space." },
    { name: "routes", about: "Answer requests for paths in the plugin's own folder with ctx.routes.add." },
    { name: "network", about: "Run in a worker whose policy allows fetch and WebSockets to https: hosts. Without it, a plugin can't connect anywhere." },
    { name: "ui:theme", about: "Set design tokens for the whole app with the manifest's `theme`." },
    { name: "ui:transform:<plugin>", about: "Change that plugin's views with places whose `in` names it: add to them, replace or hide parts of them. See docs/guide/slots-and-transforms.md." },
    { name: "hook:listen:<hook>", about: "Listen to an emit or parallel hook." },
    { name: "hook:intercept:<hook>", about: "Listen to a hook that can change or stop an action (serial, bail, waterfall)." },
    ...[...needs].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, methods]) => ({ name, about: `Call ${methods.join(", ")}.` })),
  ];
  return {
    modes: Object.entries(MODES).map(([mode, about]) => ({ mode, about })),
    // The kernel's own hooks. A collection's hooks and a plugin's own come and go with their plugins: see Installed now.
    hooks: [...hooks].filter(([name]) => !hookOwners.has(name) && !/^data:(changed|beforeWrite):/.test(name)).map(([name, spec]) => ({ name, ...spec, listen: capabilityFor(name) })),
    ctx: Object.entries(CTX).map(([member, doc]) => ({ member, ...doc })),
    services: serviceList,
    capabilities,
    editorPermissions: Object.entries(EDITOR_PERMISSIONS).map(([permission, caps]) => ({ permission, capabilities: caps })),
    manifest: Object.entries(MANIFEST_FIELDS).map(([field, about]) => ({ field, about })),
    reservedIds: [...RESERVED].sort(),
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
        // Its own hooks, and the hooks of the collections it owns.
        defines: [
          ...[...hookOwners].filter(([, owner]) => owner === p.id).map(([name]) => name),
          ...[...hooks.keys()].filter((name) => {
            const collection = /^data:(?:changed|beforeWrite):(.+)$/.exec(name)?.[1];
            return !!collection && remote.collectionOwner?.(collection) === p.id;
          }),
        ],
      };
    }),
  };
}

/** Escapes a table cell. */
const cell = (text: unknown) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (text: string) => (text ? `\`${text}\`` : "");
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const byName = <T>(key: (item: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b), "en");

/**
 * The parts that every new feature adds to (ctx members, service methods,
 * hooks) are printed as one heading per entry, sorted by name, with blank
 * lines between. Two changes that each add an entry then touch different
 * lines of docs/api.md, so they merge without a conflict.
 */
const spaced = (blocks: string[]) => blocks.flatMap((b, i) => (i ? ["", b] : [b]));
const entry = (level: string, name: string, lines: string[]) => [`${level} ${name}`, "", ...lines.filter(Boolean).flatMap((l) => [l, ""])].join("\n").trimEnd();

/** The reference as Markdown. With `live`, it ends with what is installed right now. */
export function toMarkdown(ref: Reference, { live = false } = {}): string {
  const out: string[] = [
    "# API reference",
    "",
    "Printed by the kernel from its own registries (`npm run reference` writes this file; the tests fail if it falls behind). Plugins can read the same thing as data with `ctx.call(\"kernel\", \"reference\")`.",
    "",
    "## The plugin's `ctx`",
    "",
    ...spaced([...ref.ctx].sort(byName((c) => c.member)).map((c) => entry("###", `ctx.${c.member}`, [code(c.signature), `Needs: ${c.needs || "nothing"}.`, c.description]))),
    "",
    "## Services",
    "",
    "Called with `ctx.call(service, method, ...args)`. A method not listed here doesn't exist. Reviewed methods show the person a diff with the plugin's reason first; they accept once, allow that plugin in that place from then on, or decline.",
  ];
  for (const s of [...ref.services].sort(byName((s) => s.name))) {
    out.push("", `### ${s.name}`, "", s.description);
    for (const m of [...s.methods].sort(byName((m) => m.name))) {
      const needs = (code(m.needs ?? "") || "nothing") + (m.reviewed ? ", and the person's review" : "");
      out.push("", entry("####", `${s.name}.${m.name}`, [`${code(`${s.name}.${m.name}${m.args}`)} → ${m.returns}`, `Needs: ${needs}.`, m.description]));
    }
  }
  out.push(
    "",
    "## Hooks",
    "",
    "The kernel's own hooks. A plugin defines more in its manifest's `hooks`, named `<plugin>:<key>`, which only it runs (with `ctx.hooks`), and each collection has `data:beforeWrite:<collection>` and `data:changed:<collection>` (see Collections). Those last while their plugin is installed, so they are listed under Installed now.",
    "",
    ...spaced([...ref.hooks].sort(byName((h) => h.name)).map((h) =>
      entry("###", code(h.name), [
        h.description ?? "",
        `Mode: ${code(h.mode)}${h.timeoutMs ? `, ${h.timeoutMs} ms per listener, fails ${h.onFailure ?? "open"}` : ""}${h.agentTimeoutMs ? `; an agent that checks it has ${h.agentTimeoutMs / 1000} s` : ""}. Listening needs ${code(h.listen)}.`,
        h.args ? `Listeners get ${code(h.args)}.` : "",
      ]),
    )),
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
    "Reserved ids, which no plugin can take:",
    "",
    ...ref.reservedIds.map((id) => `- ${code(id)}`),
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
    `Plugins describe UI as plain HTML, up to ${ref.html.maxLength.toLocaleString("en")} characters. The host parses it inertly and keeps only what is listed here: no script, no frames, no event attributes, and a \`style\` attribute keeps only custom properties set to numbers (\`style="--pct: 40"\`, for sizes from data). Unknown elements are unwrapped, so their text stays. Styling comes from the app's design tokens, so plain HTML already looks like the rest of the app; \`class\` is for a template file's own \`<style>\`, which reaches only that plugin's views. Images load from https: only for plugins with the \`network\` capability; others can use data: images.`,
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
      table(["Plugin", "From", "State", "Permissions", "Defines", "Listens to"], ref.plugins.map((p) => [`${p.name} (${code(p.id)})`, p.origin, `${p.enabled ? "on" : "off"}, ${p.scope}, ${p.instances.length} running`, p.permissions.map(code).join(", "), p.defines.map(code).join(", "), p.hooks.map(code).join(", ")])),
    );
  }
  return out.join("\n") + "\n";
}
