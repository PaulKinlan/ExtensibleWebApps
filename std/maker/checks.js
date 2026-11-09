// @ts-check
// The checks an app gets before it runs, in one module for both places an
// app is written: `npm run check` (scripts/check.mjs) reads an app's files
// from a checkout, and the app maker (module.ts, maker.check) reads a made
// app's files from the person's data folder. Each hands in how to read a
// file, and the kernel's own manifest reader, capability gate, HTML
// allowlist and API reference, so neither can disagree with what the kernel
// does, or with the other.
//
//   page       loads the platform and links its plugins; a made app's page
//              also follows the page rules (sw/made-page.js)
//   plugins    each linked file exists, its manifest reads, ids are unique
//              and not another running plugin's, and every ctx call the
//              code makes is allowed by its permissions
//   services   a call to a service is checked against what the kernel
//              offers, and what the app's linked plugins provide (their
//              manifests' `provides`): its own, the standard ones, and
//              packages from the registry, such as /packages/clock/clock.js
//   views      each ctx.ui.views("x.html") file exists, has the templates
//              the code draws, and uses only HTML the sanitiser keeps
//   agents     each <link rel="agent"> file reads as the manifest the kernel
//              makes from it, with an id no plugin uses
//
// It reads the source, so it can only follow names written as plain strings:
// ctx.call("data", "put", "library", …) is checked, ctx.call(service, …)
// isn't. Each problem says what to change, in words a person or a model can
// act on.

import { pageParts, pageProblems, tags } from "../../sw/made-page.js";

/**
 * @typedef {{ level: "error" | "warning"; file: string; line?: number; message: string }} Problem
 * @typedef {{
 *   readManifest(source: string): { id: string; name: string; permissions: string[]; collections?: Record<string, unknown>; places?: Record<string, unknown>; provides?: Record<string, any>; runs?: string };
 *   capabilities(manifest: any): Set<string>;
 *   grants(caps: Set<string>, wanted: string): boolean;
 *   ELEMENTS: Record<string, string>; COMPONENTS: Record<string, unknown>; GLOBAL_ATTRIBUTES: string[];
 *   ELEMENT_ATTRIBUTES: Record<string, string[]>; DROPPED_WITH_CONTENT: Set<string>; INPUT_TYPES?: string[];
 *   SVG_ELEMENTS?: Record<string, string>; SVG_ATTRIBUTES?: string[];
 *   methods: Map<string, string | string[] | undefined>; hooks: Map<string, string>;
 *   services?: Set<string>;
 *   takenBy?(id: string): string | undefined;
 *   collectionOwner?(name: string): string | undefined;
 *   fromAgentFile?(text: string, runner?: string): string;
 *   runnerName?(text: string): string | undefined;
 *   DEFAULT_RUNNER?: string;
 * }} Rules
 *
 * An app, as the checks read it. Files are named by a key the app picks (a path on disk, or on the site).
 * @typedef {{
 *   page: string;
 *   read(key: string): string | undefined;
 *   resolve(href: string, from: string): string | undefined;
 *   label(key: string): string;
 *   own(key: string): boolean;
 *   made?: boolean;
 *   files?: string[];
 * }} App
 *   page     the key of the app's app.html
 *   read     a file's text, or undefined if there is no such file
 *   resolve  the key of a link from a file, or undefined for one on another site, which isn't checked
 *   label    how a problem names a file
 *   own      true for the app's own files, which are checked in full; a file elsewhere on the site (a
 *            standard plugin, a package) is checked where it lives, and read here only for what it provides
 *   made     a made app: its page follows the page rules, and every problem is one the app maker must fix
 *   files    a made app's own files, so one no page links can be pointed out
 */

const lineOf = (/** @type {string} */ text, /** @type {number} */ index) => text.slice(0, index).split("\n").length;
const rels = (/** @type {Record<string, string>} */ attributes) => (attributes.rel ?? "").toLowerCase().split(/\s+/);
const OTHER_SITE = /^[a-z][\w+.-]*:/i;

