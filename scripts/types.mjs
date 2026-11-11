#!/usr/bin/env node
// Builds TypeScript declarations (`types.d.ts`) for apps and plugins, from the
// kernel's own API reference (`docs/api.md`, or `.build/api.md` when newer).
//
//   npm run types          writes dist/platform/types.d.ts
//
// `extensible-app dev`, `check` and `test` also write `.extensible/types.d.ts`
// in a project of your own (filtered to the kernel modules its `kernel.json`
// keeps), so plain JavaScript plugins with `// @ts-check` get editor completion
// and type checking for `manifest`, `ctx`, views, schemas and `ctx.call(...)`
// without a build step or committed generated files.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectKernel } from "./project-kernel.mjs";

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads the newest API reference Markdown in `platform` (`docs/api.md` or `.build/api.md`). */
function readReferenceMarkdown(platform = PLATFORM) {
  const candidates = [join(platform, "docs/api.md"), join(platform, ".build/api.md")].filter((f) => existsSync(f));
  if (!candidates.length) throw new Error(`No docs/api.md found in ${platform}`);
  const newest = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return readFileSync(newest, "utf8");
}

/** Services omitted when a project's own `kernel.json` leaves modules out. */
function omittedServices(project, platform = PLATFORM) {
  if (!project) return new Set();
  const own = projectKernel(project, { platform });
  if (!own) return new Set();
  const all = JSON.parse(readFileSync(join(platform, "kernel.json"), "utf8")).modules ?? [];
  return new Set(
    all
      .filter((name) => !own.modules.includes(name))
      .flatMap((name) => JSON.parse(readFileSync(join(platform, "std", name, "module.json"), "utf8")).services ?? []),
  );
}

