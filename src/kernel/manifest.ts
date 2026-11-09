// Reads a plugin's manifest from its source without running it, so the
// kernel knows what a plugin asks for before any of its code executes (the
// Markdown editor does the same). `export const manifest = { ... }` must be
// the module's first statement, with only comments before it, so a manifest
// in a comment or a string can't stand in for the real one. Its value must be
// a plain literal: strings, numbers, booleans, null, arrays and objects, with
// optional comments and trailing commas, and nothing after it but the end of
// the statement. Anything else is refused.

import { THEME_TOKENS, badThemeValue } from "../shared/theme";
import type { Manifest } from "../shared/protocol";
import { checkCollections } from "./records";
import { kernelPrefix, PLUGIN_HOOKS } from "./hooks";
import { checkSchema } from "./schema";

export class ManifestError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Owners of the kernel's own views and services; a plugin with one of these ids could pass for them. */
// Ids no plugin may take. The kernel also adds every service's name when it starts, so a new service needn't be listed here.
export const RESERVED = new Set([
  "audio",
  "data",
  "debug",
  "files",
  "host",
  "kernel",
  "net",
  "plugins",
  "review",
  "secrets",
  "settings",
  "storage",
  "store",
  "tools",
]);

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
  collections: "Optional. Up to 10 collections the plugin owns: { name: { title?, schema } }, each schema a JSON Schema subset (see Collections). The owner reads and writes its own without asking.",
  settings: "Optional. Up to 30 settings, each { type, title?, description?, default?, enum? }; type is string, number or boolean, and enum (a list of choices) is for strings. The plugins panel builds the form.",
  places:
    'Optional. Up to 20 places in the app\'s page, for pages with no slot to draw in: { name: { at, put, each?, in? } }. `at` is a CSS selector run against the page (never inside another plugin\'s view, unless `in` names that plugin: a view transform, which needs the permission ui:transform:<in>); `put` is "before", "after", "prepend", "append", "replace" or "hide"; `each` uses every match, up to 200, instead of the first. Render to the name as to a slot. Needs the ui permission. See docs/guide/places.md.',
  theme:
    `Optional. Design tokens the plugin sets for the whole app: { "--accent": "light-dark(#7c3aed, #c4b5fd)" }. Only ${Object.keys(THEME_TOKENS).join(", ")}, to plain values (nothing that loads a file). They sit above the platform's defaults and below the page's own styles. Needs the ui:theme permission. See docs/guide/styling.md.`,
  hooks: `Optional. Up to ${PLUGIN_HOOKS.max} hooks the plugin defines: { key: { mode, args?, description?, timeoutMs?, agentTimeoutMs?, onFailure? } }. Each is the hook \`<id>:<key>\` (keys are lowercase letters, digits and dashes), which only this plugin runs, with ctx.hooks.emit or ctx.hooks.call; others listen with ctx.on and hook:listen or hook:intercept, as for the kernel's hooks, and may listen before the plugin is installed. A listener has timeoutMs to answer (${PLUGIN_HOOKS.defaultTimeoutMs} ms if not given, at most ${PLUGIN_HOOKS.timeoutMs}); an agent that checks it has agentTimeoutMs (at most ${PLUGIN_HOOKS.agentTimeoutMs / 1000} s; without one, agents can't check it). A hook lasts while its plugin is installed. These limits are the defaults; a site may change them in kernel.json's \`hooks\`.`,
  services:
    'Optional. Up to 30 services the plugin calls that not every site runs, by name: ["llm", "bus"]. The kernel\'s own services (data, storage, settings and the rest) are always there and needn\'t be listed. A plugin that lists a service the site doesn\'t run isn\'t started, and says which one is missing, so an app that needs it fails when it opens rather than on its first call. The site lists the services it runs in kernel.json (docs/layers.md).',
  provides:
    'Optional. Up to 5 services the plugin provides, by name: { mail: { description, methods: { send: { args?, returns?, description, needs? } } } }. Each needs the permission provide:<name>, and the plugin answers its calls with ctx.provide (shared plugins only, not scope "tab"). Other plugins call it with ctx.call(name, method, ...args) and the permission <name>, or what a method\'s `needs` says. A name the kernel or another plugin already has is refused. See docs/layers.md.',
  files:
    "Optional. Up to 20 other files next to the plugin that it needs, such as its templates and images: names like countdown.html, or paths in a folder beside it like plugin-editor.templates/card.js (up to four folders deep, and the first folder's name has a dot in it, so it can never be another app's folder). They are copied with it when a person adds it to an app.",
};

