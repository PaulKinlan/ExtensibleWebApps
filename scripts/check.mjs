// Checks apps and their plugins without opening a browser, and says what to
// fix: the mistakes the kernel would otherwise only report at run time, in
// the trace. It reads the files as written, so it needs no build.
//
//   npm run check                    every app in demos/
//   npm run check demos/habits       one app (a folder with an app.html, or the file)
//   npm run check -- --json          the same, as JSON, for tools and agents
//
// What it checks, for each app:
//   app.html   loads the platform, links at least one plugin, and has a
//              <slot> for every slot a plugin draws into
//   plugins    the manifest is the first statement and a plain literal, ids
//              are unique, and every ctx call the code makes is allowed by
//              `permissions` (read from the same tables as docs/api.md)
//   views      each ctx.ui.views("x.html") file exists, has the templates the
//              code draws, and uses only HTML the sanitiser keeps
//
// It reads the source, so it can only follow names written as plain strings:
// ctx.call("data", "put", "library", …) is checked, ctx.call(service, …) isn't.
// It exits with 1 if there is any error; warnings alone don't fail it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The kernel's own manifest reader, capability gate and HTML allowlist,
// bundled from src/ so this script can never disagree with them.
async function loadKernelRules() {
  const entry = [
    'export { readManifest } from "./src/kernel/manifest.ts";',
    'export { capabilities, grants } from "./src/kernel/gate.ts";',
    'export * from "./src/shared/html.ts";',
  ].join("\n");
  const out = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

// What each service method and hook needs, read from docs/api.md, which the
// kernel writes (and the tests keep up to date).
function loadReference() {
  const md = readFileSync(join(ROOT, "docs/api.md"), "utf8");
  const methods = new Map();
  for (const m of md.matchAll(/^#### (\w+)\.(\w+)\n[^]*?^Needs: (.*)$/gm)) {
    const needs = [...m[3].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    methods.set(`${m[1]}.${m[2]}`, needs);
  }
  const hooks = new Map();
  for (const m of md.matchAll(/^### `([^`]+)`\n[^]*?Listening needs `?([^`.\s]+)`?/gm)) hooks.set(m[1], m[2]);
  return { methods, hooks };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const rel = (file) => relative(ROOT, file) || ".";

export async function checkApps(targets) {
  const rules = await loadKernelRules();
  const reference = loadReference();
  const apps = targets.length ? targets.map(appFile) : demoApps();
  return apps.map((file) => checkApp(file, rules, reference));
}

function demoApps() {
  const demos = join(ROOT, "demos");
  return readdirSync(demos)
    .map((name) => join(demos, name, "app.html"))
    .filter((file) => existsSync(file))
    .sort();
}

function appFile(target) {
  const path = resolve(target);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, "app.html") : path;
}

function checkApp(file, rules, reference) {
  const problems = [];
  const report = (level, where, line, message) => problems.push({ level, file: rel(where), ...(line && { line }), message });
  const app = { app: rel(dirname(file)), plugins: [], problems };
  if (!existsSync(file)) {
    report("error", file, 0, "There is no app.html here");
    return app;
  }
  // Comments are blanked out (keeping line numbers), so a <link> in one isn't read as a plugin.
  const html = readFileSync(file, "utf8").replace(/<!--[^]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  if (!/<script[^>]*src="\/platform\/host\.js"/.test(html)) report("error", file, 0, 'app.html doesn\'t load the platform: add <script type="module" src="/platform/host.js"></script> to the head');
  if (!/<link[^>]*href="\/platform\/host\.css"/.test(html)) report("warning", file, 0, 'app.html doesn\'t link the platform\'s styles: add <link rel="stylesheet" href="/platform/host.css">');
  const slots = new Set([...html.matchAll(/<slot\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]));
  const links = [...html.matchAll(/<link\b[^>]*\brel="plugin"[^>]*>/g)].map((m) => ({ tag: m[0], line: lineOf(html, m.index) }));
  if (!links.length) report("warning", file, 0, 'app.html links no plugins: add <link rel="plugin" href="my-plugin.js">');

  const ids = new Map();
  for (const link of links) {
    const href = /\bhref="([^"]+)"/.exec(link.tag)?.[1];
    if (!href) {
      report("error", file, link.line, '<link rel="plugin"> has no href');
      continue;
    }
    if (/^[a-z]+:/i.test(href)) {
      report("warning", file, link.line, `${href} is on another site, so it isn't checked`);
      continue;
    }
    const pluginFile = href.startsWith("/") ? join(ROOT, href) : join(dirname(file), href);
    if (!existsSync(pluginFile)) {
      report("error", file, link.line, `${href} doesn't exist`);
      continue;
    }
    const plugin = checkPlugin(pluginFile, rules, reference, report);
    if (!plugin) continue;
    app.plugins.push(plugin.id);
    if (ids.has(plugin.id)) report("error", pluginFile, 1, `The id "${plugin.id}" is also used by ${ids.get(plugin.id)}; the second replaces the first`);
    ids.set(plugin.id, rel(pluginFile));
    for (const { slot, line } of plugin.slots) {
      if (!slots.has(slot)) report("warning", pluginFile, line, `Draws into the slot "${slot}", which app.html doesn't have, so it won't show: add <slot name="${slot}"></slot>`);
    }
  }
  problems.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
  return app;
}

// The calls a plugin's source makes, as written. Each pattern finds one kind
// of call; `needs` says what the call requires, given its match.
const USES = [
  { pattern: /\bctx\.routes\.add\(/g, needs: () => ["routes"], what: () => "ctx.routes.add" },
  { pattern: /\b(?:fetch\(|new WebSocket\(|new EventSource\()/g, needs: () => ["network"], what: (m) => m[0].replace("(", "") },
  { pattern: /\bctx\.ui\.(?:render|html|live)\(/g, needs: () => ["ui"], what: (m) => m[0].slice(0, -1) },
];

function checkPlugin(file, rules, reference, report) {
  const source = readFileSync(file, "utf8");
  let manifest;
  try {
    manifest = rules.readManifest(source);
  } catch (error) {
    const line = Number(/on line (\d+)/.exec(error.message)?.[1]) || 1;
    report("error", file, line, error.message);
    return undefined;
  }
  // The code, with comments blanked out (keeping line numbers), so an example in a comment isn't read as a call.
  const code = source.replace(/\/\*[^]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, lead = "") => lead + m.slice(lead.length).replace(/[^\n]/g, " "));
  const caps = rules.capabilities(manifest);
  for (const name of Object.keys(manifest.collections ?? {})) {
    caps.add(`data:read:${name}`);
    caps.add(`data:write:${name}`);
    caps.add(`hook:listen:data:changed:${name}`);
  }
  const missing = (needs, line, what) => {
    const lacking = needs.filter((need) => !need.includes("<") && !rules.grants(caps, need));
    if (lacking.length) report("error", file, line, `${what} needs ${lacking.map((n) => `"${n}"`).join(" and ")} in the manifest's permissions`);
  };

  for (const use of USES) for (const m of code.matchAll(use.pattern)) missing(use.needs(m), lineOf(code, m.index), use.what(m));

  // ctx.call("service", "method", "collection"?): the reference says what each method needs.
  for (const m of code.matchAll(/\bctx\.call\(\s*(["'])(\w+)\1\s*,\s*(["'])(\w+)\3(?:\s*,\s*(["'])([\w-]+)\5)?/g)) {
    const [, , service, , method, , arg] = m;
    const line = lineOf(code, m.index);
    const needs = reference.methods.get(`${service}.${method}`);
    if (!needs) {
      report("error", file, line, `There is no ${service}.${method}; see docs/api.md for the services`);
      continue;
    }
    missing(needs.map((n) => (arg ? n.replace(/<[^>]+>/, arg) : n)), line, `ctx.call("${service}", "${method}"${arg ? `, "${arg}"` : ""})`);
  }

  // ctx.on("hook"): a documented hook needs what the reference says; a collection's change needs reading it.
  for (const m of code.matchAll(/\bctx\.on\(\s*(["'])([^"']+)\1/g)) {
    const name = m[2];
    const line = lineOf(code, m.index);
    if (/^route:/.test(name)) continue; // routes are checked as ctx.routes.add
    const collection = /^data:changed:(.+)$/.exec(name)?.[1];
    if (collection) missing([`hook:listen:data:changed:${collection}`], line, `ctx.on("${name}")`);
    else if (reference.hooks.has(name)) missing([reference.hooks.get(name)], line, `ctx.on("${name}")`);
  }

  // Views: the template files, the templates the code draws, and the slots it draws into.
  const templates = new Map();
  const viewFiles = [...code.matchAll(/\bctx\.ui\.views\(\s*(["'])([^"']+)\1/g)];
  for (const m of viewFiles) {
    const viewFile = join(dirname(file), m[2]);
    if (!existsSync(viewFile)) {
      report("error", file, lineOf(code, m.index), `ctx.ui.views("${m[2]}"): there is no ${rel(viewFile)}`);
      continue;
    }
    for (const id of checkTemplates(viewFile, rules, report)) templates.set(id, viewFile);
  }
  const slots = [];
  for (const m of code.matchAll(/\.(render|live|html)\(\s*(["'])([\w-]+)\2(?:\s*,\s*(["'])([\w-]+)\4)?/g)) {
    const [, how, , slot, , id] = m;
    const line = lineOf(code, m.index);
    slots.push({ slot, line });
    const viaViews = !code.slice(Math.max(0, m.index - 6), m.index).endsWith("ctx.ui");
    if (viaViews && how !== "html" && id && viewFiles.length && !templates.has(id)) report("error", file, line, `There is no <template id="${id}"> in ${viewFiles.map((v) => v[2]).join(" or ")}`);
    if (viaViews && how !== "html") missing(["ui"], line, `views.${how}`);
  }
  return { id: manifest.id, slots };
}

// A template file: <style> for the plugin's own CSS, and <template id> views
// holding plain HTML from the allowlist. Returns the template ids.
function checkTemplates(file, rules, report) {
  const raw = readFileSync(file, "utf8");
  // Blank out comments and <style> blocks, keeping offsets, so line numbers stay true.
  const html = raw.replace(/<!--[^]*?-->|<style\b[^]*?<\/style>/g, (m) => m.replace(/[^\n]/g, " "));
  const ids = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/g)) {
    const tag = m[1].toLowerCase();
    const line = lineOf(html, m.index);
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
      report("warning", file, line, `<${tag}> isn't on the HTML allowlist, so only its text is kept (see "HTML views" in docs/api.md)`);
      continue;
    }
    for (const { name, value } of attributes) {
      const hole = value.includes("{{");
      if (name.startsWith("on") || name === "style") report("error", file, line, `${name}= isn't allowed in a view: use data-action for events, and class with the file's <style> for looks`);
      else if (name === "slot" || name === "is" || name === "data-plugin") report("warning", file, line, `${name}= is dropped from views`);
      else if (!component && !name.startsWith("aria-") && !name.startsWith("data-") && !rules.GLOBAL_ATTRIBUTES.includes(name) && !(rules.ELEMENT_ATTRIBUTES[tag] ?? []).includes(name)) report("warning", file, line, `${name}= isn't allowed on <${tag}>, so it is dropped`);
      else if (name === "href" && !hole && !/^(https?:|mailto:|#)/i.test(value.trim())) report("warning", file, line, `href="${value}" is dropped: a link in a view must start with https:, http:, mailto: or #`);
      else if (tag === "input" && name === "type" && !hole && !rules.INPUT_TYPES.includes(value.toLowerCase())) report("warning", file, line, `<input type="${value}"> isn't allowed, so it becomes a text box`);
    }
  }
  return ids;
}

function print(apps) {
  let errors = 0;
  let warnings = 0;
  for (const app of apps) {
    const mine = app.problems;
    errors += mine.filter((p) => p.level === "error").length;
    warnings += mine.filter((p) => p.level === "warning").length;
    console.log(`${mine.length ? "✗" : "✓"} ${app.app}${app.plugins.length ? ` (${app.plugins.join(", ")})` : ""}`);
    for (const p of mine) console.log(`    ${p.level.padEnd(7)} ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
  }
  console.log(`\n${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const apps = await checkApps(args.filter((a) => a !== "--json"));
  if (args.includes("--json")) console.log(JSON.stringify({ ok: apps.every((a) => !a.problems.some((p) => p.level === "error")), apps }, null, 2));
  else print(apps);
  process.exitCode = apps.some((a) => a.problems.some((p) => p.level === "error")) ? 1 : 0;
}
