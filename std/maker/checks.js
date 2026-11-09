// @ts-check
// The checks an app made in the browser gets before and after it runs, so
// the app maker (app-maker.agent.md) can see what is wrong and fix it. They
// are the checks `npm run check` (scripts/check.mjs) makes on an app in a
// checkout, read from the made app's files instead of the disk, with the
// kernel's own manifest reader, capability gate, HTML allowlist and API
// reference handed in, so they can't disagree with what the kernel does.
//
//   page       follows the page rules (sw/made-page.js), loads the platform,
//              and has a <slot> for every slot a plugin draws into
//   plugins    each linked file exists, its manifest reads, ids are unique
//              and not another running plugin's, and every ctx call the
//              code makes is allowed by its permissions
//   views      each ctx.ui.views("x.html") file exists, has the templates
//              the code draws, and uses only HTML the sanitiser keeps
//
// Each problem says what to change, in words a model can act on.

import { pageParts, pageProblems } from "../../sw/made-page.js";

/**
 * @typedef {{ level: "error" | "warning"; file: string; line?: number; message: string }} Problem
 * @typedef {{
 *   readManifest(source: string): { id: string; name: string; permissions: string[]; collections?: Record<string, unknown> };
 *   capabilities(manifest: any): Set<string>;
 *   grants(caps: Set<string>, wanted: string): boolean;
 *   ELEMENTS: Record<string, string>; COMPONENTS: Record<string, unknown>; GLOBAL_ATTRIBUTES: string[];
 *   ELEMENT_ATTRIBUTES: Record<string, string[]>; DROPPED_WITH_CONTENT: Set<string>;
 *   methods: Map<string, string | undefined>; hooks: Map<string, string>;
 *   services: Set<string>;
 *   takenBy(id: string): string | undefined;
 *   collectionOwner(name: string): string | undefined;
 * }} Rules
 */

const lineOf = (/** @type {string} */ text, /** @type {number} */ index) => text.slice(0, index).split("\n").length;

/** The source with comments blanked (`code`), and with the inside of strings blanked too (`bare`), keeping line numbers. @param {string} source */
function scan(source) {
  let code = "";
  let bare = "";
  const blank = (/** @type {string} */ t) => t.replace(/[^\n]/g, " ");
  for (let i = 0; i < source.length; ) {
    const two = source.slice(i, i + 2);
    let end;
    if (two === "//") end = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
    else if (two === "/*") end = source.indexOf("*/", i + 2) === -1 ? source.length : source.indexOf("*/", i + 2) + 2;
    if (end !== undefined) {
      code += blank(source.slice(i, end));
      bare += blank(source.slice(i, end));
      i = end;
      continue;
    }
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && !(c !== "`" && source[j] === "\n")) j += source[j] === "\\" ? 2 : 1;
      const text = source.slice(i, Math.min(j + 1, source.length));
      code += text;
      bare += c + blank(text.slice(1, -1)) + (text.length > 1 ? text.at(-1) : "");
      i = j + 1;
      continue;
    }
    code += c;
    bare += c;
    i++;
  }
  return { code, bare };
}

/**
 * Checks a made app's files without running them.
 * @param {Map<string, string>} files the app's files by name: app.html, x.js, x.html…
 * @param {Rules} rules
 * @returns {{ problems: Problem[]; plugins: { file: string; id: string; name: string }[] }}
 */