export const PUTS = ["before", "after", "prepend", "append", "replace", "hide"] as const;
/**
 * A file a plugin lists: a name, or a path into folders beside it. No part starts with a dot, so none climbs
 * out. A person's plugins for an app are kept in that app's folder, and an app's folder may hold another app's
 * (user/demos/ and user/demos/trip/), so the first folder has a dot in its name, which no app's folder has.
 */
export const FILE_PATH = /^(?:[\w-][\w-]{0,30}\.[\w.-]{1,32}\/(?:[\w-][\w.-]{0,63}\/){0,3})?[\w-][\w.-]{0,63}$/;

export function readManifest(source: string): Manifest {
  const parser = new LiteralParser(source, 0);
  parser.declaration();
  const value = parser.value();
  parser.statementEnd();
  return validate(value);
}

function validate(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestError("The manifest must be an object");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID.test(m.id)) throw new ManifestError("`id` must be lowercase letters, digits and dashes, starting with a letter");
  if (RESERVED.has(m.id)) throw new ManifestError(`\`${m.id}\` is reserved for the kernel`);
  if (typeof m.name !== "string" || !m.name) throw new ManifestError("`name` must be a string");
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== "string")) throw new ManifestError("`permissions` must be a list of strings");
  if (m.scope !== undefined && m.scope !== "shared" && m.scope !== "tab") throw new ManifestError('`scope` must be "shared" or "tab"');
  if (m.runs !== undefined && m.runs !== "browser" && m.runs !== "server" && m.runs !== "both") throw new ManifestError('`runs` must be "browser", "server" or "both"');
  if (m.runs === "server" && m.scope === "tab") throw new ManifestError('A plugin that runs only on the server has no tabs: leave out `scope: "tab"`');
  if (m.order !== undefined && typeof m.order !== "number") throw new ManifestError("`order` must be a number");
  if (m.settings !== undefined) validateSettings(m.settings);
  if (m.places !== undefined) validatePlaces(m.places, m.permissions as string[], m.id);
  if (m.theme !== undefined) validateTheme(m.theme, m.permissions as string[]);
  if (m.files !== undefined && (!Array.isArray(m.files) || m.files.length > 20 || m.files.some((f) => typeof f !== "string" || !FILE_PATH.test(f))))
    throw new ManifestError("`files` must be a list of up to 20 file names or paths beside the plugin, such as card.html or card.templates/card.js (the first folder's name has a dot in it)");
  if (m.hooks !== undefined) validateHooks(m.hooks, m.id);
  if (m.provides !== undefined) validateProvides(m.provides, m.permissions as string[], m.scope);
  if (m.services !== undefined && (!Array.isArray(m.services) || m.services.length > 30 || m.services.some((s) => typeof s !== "string" || !ID.test(s))))
    throw new ManifestError("`services` must be a list of up to 30 service names");
  if (m.collections !== undefined) {
    try {
      checkCollections(m.collections, checkSchema);
    } catch (error) {
      throw new ManifestError(error instanceof Error ? error.message : String(error));
    }
  }
  return m as unknown as Manifest;
}

const METHOD = /^[a-zA-Z][a-zA-Z0-9]{0,40}$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

function validateProvides(provides: unknown, permissions: string[], scope: unknown) {
  if (!provides || typeof provides !== "object" || Array.isArray(provides)) throw new ManifestError("`provides` must be an object");
  const entries = Object.entries(provides as Record<string, unknown>);
  if (entries.length > 5) throw new ManifestError("A plugin provides at most 5 services");
  if (entries.length && scope === "tab") throw new ManifestError('A plugin that provides a service runs once for every tab: leave out `scope: "tab"`');
  for (const [name, spec] of entries) {
    if (!ID.test(name)) throw new ManifestError(`Service ${name}: names are lowercase letters, digits and dashes`);
    if (!permissions.includes(`provide:${name}`)) throw new ManifestError(`Providing ${name} needs the permission provide:${name}`);
    const s = spec as Record<string, unknown>;
    if (!s || typeof s !== "object" || !text(s.description, 500) || !s.description) throw new ManifestError(`Service ${name} needs a description of up to 500 characters`);
    const methods = s.methods;
    if (!methods || typeof methods !== "object" || Array.isArray(methods)) throw new ManifestError(`Service ${name} needs \`methods\``);
    const list = Object.entries(methods as Record<string, unknown>);
    if (!list.length || list.length > 30) throw new ManifestError(`Service ${name} has 1 to 30 methods`);
    for (const [method, doc] of list) {
      const d = doc as Record<string, unknown>;
      if (!METHOD.test(method)) throw new ManifestError(`Service ${name}: ${method} isn't a method name`);
      if (!d || typeof d !== "object" || !text(d.description, 500) || !d.description) throw new ManifestError(`${name}.${method} needs a description of up to 500 characters`);
      for (const key of ["args", "returns", "needs"] as const) if (d[key] !== undefined && !text(d[key], 200)) throw new ManifestError(`${name}.${method}: \`${key}\` must be text of up to 200 characters`);
      if (d.params !== undefined) validateParams(d.params, `${name}.${method}`);
    }
  }
}