/**
 * The source with comments blanked (`code`), and with the inside of strings blanked too (`bare`), keeping
 * line numbers. A call is only real where `bare` still has it, so `"//"` in a string or `fetch()` in a
 * description is not mistaken for code. Regular expressions are rare in plugins and aren't tracked.
 * @param {string} source
 */
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

/** What a method needs, as a list: the reference on disk lists several, the kernel's description names one. @param {string | string[] | undefined} needs */
const needsOf = (needs) => (needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]);

/**
 * Checks an app without running it.
 * @param {App} app @param {Rules} rules
 * @returns {{ problems: Problem[]; plugins: { file: string; id: string; name: string }[] }}
 */
export function checkApp(app, rules) {
  /** @type {Problem[]} */
  const problems = [];
  const report = (/** @type {"error" | "warning"} */ level, /** @type {string} */ key, /** @type {number | undefined} */ line, /** @type {string} */ message) =>
    problems.push({ level, file: app.label(key), ...(line ? { line } : {}), message });
  /** @type {{ file: string; id: string; name: string }[]} */
  const plugins = [];
  const raw = app.read(app.page);
  if (raw === undefined) {
    report("error", app.page, undefined, app.made ? "The app has no app.html yet: write its page first" : "There is no app.html here");
    return { problems, plugins };
  }
  const { tags: all } = tags(raw);
  const open = all.filter((t) => !t.closing);
  const links = open.filter((t) => t.name === "link");
  const slots = new Set(open.filter((t) => t.name === "slot" && t.attributes.name).map((t) => t.attributes.name));

  if (app.made) {
    for (const p of pageProblems(raw)) report("error", app.page, p.line, p.message);
    if (!pageParts(raw).title) report("warning", app.page, undefined, "The page has no <title>: give it the app's name");
    if (!links.some((t) => rels(t.attributes).includes("plugin"))) report("warning", app.page, undefined, 'The page links no plugins: add <link rel="plugin" href="x.js"> for each');
  } else {
    const host = open.find((t) => t.name === "script" && t.attributes.src === "/platform/host.js");
    if (!host) report("error", app.page, undefined, 'app.html doesn\'t load the platform: add <script type="module" src="/platform/host.js"></script> to the head');
    else if (host.attributes.type !== "module") report("error", app.page, host.line, 'The platform\'s script is a module: write <script type="module" src="/platform/host.js">');
    if (!links.some((t) => rels(t.attributes).includes("stylesheet") && t.attributes.href === "/platform/host.css")) report("warning", app.page, undefined, 'app.html doesn\'t link the platform\'s styles: add <link rel="stylesheet" href="/platform/host.css">');
    // No plugins is fine: an app can be plain HTML that people extend with their own (see demos/trip).
  }

  // Every linked plugin, with where its file is: undefined for another site's.
  const linked = links
    .filter((t) => rels(t.attributes).includes("plugin"))
    .map((t) => ({ href: t.attributes.href ?? "", line: t.line, key: t.attributes.href ? app.resolve(t.attributes.href, app.page) : undefined }));

  // A service the app's linked plugins provide is there for the others, as the kernel has it once that plugin
  // runs: calling it needs what its method says, or the permission named after it (provided.ts). That holds
  // for the app's own plugins, standard ones and packages from the registry alike.
  rules = withProvided(rules, linked.flatMap((l) => (l.key === undefined ? [] : [app.read(l.key)]).filter((s) => s !== undefined)));

  const ids = new Map();
  const claim = (/** @type {string} */ id, /** @type {string} */ key) => {
    if (ids.has(id)) report("error", key, 1, `The id "${id}" is also used by ${ids.get(id)}: give each plugin its own id, or the second replaces the first`);
    ids.set(id, app.label(key));
  };
  for (const link of linked) {
    if (!link.href) {
      report("error", app.page, link.line, '<link rel="plugin"> has no href');
      continue;
    }
    if (link.key === undefined) {
      report("warning", app.page, link.line, `${link.href} is on another site, so it isn't checked`);
      continue;
    }
    const source = app.read(link.key);
    if (source === undefined) {
      report("error", app.page, link.line, `${link.href} doesn't exist${app.own(link.key) ? ": write it, or take out its <link>" : " on this site: take out its <link>, or link one that does"}`);
      continue;
    }
    if (!app.own(link.key)) {
      // Checked where it lives; here it only needs to be a plugin, with an id the app's own plugins don't use.
      try {
        const manifest = rules.readManifest(source);
        claim(manifest.id, link.key);
        plugins.push({ file: app.label(link.key), id: manifest.id, name: manifest.name });
      } catch (error) {
        report("error", app.page, link.line, `${link.href} isn't a plugin on this site (${error instanceof Error ? error.message : String(error)}): take out its <link>, or link one that is`);
      }
      continue;
    }
    const plugin = checkPlugin(app, link.key, source, slots, rules, report);
    if (!plugin) continue;
    plugins.push({ file: app.label(link.key), id: plugin.id, name: plugin.name });
    claim(plugin.id, link.key);
  }

  // Agents: Markdown files the kernel turns into plugins, read the same way.
  if (rules.fromAgentFile && rules.runnerName) {
    for (const link of links.filter((t) => rels(t.attributes).includes("agent"))) {
      const href = link.attributes.href;
      const key = href ? app.resolve(href, app.page) : undefined;
      const text = key === undefined ? undefined : app.read(key);
      if (key === undefined || text === undefined) {
        report("error", app.page, link.line, href ? `${href} doesn't exist` : '<link rel="agent"> has no href');
        continue;
      }
      if (!/\.agent\.md$/i.test((href ?? "").replace(/[?#].*$/, ""))) report("error", app.page, link.line, `${href}: an agent file's name ends in .agent.md, or the kernel reads it as a plugin`);
      let manifest;
      try {
        // The agent loop it runs, from the frontmatter's `runner:` (next to the agent file) or the standard one.
        const named = rules.runnerName(text) ?? rules.DEFAULT_RUNNER ?? "/std/agents/runner.js";
        const loop = OTHER_SITE.test(named) ? undefined : app.resolve(named, key);
        const loopText = loop === undefined ? undefined : app.read(loop);
        if (loop === undefined) report("warning", key, 1, `Its agent loop ${named} is on another site, so it isn't checked here`);
        else if (loopText === undefined && app.own(key)) throw new Error(`Its agent loop ${named} doesn't exist`);
        manifest = rules.readManifest(rules.fromAgentFile(text, loopText ?? "// elsewhere"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (app.own(key)) report("error", key, Number(/Line (\d+)/.exec(message)?.[1]) || 1, message);
        continue;
      }
      plugins.push({ file: app.label(key), id: manifest.id, name: manifest.name });
      claim(manifest.id, key);
    }
  }

  // A made app's own script that no page links doesn't run.
  for (const key of app.files ?? []) {
    if (key.endsWith(".js") && !linked.some((l) => l.key === key)) {
      const name = app.label(key);
      report("warning", key, undefined, `${name} isn't linked from app.html, so it doesn't run: add <link rel="plugin" href="${name}">, or remove it`);
    }
  }
  problems.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
  return { problems, plugins };
}

/**
 * The rules, with the services that plugins provide (their manifests' `provides`) added to the ones the
 * kernel has. A plugin whose manifest can't be read adds none; its own check says why.
 * @param {Rules} rules @param {string[]} sources @returns {Rules}
 */
function withProvided(rules, sources) {
  const services = new Set(rules.services ?? [...rules.methods.keys()].map((k) => k.split(".")[0]));
  const methods = new Map(rules.methods);
  for (const source of sources) {
    let manifest;
    try {
      manifest = rules.readManifest(source);
    } catch {
      continue;
    }
    // A provider that runs only on a space's server isn't there for the app's plugins in the browser.
    if (manifest.runs === "server") continue;
    for (const [name, spec] of Object.entries(manifest.provides ?? {})) {
      if (rules.services?.has(name)) continue;
      services.add(name);
      // As the kernel does (provided.ts): a method needs what it says, or the permission named after the service.
      for (const [method, doc] of Object.entries(spec?.methods ?? {})) methods.set(`${name}.${method}`, doc?.needs ?? name);
    }
  }
  return { ...rules, services, methods };
}

/** The calls a plugin's source makes, as written, and what each needs. */
const USES = [
  { pattern: /\bctx\.routes\.add\(/g, needs: ["routes"], what: () => "ctx.routes.add" },
  { pattern: /\b(?:fetch\(|new WebSocket\(|new EventSource\()/g, needs: ["network"], what: (/** @type {RegExpMatchArray} */ m) => m[0].replace("(", "") },
  { pattern: /\bctx\.ui\.(?:render|html|live)\(/g, needs: ["ui"], what: (/** @type {RegExpMatchArray} */ m) => m[0].slice(0, -1) },
  { pattern: /\bctx\.schedule\.(?:every|at)\(/g, needs: ["schedule"], what: (/** @type {RegExpMatchArray} */ m) => m[0].slice(0, -1) },
];

/**
 * @param {App} app @param {string} key @param {string} source @param {Set<string>} slots @param {Rules} rules
 * @param {(level: "error" | "warning", key: string, line: number | undefined, message: string) => void} report
 */
function checkPlugin(app, key, source, slots, rules, report) {
  let manifest;
  try {
    manifest = rules.readManifest(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report("error", key, Number(/on line (\d+)/.exec(message)?.[1]) || 1, message);
    return undefined;
  }
  const taken = rules.takenBy?.(manifest.id);
  if (taken) report("error", key, 1, `The id "${manifest.id}" is already used by ${taken}, which is running: give this plugin an id of its own, such as one that starts with the app's name`);
  for (const name of Object.keys(manifest.collections ?? {})) {
    const owner = rules.collectionOwner?.(name);
    if (owner && owner !== manifest.id) report("error", key, 1, `The ${name} collection already belongs to the plugin "${owner}", so this one can't declare it: name the app's collections after the app, such as "<app>-${name}"`);
  }
  // Comments blanked, so an example in one isn't read as a call; a match only counts where it isn't inside a string.
  const { code, bare } = scan(source);
  const matches = (/** @type {RegExp} */ pattern) => [...code.matchAll(pattern)].filter((m) => bare.slice(m.index, (m.index ?? 0) + 4) === code.slice(m.index, (m.index ?? 0) + 4));
  const caps = rules.capabilities(manifest);
  for (const name of Object.keys(manifest.collections ?? {})) {
    caps.add(`data:read:${name}`);
    caps.add(`data:write:${name}`);
    caps.add(`hook:listen:data:changed:${name}`);
  }
  const missing = (/** @type {string[]} */ needs, /** @type {number} */ line, /** @type {string} */ what) => {
    const lacking = needs.filter((need) => !need.includes("<") && !rules.grants(caps, need));
    if (lacking.length) report("error", key, line, `${what} needs ${lacking.map((n) => `"${n}"`).join(" and ")} in the manifest's permissions`);
  };
  for (const use of USES) for (const m of matches(use.pattern)) missing(use.needs, lineOf(code, m.index ?? 0), use.what(m));

  // ctx.call("service", "method", "collection"?): the reference says what each method needs.
  for (const m of matches(/\bctx\.call\(\s*(["'])([\w-]+)\1\s*,\s*(["'])(\w+)\3(?:\s*,\s*(["'])([\w-]+)\5)?/g)) {
    const [, , service, , method, , arg] = m;
    const line = lineOf(code, m.index ?? 0);
    if (!rules.methods.has(`${service}.${method}`)) {
      report("error", key, line, `There is no ${service}.${method}: ${rules.services?.has(service) ? `the ${service} service has no method ${method}` : `there is no ${service} service on this site`} (the services are in docs/api.md)`);
      continue;
    }
    missing(needsOf(rules.methods.get(`${service}.${method}`)).map((n) => (arg ? n.replace(/<[^>]+>/, arg) : n)), line, `ctx.call("${service}", "${method}"${arg ? `, "${arg}"` : ""})`);
  }

  // ctx.on("hook"): a documented hook needs what the reference says; a collection's change needs reading it.
  for (const m of matches(/\bctx\.on\(\s*(["'])([^"']+)\1/g)) {
    const name = m[2];
    const line = lineOf(code, m.index ?? 0);
    if (/^route:/.test(name)) continue; // routes are checked as ctx.routes.add
    const collection = /^data:changed:(.+)$/.exec(name)?.[1];
    if (collection) missing([`hook:listen:data:changed:${collection}`], line, `ctx.on("${name}")`);
    else if (rules.hooks.has(name)) missing([/** @type {string} */ (rules.hooks.get(name))], line, `ctx.on("${name}")`);
  }

  // Views: the template files, the templates the code draws, and the slots it draws into.
  // `const views = ctx.ui.views("x.html")` binds a name to one file; views.render draws only from that file.
  /** @type {Map<string, Set<string> | null>} */
  const viewFiles = new Map(); // view file path as written → its template ids, or null if it's missing
  const bound = new Map(); // variable name → view file path as written
  for (const m of matches(/\bctx\.ui\.views\(\s*(["'])([^"']+)\1/g)) {
    const path = m[2];
    const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(code.slice(Math.max(0, (m.index ?? 0) - 80), m.index))?.[1];
    if (name) bound.set(name, path);
    if (viewFiles.has(path)) continue;
    const viewKey = app.resolve(path.replace(/[?#].*$/, ""), key);
    const text = viewKey === undefined ? undefined : app.read(viewKey);
    if (viewKey === undefined || text === undefined) {
      // A made app's view elsewhere on the site isn't read here: it is checked where it lives.
      if (viewKey !== undefined && !app.own(viewKey) && app.made) viewFiles.set(path, null);
      else {
        report("error", key, lineOf(code, m.index ?? 0), `ctx.ui.views("${path}"): there is no ${viewKey === undefined ? path : app.label(viewKey)}${app.made ? " in the app: write it" : ""}`);
        viewFiles.set(path, null);
      }
      continue;
    }
    viewFiles.set(path, new Set(checkTemplates(viewKey, text, rules, report)));
  }
  const places = new Set(Object.keys(manifest.places ?? {}));
  for (const m of matches(/(?:\b([A-Za-z_$][\w$]*)|\))\.(render|live|html)\(\s*(["'])([\w.-]+)\3(?:\s*,\s*(["'])([\w-]+)\5)?/g)) {
    const [, receiver, how, , slot, , id] = m;
    const line = lineOf(code, m.index ?? 0);
    // A dotted name is another plugin's slot, and a place is put by its manifest, not by a <slot>.
    if (!slots.has(slot) && !slot.includes(".") && !places.has(slot)) report(app.made ? "error" : "warning", key, line, `Draws into the slot "${slot}", which app.html doesn't have, so it won't show: add <slot name="${slot}"></slot>`);
    if (receiver === "ui" || how === "html") continue; // ctx.ui.render and ctx.ui.live take a view, not a template
    // The file this receiver draws from, or every file if the code doesn't say which.
    const from = bound.has(receiver) ? [bound.get(receiver)] : [...viewFiles.keys()];
    const known = from.map((path) => viewFiles.get(path)).filter((ids) => !!ids);
    if (id && known.length === from.length && from.length && !known.some((ids) => ids.has(id))) report("error", key, line, `There is no <template id="${id}"> in ${from.join(" or ")}`);
    missing(["ui"], line, `views.${how}`);
  }
  return { id: manifest.id, name: manifest.name };
}

/**
 * A template file: <style> for the plugin's own CSS, and <template id> views holding plain HTML from the
 * allowlist. Returns the template ids.
 * @param {string} key @param {string} raw @param {Rules} rules
 * @param {(level: "error" | "warning", key: string, line: number | undefined, message: string) => void} report
 */
function checkTemplates(key, raw, rules, report) {
  // Blank out comments and <style> blocks, keeping offsets, so line numbers stay true.
  const html = raw.replace(/<!--[^]*?-->|<style\b[^]*?<\/style>/g, (m) => m.replace(/[^\n]/g, " "));
  const ids = [];
  // How many <svg> elements the scan is inside: their content is checked against the SVG list, and an SVG shape outside one is not SVG.
  let svgDepth = 0;
  const svgTags = new Set(Object.keys(rules.SVG_ELEMENTS ?? {}).map((t) => t.toLowerCase()));
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (tag === "svg" && svgDepth > 0) svgDepth--;
      continue;
    }
    const line = lineOf(html, m.index ?? 0);
    const attributes = [...m[3].matchAll(/([^\s=>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)].map((a) => ({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? "" }));
    if (tag === "template") {
      const id = attributes.find((a) => a.name === "id")?.value;
      if (id) ids.push(id);
      continue;
    }
    const component = tag in rules.COMPONENTS;
    // Inside an <svg>, shapes and their attributes come from the SVG list (src/shared/svg.ts). Names are compared
    // without case, as this reads tags lowercased.
    if (svgDepth > 0 && tag !== "template" && !svgTags.has(tag)) {
      report("error", key, line, `<${tag}> isn't on the SVG list, so it is dropped from the <svg> with everything inside it (see "SVG in views" in docs/api.md)`);
      continue;
    }
    if (rules.SVG_ELEMENTS && (tag === "svg" || svgDepth > 0)) {
      if (tag === "svg" && !m[4]) svgDepth++;
      const svgAttributes = new Set([...(rules.SVG_ATTRIBUTES ?? []), ...rules.GLOBAL_ATTRIBUTES, "id", "style", "xmlns"].map((a) => a.toLowerCase()));
      for (const { name, value } of attributes) {
        if (name.startsWith("on")) report("error", key, line, `${name}= isn't allowed in a view: use data-action for events, and ctx.ui.onEvent in the plugin`);
        else if (!name.startsWith("aria-") && !name.startsWith("data-") && !svgAttributes.has(name)) report("warning", key, line, `${name}= isn't allowed on <${tag}>, so it is dropped`);
        else if ((name === "href" || /url\s*\(/i.test(value)) && !value.includes("{{") && !/^\s*(#[\w-]+|url\(\s*#[\w-]+\s*\))\s*$/i.test(value)) report("warning", key, line, `${name}="${value}" is dropped: in an <svg>, href and url() may only name an #id in the same view`);
      }
      continue;
    }
    if (rules.DROPPED_WITH_CONTENT.has(tag)) {
      report("error", key, line, `<${tag}> isn't allowed in a view; it is dropped with everything inside it`);
      continue;
    }
    if (!(tag in rules.ELEMENTS) && !component) {
      report("warning", key, line, `<${tag}> isn't on the HTML allowlist, so only its text is kept (see "HTML views" in docs/api.md)`);
      continue;
    }
    for (const { name, value } of attributes) {
      const hole = value.includes("{{");
      if (name === "style") {
        // Only custom properties set to numbers are kept (src/host/sanitize.ts); a {{hole}} must fill in a number.
        // The same rules as the sanitizer's: name, number, unit, and at most eight declarations.
        const declarations = value.split(";").filter((d) => d.trim());
        const bad = declarations.filter((d) => !/^\s*--[a-z][a-z0-9-]{0,31}\s*:\s*(\{\{[^}]+\}\}|-?(\d{1,6}(\.\d{1,4})?|\.\d{1,4}))(px|rem|em|ch|%|vh|vw|deg|turn|s|ms|fr)?\s*$/i.test(d));
        if (bad.length) report("error", key, line, `style= keeps only custom properties set to numbers, such as style="--pct: {{pct}}"; use class with the file's <style> for looks (dropped: ${bad.map((d) => d.trim()).join("; ")})`);
        else if (declarations.length > 8) report("error", key, line, `style= keeps at most 8 custom properties, so the rest are dropped`);
      } else if (name.startsWith("on")) report("error", key, line, `${name}= isn't allowed in a view: use data-action for events, and ctx.ui.onEvent in the plugin`);
      else if (name === "slot" || name === "is" || name === "data-plugin") report("warning", key, line, `${name}= is dropped from views`);
      else if (!component && !name.startsWith("aria-") && !name.startsWith("data-") && !rules.GLOBAL_ATTRIBUTES.includes(name) && !(rules.ELEMENT_ATTRIBUTES[tag] ?? []).includes(name)) report("warning", key, line, `${name}= isn't allowed on <${tag}>, so it is dropped`);
      else if (name === "href" && !hole && /^([a-z][\w+.-]*:|\/\/|\\)/i.test(value.trim()) && !/^(https?:|mailto:)/i.test(value.trim())) report("warning", key, line, `href="${value}" is dropped: a link in a view must start with https:, http:, mailto: or #, or be relative`);
      else if (tag === "input" && name === "type" && !hole && rules.INPUT_TYPES && !rules.INPUT_TYPES.includes(value.toLowerCase())) report("warning", key, line, `<input type="${value}"> isn't allowed, so it becomes a text box`);
    }
  }
  return ids;
}

// ---- A made app ----

/** Where a made app's own files are on the site. @param {string} app */
const folderOf = (app) => `/apps/${app}/`;

/** The path on the site a link from one of a made app's files points to, or undefined for another site. @param {string} href @param {string} from */
function sitePath(href, from) {
  const url = new URL(href, `http://site${from}`);
  if (url.origin !== "http://site") return undefined;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/**
 * The files elsewhere on the site that a made app's checks read: the plugins and agents its page links that
 * aren't its own (standard plugins, packages from the registry), and the agent loops its own agents run.
 * The caller fetches them and hands them to checkFiles as `site`; one it couldn't fetch is left out, and
 * counts as missing.
 * @param {Map<string, string>} files @param {string} app @param {Rules} [rules]
 * @returns {string[]}
 */
export function siteFiles(files, app, rules) {
  const folder = folderOf(app);
  const html = files.get("app.html");
  if (html === undefined) return [];
  const page = `${folder}app.html`;
  const out = new Set();
  const { tags: all } = tags(html);
  for (const t of all) {
    if (t.closing || t.name !== "link" || !t.attributes.href) continue;
    const kind = rels(t.attributes);
    if (!kind.includes("plugin") && !kind.includes("agent")) continue;
    const path = sitePath(t.attributes.href, page);
    if (path === undefined) continue;
    if (!path.startsWith(folder)) out.add(path);
    else if (kind.includes("agent") && rules?.runnerName) {
      const text = files.get(path.slice(folder.length));
      const loop = text === undefined ? undefined : sitePath(rules.runnerName(text) ?? rules.DEFAULT_RUNNER ?? "/std/agents/runner.js", path);
      if (loop !== undefined && !loop.startsWith(folder)) out.add(loop);
    }
  }
  return [...out];
}

/**
 * Checks a made app's files without running them.
 * @param {Map<string, string>} files the app's files by name: app.html, x.js, x.html…
 * @param {Rules} rules
 * @param {string} app the app's name: a link to /apps/<app>/x.js is its own file, like x.js
 * @param {Map<string, string>} [site] files elsewhere on the site it links, by path (siteFiles says which)
 * @returns {{ problems: Problem[]; plugins: { file: string; id: string; name: string }[] }}
 */
export function checkFiles(files, rules, app, site = new Map()) {
  const folder = folderOf(app);
  const own = (/** @type {string} */ key) => key.startsWith(folder);
  const { problems, plugins } = checkApp(
    {
      page: `${folder}app.html`,
      made: true,
      read: (key) => (own(key) ? files.get(key.slice(folder.length)) : site.get(key)),
      resolve: sitePath,
      label: (key) => (own(key) ? key.slice(folder.length) : key),
      own,
      files: [...files.keys()].map((name) => folder + name),
    },
    rules,
  );
  // The app's own plugins: the ones elsewhere on the site are checked, and run, where they live. Its agents
  // are left out too: what runs is the plugin the kernel makes from the file, so the running check (module.ts)
  // can't compare it with the file, as it does a plugin's.
  return { problems, plugins: plugins.filter((p) => !p.file.startsWith("/") && !p.file.endsWith(".agent.md")) };
}
