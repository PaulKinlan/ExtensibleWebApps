// What each field of a plugin's manifest means, for the API reference (reference.ts). It is words for readers,
// not rules: manifest.ts holds a manifest to them. Kept apart so the kernel fetches it only when someone asks
// for the reference, with the code that writes it.

import { THEME_TOKENS } from "../shared/theme";
import type { Manifest } from "../shared/protocol";
import { PLUGIN_HOOKS } from "./hooks";

/** What each manifest field means. Typed against Manifest, so a new field can't go undocumented. */
export const MANIFEST_FIELDS: Record<keyof Manifest, string> = {
  id: "Required. Lowercase letters, digits and dashes, starting with a letter; at most 64 characters. A plugin with the same id replaces the one installed.",
  name: "Required. The name the person sees.",
  version: "Optional. Shown nowhere yet.",
  description: "Optional. Shown as the name's tooltip in the plugins panel.",
  permissions: "Required, may be empty. Capabilities (see Capabilities).",
  order: "Optional. Where the plugin's views go among others in the same slot; lower comes first.",
  scope: '"shared" (the default): one worker for every tab. "tab": one worker per open tab, for plugins that draw or keep view state.',
  runs: '"browser" (the default): in the browser, on each device. "server": only in a space\'s kernel on its server, for an app opened in a space (/s/<space>/…), with no app open anywhere; it has no UI, no file system, and no network unless it asks for `network`. "both": in each. See docs/server.md.',
  collections: "Optional. Up to 10 collections the plugin owns: { name: { title?, schema } }, each schema a JSON Schema subset (see Collections). The owner reads and writes its own without asking. In a space, `rules` says which members may change it ({ add?, change?, remove? }, each \"editors\", \"owner\" or, for change and remove, \"author\": whoever added the record); the space's server enforces them.",
  settings: "Optional. Up to 30 settings, each { type, title?, description?, default?, enum? }; type is string, number or boolean, and enum (a list of choices) is for strings. The plugins panel builds the form.",
  places:
    'Optional. Up to 20 places in the app\'s page, for pages with no slot to draw in: { name: { at, put, each?, in? } }. `at` is a CSS selector run against the page (never inside another plugin\'s view, unless `in` names that plugin: a view transform, which needs the permission ui:transform:<in>); `put` is "before", "after", "prepend", "append", "replace" or "hide"; `each` uses every match, up to 200, instead of the first. Render to the name as to a slot. Needs the ui permission. See docs/guide/places.md.',
  theme:
    `Optional. Design tokens the plugin sets for the whole app: { "--accent": "light-dark(#7c3aed, #c4b5fd)" }. Only ${Object.keys(THEME_TOKENS).join(", ")}, to plain values (nothing that loads a file). They sit above the platform's defaults and below the page's own styles. Needs the ui:theme permission. See docs/guide/styling.md.`,
  hooks: `Optional. Up to ${PLUGIN_HOOKS.max} hooks the plugin defines: { key: { mode, args?, description?, timeoutMs?, agentTimeoutMs?, onFailure?, quiet? } }. Each is the hook \`<id>:<key>\` (keys are lowercase letters, digits and dashes), which only this plugin runs, with ctx.hooks.emit or ctx.hooks.call; others listen with ctx.on and hook:listen or hook:intercept, as for the kernel's hooks, and may listen before the plugin is installed. A listener has timeoutMs to answer (${PLUGIN_HOOKS.defaultTimeoutMs} ms if not given, at most ${PLUGIN_HOOKS.timeoutMs}); an agent that checks it has agentTimeoutMs (at most ${PLUGIN_HOOKS.agentTimeoutMs / 1000} s; without one, agents can't check it). A hook that runs many times a second (a game's moves) says \`quiet: true\`, and isn't traced unless a listener fails. A hook lasts while its plugin is installed. These limits are the defaults; a site may change them in kernel.json's \`hooks\`.`,
  services:
    'Optional. Up to 30 services the plugin calls that not every site runs, by name: ["llm", "bus"]. The kernel\'s own services (data, storage, settings and the rest) are always there and needn\'t be listed. A plugin that lists a service the site doesn\'t run isn\'t started, and says which one is missing, so an app that needs it fails when it opens rather than on its first call. The site lists the services it runs in kernel.json (docs/layers.md).',
  provides:
    'Optional. Up to 5 services the plugin provides, by name: { mail: { description, methods: { send: { args?, returns?, description, needs? } } } }. Each needs the permission provide:<name>, and the plugin answers its calls with ctx.provide (shared plugins only, not scope "tab"). Other plugins call it with ctx.call(name, method, ...args) and the permission <name>, or what a method\'s `needs` says. A name the kernel or another plugin already has is refused. See docs/layers.md.',
  files:
    "Optional. Up to 20 other files next to the plugin that it needs, such as its templates and images: names like countdown.html, or paths in a folder beside it like plugin-editor.templates/card.js (up to four folders deep, and the first folder's name has a dot in it, so it can never be another app's folder). They are copied with it when a person adds it to an app.",
  standIn:
    'Optional, with the ui permission. { slot, key, html }: a view the kernel draws in the plugin\'s place, at the slot and key the plugin will draw its own, until the person first does something in it. The plugin starts then, draws its own view over it, and hears what they did once it has (so it listens before it first draws). For a plugin that is a panel behind a button: the button costs nothing until it is opened. `html` is at most 2,000 characters.',
  code:
    "Optional, for a plugin the app itself links that runs in the browser (never one a person adds). A .js file beside the plugin that holds the rest of its code, such as panel.code.js: the plugin's own file is then only `export const manifest = {…}`, and the other file has `export default function (ctx) {…}` and everything it uses. The page reads the two as one file when the plugin starts. With a `standIn`, an app that links the plugin fetches only its manifest until the person first uses it.",
};