/** A provided method's arguments, for tools: a list of { name, schema, optional }, in order, optional ones last. */
function validateParams(params: unknown, where: string) {
  if (!Array.isArray(params) || params.length > 10) throw new ManifestError(`${where}: \`params\` is a list of up to 10 arguments`);
  let optional = false;
  for (const p of params as Record<string, unknown>[]) {
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(p.name)) throw new ManifestError(`${where}: each param needs a name`);
    if (p.optional !== undefined && typeof p.optional !== "boolean") throw new ManifestError(`${where}: ${p.name}.optional is true or false`);
    if (optional && !p.optional) throw new ManifestError(`${where}: ${p.name} comes after an optional argument, so it must be optional too`);
    optional ||= !!p.optional;
    try {
      checkSchema(p.schema);
    } catch (error) {
      throw new ManifestError(`${where}: ${p.name}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function validateSettings(settings: unknown) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new ManifestError("`settings` must be an object");
  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length > 30) throw new ManifestError("At most 30 settings");
  for (const [key, spec] of entries) {
    const s = spec as Record<string, unknown>;
    if (!s || !["string", "number", "boolean"].includes(s.type as string)) throw new ManifestError(`Setting ${key} needs a type of string, number or boolean`);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.type !== "string")) throw new ManifestError(`Setting ${key}: enum is a list, for string settings`);
  }
}

const MODES = ["emit", "parallel", "serial", "bail", "waterfall"];

function validateHooks(value: unknown, id: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestError("`hooks` must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > PLUGIN_HOOKS.max) throw new ManifestError(`At most ${PLUGIN_HOOKS.max} hooks`);
  if (entries.length && kernelPrefix(id)) throw new ManifestError(`Hooks named \`${id}:…\` are the kernel's: a plugin that defines hooks needs another id`);
  for (const [key, spec] of entries) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(key)) throw new ManifestError(`Hook ${key}: keys are lowercase letters, digits and dashes, starting with a letter`);
    const h = spec as Record<string, unknown>;
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new ManifestError(`Hook ${key} must be { mode, args?, description?, timeoutMs?, agentTimeoutMs?, onFailure? }`);
    if (!MODES.includes(h.mode as string)) throw new ManifestError(`Hook ${key}: mode is one of ${MODES.join(", ")}`);
    for (const field of ["args", "description"]) if (h[field] !== undefined && (typeof h[field] !== "string" || (h[field] as string).length > 500)) throw new ManifestError(`Hook ${key}: ${field} is a string of up to 500 characters`);
    const waits = h.mode !== "emit" && h.mode !== "parallel";
    if (h.timeoutMs !== undefined && (!waits || typeof h.timeoutMs !== "number" || !(h.timeoutMs > 0) || h.timeoutMs > PLUGIN_HOOKS.timeoutMs))
      throw new ManifestError(`Hook ${key}: timeoutMs is for hooks that wait for an answer (serial, bail, waterfall), up to ${PLUGIN_HOOKS.timeoutMs}`);
    if (h.agentTimeoutMs !== undefined && (!waits || typeof h.agentTimeoutMs !== "number" || !(h.agentTimeoutMs > 0) || h.agentTimeoutMs > PLUGIN_HOOKS.agentTimeoutMs))
      throw new ManifestError(`Hook ${key}: agentTimeoutMs is for hooks that wait for an answer, up to ${PLUGIN_HOOKS.agentTimeoutMs}`);
    if (h.onFailure !== undefined && h.onFailure !== "open" && h.onFailure !== "closed") throw new ManifestError(`Hook ${key}: onFailure is "open" or "closed"`);
    const unknown = Object.keys(h).find((k) => !["mode", "args", "description", "timeoutMs", "agentTimeoutMs", "onFailure"].includes(k));
    if (unknown) throw new ManifestError(`Hook ${key}: ${unknown} isn't a field of a hook`);
  }
}

function validateTheme(theme: unknown, permissions: string[]) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) throw new ManifestError("`theme` must be an object of design tokens");
  if (!permissions.includes("ui:theme")) throw new ManifestError("`theme` needs the ui:theme permission");
  for (const [token, value] of Object.entries(theme)) {
    if (!(token in THEME_TOKENS)) throw new ManifestError(`Theme: ${token} isn't a token a theme may set (${Object.keys(THEME_TOKENS).join(", ")})`);
    const why = badThemeValue(value, token);
    if (why) throw new ManifestError(`Theme ${token}: ${why}`);
  }
}