/** Splits a comma-separated list at top level (ignoring commas inside `{}`, `[]`, `()`). */
function splitTopLevel(text, delimiter = ",") {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth = Math.max(0, depth - 1);
    else if (!depth && text.startsWith(delimiter, i)) {
      parts.push(text.slice(start, i).trim());
      i += delimiter.length - 1;
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const SAFE_WORDS = new Set(["default", "class", "function", "delete", "import", "export", "return", "in", "of", "new", "void", "typeof"]);

function safeParamName(raw, index) {
  const clean = raw.replace(/[^A-Za-z0-9_$]/g, "");
  if (!clean || /^\d/.test(clean) || SAFE_WORDS.has(clean)) return `arg${index}`;
  return clean;
}

/** Converts a reference shape fragment (`{ a, b?: { c } }`, `[{ id, name }]`, `"x" | "y"`) into a TypeScript type. */
function shapeToTs(raw) {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "unknown";
  if (s === "true" || s === "false" || s === "true or false" || /^true if\b/i.test(s)) return "boolean";
  if (s === "string" || /^the file's text/i.test(s)) return "string";
  if (s === "number") return "number";
  if (s === "null") return "null";
  if (s === "nothing" || s === "void") return "void";
  if (s === "record") return "StoredRecord";
  if (s === "schema") return "Schema";
  if (/^"[^"]*"$/.test(s)) return s;

  // Quoted string union: `"granted", "denied", "default" or "unsupported"`
  if (/^(?:"[^"]*"(?:\s*,\s*|\s+or\s+|\s*\|\s*))+("[^"]*")$/.test(s)) {
    return [...s.matchAll(/"[^"]*"/g)].map((m) => m[0]).join(" | ");
  }

  // Top-level union separated by ` | ` or ` or `
  const barParts = splitTopLevel(s, " | ");
  if (barParts.length > 1) return barParts.map(shapeToTs).join(" | ");
  const orParts = splitTopLevel(s, " or ");
  if (orParts.length > 1) return orParts.map(shapeToTs).join(" | ");

  // Array notation `[item]` or `[{ a, b }]`
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return "any[]";
    const items = splitTopLevel(inner, ",");
    if (items.length === 1) {
      const elem = items[0];
      if (IDENT.test(elem)) return elem === "record" ? "StoredRecord[]" : elem === "name" || elem === "path" || elem === "column" ? "string[]" : "any[]";
      return `Array<${shapeToTs(elem)}>`;
    }
    return "any[]";
  }

  // Object notation `{ a, b?, c: type, ...rest }`
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return "Record<string, any>";
    // Mapped key syntax `{ [key]: value }`
    const mapped = /^\[\s*\w+\s*\]:\s*(.+)$/.exec(inner);
    if (mapped) return `Record<string, ${ IDENT.test(mapped[1].trim()) && !["string", "number", "boolean", "unknown", "any"].includes(mapped[1].trim()) ? "any" : shapeToTs(mapped[1]) }>`;

    const fields = splitTopLevel(inner, ",");
    const members = [];
    let openIndex = false;
    for (const field of fields) {
      if (!field || field === "…" || field === "..." || field.startsWith("...")) {
        openIndex = true;
        continue;
      }
      const colon = field.indexOf(":");
      if (colon < 0) {
        const opt = field.endsWith("?");
        const key = (opt ? field.slice(0, -1) : field).trim();
        if (!IDENT.test(key)) return "Record<string, any>";
        const inferred = key === "ok" || key === "set" || key === "enabled" || key === "ready" || key === "connected" || key === "on" ? "boolean" : key === "id" || key === "name" || key === "title" || key === "description" || key === "path" || key === "url" || key === "error" || key === "text" ? "string" : key === "status" || key === "count" ? "number" : key === "schema" ? "Schema" : "any";
        members.push(`${key}${opt ? "?" : ""}: ${inferred}`);
      } else {
        const rawKey = field.slice(0, colon).trim();
        const rawVal = field.slice(colon + 1).trim();
        const opt = rawKey.endsWith("?");
        const key = (opt ? rawKey.slice(0, -1) : rawKey).trim();
        if (!IDENT.test(key)) return "Record<string, any>";
        const valType = IDENT.test(rawVal) && !["string", "number", "boolean", "null", "unknown", "any", "true", "false", "record", "schema"].includes(rawVal) ? "any" : shapeToTs(rawVal);
        members.push(`${key}${opt ? "?" : ""}: ${valType}`);
      }
    }
    if (openIndex) members.push("[key: string]: any");
    return `{ ${members.join("; ")} }`;
  }

  if (s === "text" || s === "dataUrl") return "string";
  return "any";
}

/** Well-known exact parameter and return overrides for core everyday methods. */
const METHOD_OVERRIDES = {
  "data.collections": { params: "", returns: "Array<{ name: string; owner: string; title: string; schema: Schema }>" },
  "data.list": { params: "collection: string", returns: "StoredRecord[]" },
  "data.get": { params: "collection: string, id: string", returns: "StoredRecord | null" },
  "data.put": {
    params: "collection: string, record: Record<string, any>, reason?: string",
    returns: "{ ok: true; id: string; outcome?: string } | { ok: false; id?: string; errors?: Array<{ path: string; message: string }>; error?: string }",
  },
  "data.delete": { params: "collection: string, id: string, reason?: string", returns: "{ ok: boolean; id: string; outcome?: string }" },
  "files.read": { params: "path: string", returns: "string | null" },
  "files.write": { params: "path: string, text: string, reason: string", returns: "{ ok: boolean; path?: string; outcome?: string; unchanged?: boolean }" },
  "net.fetch": {
    params: "request: { url: string; method?: string; headers?: Record<string, string | { secret: string }>; body?: string }",
    returns: "{ ok: boolean; status: number; headers: Record<string, string>; text: string }",
  },
  "secrets.has": { params: "name: string", returns: "{ set: boolean; hosts: string[] }" },
  "secrets.request": { params: "name: string, options: { hosts: string[]; label?: string }", returns: "{ set: boolean }" },
  "secrets.forget": { params: "name: string", returns: "boolean" },
  "storage.get": { params: "key: string", returns: "any" },
  "storage.set": { params: "key: string, value: unknown", returns: "boolean" },
  "settings.get": { params: "", returns: "Record<string, any>" },
  "router.current": { params: "", returns: "{ tab: string; path: string; query: Record<string, string> }" },
  "router.go": { params: "path: string, options?: { replace?: boolean }", returns: "boolean" },
  "commands.list": {
    params: "",
    returns: "Array<{ name: string; plugin: string; id: string; title: string; description?: string; keys?: string[]; group?: string; args?: Schema }>",
  },
  "commands.run": { params: "name: string, args?: Record<string, unknown>", returns: "any" },
  "kernel.ping": { params: "", returns: '"pong"' },
  "kernel.reference": { params: "", returns: "Record<string, any>" },
  "hooks.emit": { params: "key: string, value?: unknown", returns: "void" },
  "hooks.call": { params: "key: string, value?: unknown", returns: "any" },
};

/** Converts an argument signature `(a, b?, { c, d? }?)` from `docs/api.md` into TypeScript parameter declarations. */
function argsToTs(rawArgs) {
  const trimmed = rawArgs.trim();
  const inner = trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1).trim() : trimmed;
  if (!inner) return "";
  const parts = splitTopLevel(inner, ",");
  let seenOptional = false;
  return parts
    .map((part, idx) => {
      let p = part.trim();
      if (p.startsWith("...")) return `...args: any[]`;
      let optional = false;
      if (p.endsWith("?")) {
        optional = true;
        p = p.slice(0, -1).trim();
      }
      if (seenOptional) optional = true;
      if (optional) seenOptional = true;

      if (p.startsWith("{") && p.endsWith("}")) {
        return `options${idx ? idx : ""}${optional ? "?" : ""}: ${shapeToTs(p)}`;
      }
      const name = safeParamName(p, idx);
      const type =
        /^(id|name|path|url|collection|topic|key|code|tag|html|text|reason|provider|model|space|plugin|place|method|format|question|answer|agent|command)$/.test(name)
          ? "string"
          : /^(ms|when|version|since)$/.test(name)
          ? "number"
          : /^(on|enabled)$/.test(name)
          ? "boolean"
          : "any";
      return `${name}${optional ? "?" : ""}: ${type}`;
    })
    .join(", ");
}

/** Converts a return description from `docs/api.md` into a valid TypeScript type. */
function returnsToTs(rawReturns) {
  const cleaned = rawReturns
    .trim()
    .replace(/,\s*most recently changed first$/i, "")
    .replace(/\s*\(on a server,.*\)$/i, "")
    .replace(/\.$/, "");
  if (/^(what |the same as |llm\.complete)/i.test(cleaned)) return "any";
  if (/^the reference/i.test(cleaned)) return "Record<string, any>";
  if (/^the value,?\s+or null$/i.test(cleaned)) return "any";
  if (/^\[record\]/i.test(cleaned)) return "StoredRecord[]";
  return shapeToTs(cleaned);
}

/** Parses services, hooks and capabilities from `docs/api.md` / `.build/api.md`. */
export function parseReferenceTypes(markdown, { leftOut = new Set() } = {}) {
  const services = new Map();
  const serviceSection = /^## Services\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? markdown;

  for (const sMatch of serviceSection.matchAll(/^### ([a-z][a-z0-9-]*)\n\n([^\n]+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)) {
    const [, serviceName, serviceDesc, body] = sMatch;
    if (leftOut.has(serviceName)) continue;
    const methods = [];
    for (const m of body.matchAll(/^#### ([a-z][a-z0-9-]*)\.([^\s\n]+)\n\n`([^`]+)`\s*→\s*([^\n]+)\n\nNeeds:\s*([^\n]+)\n\n([^\n]+)/gm)) {
      const [, svc, method, sig, rawRet, needs, desc] = m;
      const prefix = `${svc}.${method}`;
      const rawArgs = sig.startsWith(prefix) ? sig.slice(prefix.length) : "()";
      const override = METHOD_OVERRIDES[prefix];
      methods.push({
        service: svc,
        method,
        rawArgs,
        rawReturns: rawRet,
        needs: needs.replace(/\.$/, ""),
        description: desc.trim(),
        params: override ? override.params : argsToTs(rawArgs),
        returns: override ? override.returns : returnsToTs(rawRet),
      });
    }
    services.set(serviceName, { name: serviceName, description: serviceDesc.trim(), methods });
  }

  const hooksSection = /^## Hooks\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  const hooks = [];
  for (const h of hooksSection.matchAll(/^### `([^`]+)`\n\n([^\n]+)\n\nMode:\s*`([^`]+)`[^\n]*Listening needs `([^`]+)`\.(?:\n\nListeners get `([^`]+)`\.)?/gm)) {
    hooks.push({ name: h[1], description: h[2].trim(), mode: h[3], needs: h[4], args: h[5] ?? "" });
  }

  const capSection = /^## Capabilities\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  const capabilities = [];
  for (const row of capSection.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/gm)) {
    const cap = row[1].trim();
    if (!cap.includes("<")) capabilities.push(cap);
  }

  return { services, hooks, capabilities };
}

function escapeComment(text) {
  return text.replace(/\*\//g, "*\\/");
}

/** Generates the complete self-contained `.d.ts` declaration text. */
export function generateTypes({ platform = PLATFORM, project } = {}) {
  const md = readReferenceMarkdown(platform);
  const leftOut = omittedServices(project, platform);
  const { services, hooks, capabilities } = parseReferenceTypes(md, { leftOut });

  const capLiterals = [...new Set(capabilities)].sort().map((c) => JSON.stringify(c));
  const capPatterns = [
    "`data:read:${string}`",
    "`data:write:${string}`",
    "`files:${string}`",
    "`hook:listen:${string}`",
    "`hook:intercept:${string}`",
    "`network:${string}`",
    "`provide:${string}`",
    "`secret:${string}`",
    "`ui:transform:${string}`",
    "(string & {})",
  ];

  const hookNames = hooks.map((h) => JSON.stringify(h.name)).sort();

  const serviceInterfaces = [];
  const callOverloads = [
    `  /** Lists records in a collection, most recently updated first. Needs: \`data:read:<collection>\` (or ownership). */`,
    `  call<T = Record<string, any>>(service: "data", method: "list", collection: string): Promise<Array<StoredRecord<T> & T>>;`,
    `  /** Reads one record from a collection, or \`null\` when missing. Needs: \`data:read:<collection>\` (or ownership). */`,
    `  call<T = Record<string, any>>(service: "data", method: "get", collection: string, id: string): Promise<(StoredRecord<T> & T) | null>;`,
  ];

  for (const [, svc] of [...services].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const methodLines = [];
    for (const m of svc.methods) {
      const paramSuffix = m.params ? `, ${m.params}` : "";
      const doc = `/** ${escapeComment(m.description)} (Needs: ${escapeComment(m.needs)}) */`;
      methodLines.push(`    ${doc}\n    ${JSON.stringify(m.method)}(${m.params}): Promise<${m.returns}>;`);
      if (`${svc.name}.${m.method}` !== "data.list" && `${svc.name}.${m.method}` !== "data.get") {
        callOverloads.push(`  ${doc}\n  call(service: ${JSON.stringify(svc.name)}, method: ${JSON.stringify(m.method)}${paramSuffix}): Promise<${m.returns}>;`);
      }
    }
    serviceInterfaces.push(`  /** ${escapeComment(svc.description)} */\n  ${JSON.stringify(svc.name)}: {\n${methodLines.join("\n")}\n  };`);
  }

  callOverloads.push(`  /** Calls a plugin-provided service method. */`);
  callOverloads.push(`  call<T = any, S extends string = string>(service: S extends keyof ServiceCalls ? never : S, method: string, ...args: unknown[]): Promise<T>;`);

  return `// Generated by scripts/types.mjs from docs/api.md. Do not commit this file.

/** JSON Schema subset supported for collections, command arguments and service tool parameters. */
export interface Schema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: "date" | "date-time" | "email" | "uri";
  "x-multiline"?: boolean;
}

/** Every record stored in a collection carries kernel-managed \`id\`, \`createdAt\` and \`updatedAt\` fields. */
export interface StoredRecord<T = Record<string, any>> {
  id: string;
  createdAt: string;
  updatedAt: string;
  [field: string]: any;
}

/** The name of a \`<slot name="…">\` in the page, or a named place in the plugin's manifest. */
export type Slot = string;

/** Declarative view description rendered by the host. Plugins never touch the DOM directly. */
export type View =
  | { type: "html"; html: string; remote?: boolean }
  | { type: "template"; src: string; id: string; data?: unknown; remote?: boolean }
  | { type: "stack"; children: View[]; direction?: "row" | "column" }
  | { type: "heading"; text: string }
  | { type: "text"; text: string; title?: string; tone?: "muted" | "error" | "ok" }
  | { type: "button"; label: string; action: string; primary?: boolean }
  | { type: "list"; items: Array<{ label: string; action: string; selected?: boolean }> }
  | {
      type: "textarea";
      name: string;
      value: string;
      action: string;
      placeholder?: string;
      selectionAction?: string;
      pasteAction?: string;
      dropAction?: string;
    }
  | { type: "canvas"; id: string; width: number; height: number; pointer?: boolean }
  | { type: "diff"; lines: Array<{ op: "same" | "add" | "del"; text: string }> }
  | {
      type: "field";
      name: string;
      label: string;
      kind: "text" | "number" | "checkbox" | "select" | "password";
      value: string | number | boolean;
      action: string;
      options?: string[];
      description?: string;
    };

/** Where a plugin's view goes on a page that has no dedicated \`<slot>\` for it. */
export interface Place {
  at: string;
  put: "before" | "after" | "prepend" | "append" | "replace" | "hide";
  each?: boolean;
  in?: string;
  order?: number;
}

/** Resolved page theme passed to canvas handlers. */
export interface CanvasTheme {
  scheme: "light" | "dark";
  colors: Record<string, string>;
  font: string;
}

/** A hook a plugin defines in its manifest (\`<id>:<key>\`). */
export interface PluginHook {
  mode: "emit" | "waterfall" | "serial" | "bail" | "parallel";
  args?: string;
  description?: string;
  timeoutMs?: number;
  agentTimeoutMs?: number;
  onFailure?: "open" | "closed";
  quiet?: boolean;
}

/** A service a plugin provides to other plugins (\`provides\` in its manifest). */
export interface ProvidedService {
  description: string;
  methods: Record<
    string,
    {
      args?: string;
      returns?: string;
      description: string;
      needs?: string;
      params?: Array<{ name: string; schema: Schema; optional?: boolean }>;
    }
  >;
}

/** Capabilities checked by the kernel's gate. */
export type Capability =
  | ${[...capLiterals, ...capPatterns].join("\n  | ")};

/** Known kernel hooks from the API reference, plus collection and plugin hooks. */
export type KnownHook =
  | ${[...hookNames, "`data:changed:${string}`", "`data:beforeWrite:${string}`", "(string & {})"].join("\n  | ")};

/** A plugin's static manifest (\`export const manifest = { … }\`, first statement of the module). */
export interface Manifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  permissions: Capability[];
  order?: number;
  scope?: "shared" | "tab";
  runs?: "browser" | "server" | "both";
  collections?: Record<string, { title?: string; schema: Schema }>;
  settings?: Record<
    string,
    {
      type: "string" | "number" | "boolean";
      title?: string;
      description?: string;
      default?: unknown;
      enum?: string[];
    }
  >;
  places?: Record<string, Place>;
  files?: string[];
  theme?: Record<string, string>;
  hooks?: Record<string, PluginHook>;
  services?: string[];
  provides?: Record<string, ProvidedService>;
}

/** Handle returned by \`live\` views. */
export interface Live {
  refresh(): void;
  stop(): void;
}

/** Template views loaded from an \`.html\` file beside the plugin. */
export interface Views {
  render(slot: Slot, id: string, data?: unknown, options?: { key?: string; order?: number }): void;
  live(slot: Slot, id: string, compute: (ctx: Api) => unknown, options?: { key?: string; order?: number }): Live;
}

export type RouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRequest {
  method: RouteMethod;
  path: string;
  query: Record<string, string>;
  form?: unknown;
}

export interface RouteResponse {
  status?: number;
  redirect?: string;
  html?: string;
  json?: unknown;
  text?: string;
}

export interface CommandSpec {
  id: string;
  title: string;
  description?: string;
  keys?: string[];
  group?: string;
  args?: Schema;
}

/** Typed service method table generated from the kernel's API reference. */
export interface ServiceCalls {
${serviceInterfaces.join("\n")}
}

/** The \`ctx\` API passed to a sandboxed plugin's default export. */
export interface Api {
  on(name: KnownHook, handler: (this: Api, ...args: any[]) => unknown): () => void;
${callOverloads.join("\n")}
  hooks: {
    emit(key: string, value?: unknown): Promise<void>;
    call<T = unknown>(key: string, value?: unknown): Promise<T>;
  };
  ui: {
    render(slot: Slot, key: string, view: View | string | null, order?: number): void;
    html(strings: TemplateStringsArray, ...values: unknown[]): View;
    live(slot: Slot, key: string, compute: (ctx: Api) => unknown, order?: number): Live;
    views(file: string): Views;
    onEvent(handler: (this: Api, action: string, value: any) => unknown): () => void;
    onCanvas(id: string, handler: (canvas: OffscreenCanvas, theme?: CanvasTheme) => void): void;
    onTheme(handler: (theme: CanvasTheme) => void): () => void;
  };
  settings: {
    get(): Promise<Record<string, any>>;
    onChange(handler: (this: Api, values: Record<string, any>) => void): () => void;
  };
  storage: {
    get<T = any>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<unknown>;
  };
  routes: {
    add(method: RouteMethod, path: string, handler: (this: Api, request: RouteRequest) => RouteResponse | undefined | Promise<RouteResponse | undefined>): () => void;
  };
  schedule: {
    every(name: string, ms: number, handler: () => unknown): () => void;
    at(name: string, when: number, handler: () => unknown): () => void;
    cancel(name: string): Promise<void>;
  };
  commands: {
    add(command: CommandSpec, handler: (this: Api, args: Record<string, any>, about: { by: string }) => unknown): () => void;
  };
  provide(name: string, methods: Record<string, (...args: any[]) => unknown>): () => void;
  traced(): Api;
  log(text: string, level?: "info" | "error"): void;
}

/** Alias for \`Api\`: the \`ctx\` object passed to a plugin's default export. */
export type Ctx = Api;

/** A plugin module's default export signature. */
export type Plugin = (ctx: Api) => void | Promise<void>;

declare global {
  var __extensibleApi: Api;
  var __extensibleManifest: Manifest;
}
`;
}

/** Writes the generated declarations to `outFile` (defaulting to `dist/platform/types.d.ts`). */
export function writeTypes(outFile = join(PLATFORM, "dist", "platform", "types.d.ts"), options = {}) {
  const text = generateTypes(options);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  return { file: outFile, text };
}

/** Writes `.extensible/types.d.ts` inside `project` (respecting any `kernel.json` there). */
export function writeProjectTypes(project, { platform = PLATFORM } = {}) {
  const outFile = join(project, ".extensible", "types.d.ts");
  return writeTypes(outFile, { platform, project });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const outFile = outAt >= 0 && args[outAt + 1] ? resolve(args[outAt + 1]) : join(PLATFORM, "dist", "platform", "types.d.ts");
  const { file, text } = writeTypes(outFile);
  console.log(`Wrote ${relative(process.cwd(), file) || file} (${text.split("\n").length} lines)`);
}