export function checkFiles(files, rules) {
  /** @type {Problem[]} */
  const problems = [];
  const report = (/** @type {"error" | "warning"} */ level, /** @type {string} */ file, /** @type {number | undefined} */ line, /** @type {string} */ message) => problems.push({ level, file, ...(line ? { line } : {}), message });
  /** @type {{ file: string; id: string; name: string }[]} */
  const plugins = [];
  const html = files.get("app.html");
  if (html === undefined) {
    report("error", "app.html", undefined, "The app has no app.html yet: write its page first");
    return { problems, plugins };
  }
  for (const p of pageProblems(html)) report("error", "app.html", p.line, p.message);
  const page = pageParts(html);
  if (!page.title) report("warning", "app.html", undefined, "The page has no <title>: give it the app's name");
  if (!page.plugins.length) report("warning", "app.html", undefined, 'The page links no plugins: add <link rel="plugin" href="x.js"> for each');
  const ids = new Map();
  for (const link of page.plugins) {
    if (link.href.startsWith("/")) continue; // a standard plugin, such as /std/board.js: it is checked where it lives
    const name = link.href.replace(/^\.\//, "").replace(/[?#].*$/, "");
    const source = files.get(name);
    if (source === undefined) {
      report("error", "app.html", link.line, `${link.href} doesn't exist: write it, or take out its <link>`);
      continue;
    }
    const plugin = checkPlugin(name, source, files, page.slots, rules, report);
    if (!plugin) continue;
    plugins.push({ file: name, id: plugin.id, name: plugin.name });
    if (ids.has(plugin.id)) report("error", name, 1, `The id "${plugin.id}" is also used by ${ids.get(plugin.id)}: give each plugin its own id`);
    ids.set(plugin.id, name);
  }
  for (const name of files.keys()) {
    if (name.endsWith(".js") && !page.plugins.some((l) => l.href.replace(/^\.\//, "") === name)) report("warning", name, undefined, `${name} isn't linked from app.html, so it doesn't run: add <link rel="plugin" href="${name}">, or remove it`);
  }
  return { problems, plugins };
}

/** The calls a plugin's source makes, as written, and what each needs. */
const USES = [
  { pattern: /\bctx\.routes\.add\(/g, needs: ["routes"], what: "ctx.routes.add" },
  { pattern: /\b(?:fetch\(|new WebSocket\(|new EventSource\()/g, needs: ["network"], what: "fetch" },
  { pattern: /\bctx\.ui\.(?:render|html|live)\(/g, needs: ["ui"], what: "ctx.ui" },
  { pattern: /\bctx\.schedule\.(?:every|at)\(/g, needs: ["schedule"], what: "ctx.schedule" },
];

/**
 * @param {string} file @param {string} source @param {Map<string, string>} files @param {Set<string>} slots @param {Rules} rules
 * @param {(level: "error" | "warning", file: string, line: number | undefined, message: string) => void} report
 */
function checkPlugin(file, source, files, slots, rules, report) {
  let manifest;
  try {
    manifest = rules.readManifest(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report("error", file, Number(/on line (\d+)/.exec(message)?.[1]) || 1, message);
    return undefined;
  }
  const taken = rules.takenBy(manifest.id);
  if (taken) report("error", file, 1, `The id "${manifest.id}" is already used by ${taken}, which is running: give this plugin an id of its own, such as one that starts with the app's name`);
  for (const name of Object.keys(manifest.collections ?? {})) {
    const owner = rules.collectionOwner(name);
    if (owner && owner !== manifest.id) report("error", file, 1, `The ${name} collection already belongs to the plugin "${owner}", so this one can't declare it: name the app's collections after the app, such as "<app>-${name}"`);
  }
  const { code, bare } = scan(source);
  const matches = (/** @type {RegExp} */ pattern) => [...code.matchAll(pattern)].filter((m) => bare.slice(m.index, m.index + 4) === code.slice(m.index, m.index + 4));
  const caps = rules.capabilities(manifest);
  for (const name of Object.keys(manifest.collections ?? {})) {
    caps.add(`data:read:${name}`);
    caps.add(`data:write:${name}`);
    caps.add(`hook:listen:data:changed:${name}`);
  }
  const missing = (/** @type {string[]} */ needs, /** @type {number} */ line, /** @type {string} */ what) => {
    const lacking = needs.filter((need) => !need.includes("<") && !rules.grants(caps, need));
    if (lacking.length) report("error", file, line, `${what} needs ${lacking.map((n) => `"${n}"`).join(" and ")} in the manifest's permissions`);
  };
  for (const use of USES) for (const m of matches(use.pattern)) missing(use.needs, lineOf(code, m.index ?? 0), use.what);

  for (const m of matches(/\bctx\.call\(\s*(["'])([\w-]+)\1\s*,\s*(["'])(\w+)\3(?:\s*,\s*(["'])([\w-]+)\5)?/g)) {
    const [, , service, , method, , arg] = m;
    const line = lineOf(code, m.index ?? 0);
    if (!rules.methods.has(`${service}.${method}`)) {
      report("error", file, line, rules.services.has(service) ? `The ${service} service has no method ${method}` : `There is no ${service} service on this site`);
      continue;
    }
    const needs = rules.methods.get(`${service}.${method}`);
    if (needs) missing([arg ? needs.replace(/<[^>]+>/, arg) : needs], line, `ctx.call("${service}", "${method}"${arg ? `, "${arg}"` : ""})`);
  }
  for (const m of matches(/\bctx\.on\(\s*(["'])([^"']+)\1/g)) {
    const name = m[2];
    const line = lineOf(code, m.index ?? 0);
    const collection = /^data:changed:(.+)$/.exec(name)?.[1];
    if (collection) missing([`hook:listen:data:changed:${collection}`], line, `ctx.on("${name}")`);
    else if (rules.hooks.has(name)) missing([/** @type {string} */ (rules.hooks.get(name))], line, `ctx.on("${name}")`);
  }

  // Views: the template files, the templates the code draws, and the slots it draws into.
  const viewFiles = new Map();
  const bound = new Map();
  for (const m of matches(/\bctx\.ui\.views\(\s*(["'])([^"']+)\1/g)) {
    const path = m[2];
    const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(code.slice(Math.max(0, (m.index ?? 0) - 80), m.index))?.[1];
    if (name) bound.set(name, path);
    if (viewFiles.has(path)) continue;
    const own = path.replace(/^\.\//, "");
    if (path.startsWith("/")) {
      viewFiles.set(path, null);
      continue;
    }
    const text = files.get(own);
    if (text === undefined) {
      report("error", file, lineOf(code, m.index ?? 0), `ctx.ui.views("${path}"): there is no ${own} in the app: write it`);
      viewFiles.set(path, null);
      continue;
    }
    viewFiles.set(path, new Set(checkTemplates(own, text, rules, report)));
  }
  for (const m of matches(/(?:\b([A-Za-z_$][\w$]*)|\))\.(render|live)\(\s*(["'])([\w.-]+)\3(?:\s*,\s*(["'])([\w-]+)\5)?/g)) {
    const [, receiver, how, , slot, , id] = m;
    const line = lineOf(code, m.index ?? 0);
    if (!slots.has(slot) && !slot.includes(".")) report("error", "app.html", undefined, `${file} draws into the slot "${slot}", which app.html doesn't have, so it won't show: add <slot name="${slot}"></slot>`);
    if (receiver === "ui") continue;
    const from = bound.has(receiver) ? [bound.get(receiver)] : [...viewFiles.keys()];
    const known = from.map((path) => viewFiles.get(path)).filter(Boolean);
    if (id && known.length === from.length && from.length && !known.some((ids) => ids.has(id))) report("error", file, line, `There is no <template id="${id}"> in ${from.join(" or ")}`);
    missing(["ui"], line, `views.${how}`);
  }
  return { id: manifest.id, name: manifest.name };
}

/**
 * A template file: <style> for the plugin's own CSS, and <template id> views holding HTML from the allowlist. Returns the template ids.
 * @param {string} file @param {string} raw @param {Rules} rules
 * @param {(level: "error" | "warning", file: string, line: number | undefined, message: string) => void} report
 */
function checkTemplates(file, raw, rules, report) {
  const html = raw.replace(/<!--[^]*?-->|<style\b[^]*?<\/style>/g, (m) => m.replace(/[^\n]/g, " "));
  const ids = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/g)) {
    const tag = m[1].toLowerCase();
    const line = lineOf(html, m.index ?? 0);
    const attributes = [...m[2].matchAll(/([^\s=>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)].map((a) => ({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? "" }));
    if (tag === "template") {
      const id = attributes.find((a) => a.name === "id")?.value;
      if (id) ids.push(id);
      continue;
    }
    const component = tag in rules.COMPONENTS;
    if (rules.DROPPED_WITH_CONTENT.has(tag)) {
      report("error", file, line, `<${tag}> isn't allowed in a view; it is dropped with everything inside it`);
      continue;
    }
    if (!(tag in rules.ELEMENTS) && !component) {
      report("warning", file, line, `<${tag}> isn't on the HTML allowlist, so only its text is kept`);
      continue;
    }
    for (const { name } of attributes) {
      if (name.startsWith("on")) report("error", file, line, `${name}= isn't allowed in a view: use data-action, and ctx.ui.onEvent in the plugin`);
      else if (name === "style") continue;
      else if (!component && !name.startsWith("aria-") && !name.startsWith("data-") && !rules.GLOBAL_ATTRIBUTES.includes(name) && !(rules.ELEMENT_ATTRIBUTES[tag] ?? []).includes(name)) report("warning", file, line, `${name}= isn't allowed on <${tag}>, so it is dropped`);
    }
  }
  return ids;
}