function validatePlaces(places: unknown, permissions: string[], id: string) {
  if (!places || typeof places !== "object" || Array.isArray(places)) throw new ManifestError("`places` must be an object");
  const entries = Object.entries(places as Record<string, unknown>);
  if (entries.length > 20) throw new ManifestError("At most 20 places");
  if (entries.length && !permissions.includes("ui")) throw new ManifestError("`places` needs the ui permission");
  for (const [name, spec] of entries) {
    if (!/^[a-z][\w-]{0,63}$/.test(name)) throw new ManifestError(`Place ${name}: names are lowercase letters, digits, - and _`);
    const p = spec as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ManifestError(`Place ${name} must be { at, put, each?, in? }`);
    if (typeof p.at !== "string" || !p.at.trim() || p.at.length > 300) throw new ManifestError(`Place ${name} needs \`at\`, a CSS selector of up to 300 characters`);
    if (!PUTS.includes(p.put as (typeof PUTS)[number])) throw new ManifestError(`Place ${name}: \`put\` is one of ${PUTS.join(", ")}`);
    if (p.each !== undefined && typeof p.each !== "boolean") throw new ManifestError(`Place ${name}: \`each\` is true or false`);
    if (p.in !== undefined) {
      if (typeof p.in !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(p.in)) throw new ManifestError(`Place ${name}: \`in\` is the id of the plugin whose views it changes`);
      if (p.in === id) throw new ManifestError(`Place ${name}: a plugin changes its own views by drawing them, not with \`in\``);
      if (!permissions.includes(`ui:transform:${p.in}`)) throw new ManifestError(`Place ${name} changes ${p.in}'s views, which needs the permission ui:transform:${p.in}`);
    }
  }
}

class LiteralParser {
  constructor(
    private s: string,
    private i: number,
  ) {}

  private fail(what: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new ManifestError(`The manifest must be a plain literal: ${what} on line ${line}`);
  }

  private space() {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (this.s.startsWith("//", this.i)) this.i = this.s.indexOf("\n", this.i) === -1 ? this.s.length : this.s.indexOf("\n", this.i);
      else if (this.s.startsWith("/*", this.i)) {
        const end = this.s.indexOf("*/", this.i + 2);
        if (end === -1) this.fail("an unclosed comment");
        this.i = end + 2;
      } else return;
    }
  }

  /** `export const manifest =`, as the first statement. */
  declaration() {
    this.space();
    const m = /^export\s+const\s+manifest\s*=/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new ManifestError("The module must start with `export const manifest = { ... }` (only comments may come before it)");
    this.i += m[0].length;
  }

  /** The literal must end the statement: a `;`, the end of the file, or a new line that starts a new statement. */
  statementEnd() {
    const before = this.i;
    this.space();
    const c = this.s[this.i];
    if (c === undefined || c === ";") return;
    const newLine = /[\n\r]/.test(this.s.slice(before, this.i));
    if (newLine && /[A-Za-z_$]/.test(c) && !/^(in|instanceof)\b/.test(this.s.slice(this.i, this.i + 11))) return;
    this.fail(`${JSON.stringify(c)} after the manifest`);
  }

  value(): unknown {
    this.space();
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.s.startsWith(word, this.i) && !/[\w$]/.test(this.s[this.i + word.length] ?? "")) {
        this.i += word.length;
        return v;
      }
    }
    return this.fail(`unexpected ${c === undefined ? "end of file" : JSON.stringify(c)}`);
  }

  private object() {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.space();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const key = this.key();
      if (key === "__proto__" || key === "constructor" || key === "prototype") this.fail(`the key ${key}`);
      this.space();
      if (this.s[this.i] !== ":") this.fail("a missing `:`");
      this.i++;
      out[key] = this.value();
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") this.fail("a missing `,` or `}`");
    }
  }

  private key(): string {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 100));
    if (!m) return this.fail("a key that is not a name or a string");
    this.i += m[0].length;
    return m[0];
  }

  private array() {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.space();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail("a missing `,` or `]`");
    }
  }

  private string(): string {
    const quote = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") this.fail("an unclosed string");
      if (c === quote) return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "/": "/" };
        if (e === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("a bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else if (e in map) out += map[e];
        else this.fail(`the escape \\${e}`);
      } else out += c;
    }
  }

  private number(): number {
    const m = /^-?(?:0|[1-9][\d_]*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) return this.fail("a bad number");
    this.i += m[0].length;
    return Number(m[0].replace(/_/g, ""));
  }
}
