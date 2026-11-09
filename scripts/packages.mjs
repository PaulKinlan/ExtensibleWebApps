// The plugin registry, written from the plugins' own manifests (docs/guide/plugin-registry.md):
//
//   packages/index.json    the plugins anyone can add to any app, which Customize lists: the packages in
//                          packages/<id>/ and the standard plugins packages/std.json names
//   packages/catalog.json  every plugin this site ships, for people and tools to browse: those, the other
//                          standard plugins and agents, the services built into the site (kernel.json),
//                          and every demo's plugins, with the apps that link each one
//   packages/index.html    the page at /packages/, made from the catalogue
//
// None of the three is committed, so pull requests that each add a plugin never conflict over them: the
// site makes them as it serves and builds (scripts/generated.mjs, vite.config.ts), into dist/packages/.
//
//   npm run packages    makes all three and says what is in them, or fails on a plugin it can't list (it writes nothing)
//
// Nothing here runs a plugin: each manifest is read as the kernel reads it, without running the code.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hookLimits } from "../vite.kernel-modules.ts";

const SITE = new URL("../", import.meta.url);
const ROOT = new URL("packages/", SITE);
const STD = new URL("std/", SITE);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** A standard plugin's path in packages/std.json: its file in std/, without .js ("undo", "llm/anthropic"). */
const STD_PATH = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

/** The headings plugins are sorted under, by what they do. Customize uses the same words (std/customize.js). */
export const KINDS = {
  service: { title: "Services", tag: "Service", about: "Give the app something new that other plugins use, such as a language model. A service draws nothing itself." },
  ui: { title: "On the page", tag: "On the page", about: "Buttons, panels and views you can add to the page." },
  background: { title: "Behind the scenes", tag: "Behind the scenes", about: "Work quietly for the app: they check, fetch or change things, and draw nothing." },
  agent: { title: "Agents", tag: "Agent", about: "Markdown files a language model follows, with the same permissions as any plugin." },
};

/** The kernel's own manifest reader and permission words, bundled from src/ (as scripts/check.mjs does). */
async function kernel() {
  const out = await build({
    stdin: {
      contents: 'export { readManifest } from "./src/kernel/manifest.ts";\nexport { PLUGIN_HOOKS } from "./src/kernel/hooks.ts";\nexport { explain } from "./src/kernel/authoring.ts";\nexport { fromAgentFile } from "./src/kernel/agents/file.ts";',
      resolveDir: fileURLToPath(SITE),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const reader = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  // The hook limits the site set in kernel.json, as the kernel uses them.
  Object.assign(reader.PLUGIN_HOOKS, hookLimits(fileURLToPath(SITE)));
  return reader;
}

const read = (url) => readFileSync(url, "utf8");
const json = (url) => JSON.parse(read(url));
const sorted = (list) => [...list].sort();

/** Services a manifest provides: its `provides`, and any provide:<name> permission (the llm providers answer the llm module's hooks). */
const providesOf = (m) => sorted(new Set([...Object.keys(m.provides ?? {}), ...m.permissions.filter((p) => p.startsWith("provide:")).map((p) => p.slice(8))]));

/** Which heading a plugin goes under: Services, On the page, or Behind the scenes. */
export const kindOf = (m) => (providesOf(m).length ? "service" : m.permissions.some((p) => p === "ui" || p.startsWith("ui:")) ? "ui" : "background");

/** Where a plugin draws on a page with no slot for it, in words: "append main". */
const placesOf = (m) => Object.values(m.places ?? {}).map((at) => `${at.put}${at.each ? " each" : ""} ${at.at}${at.in ? ` in ${at.in}` : ""}`);

// ---------------------------------------------------------------------------------------------------
// Apps: every app.html on the site, and the plugins and agents it links.

const strip = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/** Names for the site's own pages, whose <title> is the site's name. */
const PAGE_TITLES = { home: "Home page", workbench: "Workbench", docs: "Docs" };

/** Where the site serves a file in the repo: site/ is served at the root (site/home/ is /home/). */
const served = (file) => `/${file.replace(/^site\//, "")}`;

/** Every app and page the site serves that links plugins, with the absolute address of each plugin and agent it links. */
export function scanApps() {
  const apps = [];
  const pages = [
    ...readdirSync(new URL("demos/", SITE), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(new URL(`demos/${e.name}/app.html`, SITE)))
      .map((e) => `demos/${e.name}/app.html`),
    ...htmlFiles("site/"),
    ...htmlFiles("docs/"),
  ];
  for (const file of [...new Set(pages)].sort()) {
    const html = strip(read(new URL(file, SITE)));
    // Every demo, even one that links no plugins (the trip, whose samples a person adds); any other page only if it links some.
    if (!file.startsWith("demos/") && !/<link rel="(plugin|agent)"/.test(html)) continue;
    // An app.html is known by its folder (demos/trip); any other page by its file (home/chapter-1-core).
    const path = file.endsWith("/app.html") ? file.slice(0, -"/app.html".length) : file.replace(/^site\//, "").replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "") || "home";
    const href = served(file).replace(/(^|\/)index\.html$/, "$1").replace(/^\/new\/app\.html$/, "/new/");
    const title = PAGE_TITLES[path] ?? html.match(/<meta name="gallery-title" content="([^"]*)"/)?.[1] ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? path;
    const links = (rel) => [...html.matchAll(new RegExp(`<link rel="${rel}" href="([^"]+)"`, "g"))].map((m) => new URL(m[1], `https://site${served(file)}`).pathname);
    apps.push({ path, title: title.trim(), href, plugins: links("plugin"), agents: links("agent") });
  }
  return apps;
}

/** The .html files in a folder and the folders inside it. */
function htmlFiles(folder) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(new URL(rel, SITE), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) walk(`${rel}${e.name}/`);
      else if (e.name.endsWith(".html")) out.push(`${rel}${e.name}`);
    }
  };
  walk(folder);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The index: what Customize offers.

/** The index, as it should be: an error for any folder that isn't a package. */
export async function buildIndex(k) {
  k ??= await kernel();
  const apps = scanApps();
  const linkedBy = (href) => apps.filter((a) => a.plugins.includes(href)).map((a) => a.path);
  const { groups } = json(new URL("groups.json", ROOT));
  const groupOf = new Map(Object.entries(groups).flatMap(([group, ids]) => ids.map((id) => [id, group])));
  const entry = (manifest, href, std) => {
    const group = groupOf.get(manifest.id);
    if (!group) throw new Error(`packages/groups.json: put ${manifest.id} under one of the groups (the sub-heading it shows under)`);
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "",
      href,
      permissions: manifest.permissions,
      provides: Object.keys(manifest.provides ?? {}).sort(),
      services: sorted(manifest.services ?? []),
      ...(std ? { std: true } : {}),
      kind: kindOf(manifest),
      group,
      places: placesOf(manifest),
      apps: linkedBy(href),
    };
  };
  const packages = [];
  for (const dir of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = dir.name;
    const file = new URL(`${id}/${id}.js`, ROOT);
    if (!ID.test(id) || !existsSync(file)) throw new Error(`packages/${id}/ needs ${id}.js`);
    // Read as the kernel reads it, so nothing in the plugin runs here, and a manifest the kernel would refuse fails now.
    const manifest = k.readManifest(read(file));
    if (manifest?.id !== id) throw new Error(`packages/${id}/${id}.js: its manifest's id must be ${id}`);
    for (const name of manifest.files ?? []) if (!existsSync(new URL(`${id}/${name}`, ROOT))) throw new Error(`packages/${id}/: ${name} is in files but missing`);
    packages.push(entry(manifest, `/packages/${id}/${id}.js`, false));
  }
  // The standard plugins offered too (packages/std.json): they stay in std/, where apps link them, and a
  // person adds them from there, with the files their manifests list (the plugin editor's starting templates
  // come from the folder beside it). Customize isn't offered: the host adds it to every app.
  const { std = [] } = json(new URL("std.json", ROOT));
  if (JSON.stringify(sorted(std)) !== JSON.stringify(std)) throw new Error("packages/std.json: list the plugins sorted, one per line");
  for (const path of std) {
    const file = new URL(`${path}.js`, STD);
    if (!STD_PATH.test(path) || !existsSync(file)) throw new Error(`packages/std.json: std/${path}.js doesn't exist`);
    const manifest = k.readManifest(read(file));
    for (const name of manifest.files ?? []) if (!existsSync(new URL(name, file))) throw new Error(`std/${path}.js: ${name} is in files but missing`);
    // A person adds it to an app with no slots, so it must say where it draws.
    if (!Object.keys(manifest.places ?? {}).length && manifest.permissions.includes("ui")) throw new Error(`std/${path}.js: offered in the registry, so its manifest needs places, for pages without its slot`);
    // Its manifest's id, which Customize matches against the person's plugins (std/sync.js is sync-status).
    packages.push(entry(manifest, `/std/${path}.js`, true));
  }
  const offered = new Set(packages.map((p) => p.id));
  for (const id of groupOf.keys()) if (!offered.has(id)) throw new Error(`packages/groups.json: ${id} isn't a plugin the registry offers`);
  // A service built into the site that answers through plugins (llm): a plugin that needs it names the
  // ones in the registry that can answer, so a person can be told to add one.
  const modules = new Set(json(new URL("kernel.json", SITE)).modules);
  for (const p of packages) {
    const oneOf = {};
    for (const s of p.services) {
      const answer = packages.filter((o) => o.permissions.includes(`provide:${s}`) && !o.provides.includes(s)).map((o) => o.id);
      if (modules.has(s) && answer.length && !answer.includes(p.id)) oneOf[s] = answer;
    }
    if (Object.keys(oneOf).length) p.needsOneOf = oneOf;
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages };
}

// ---------------------------------------------------------------------------------------------------
// The catalogue: everything.

/** Every .js file under a folder whose manifest is a plugin's, leaving out companion folders (`*.templates/`, which hold starting points, not plugins). */
function pluginFiles(folder) {
  const out = [];
  const walk = (url, rel) => {
    for (const e of readdirSync(url, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (!e.name.includes(".") && e.name !== "node_modules") walk(new URL(`${e.name}/`, url), `${rel}${e.name}/`);
      } else if (e.name.endsWith(".js") && /^export const manifest\s*=/m.test(read(new URL(e.name, url)))) out.push(`${rel}${e.name}`);
      else if (e.name.endsWith(".agent.md")) out.push(`${rel}${e.name}`);
    }
  };
  walk(new URL(folder, SITE), folder);
  return out;
}

/** The first comment paragraph of a file, as one line: what a module says it is. */
const summary = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .reduce((acc, line) => (acc.done ? acc : line.startsWith("//") && line.slice(2).trim() ? { ...acc, lines: [...acc.lines, line.slice(2).trim()] } : { ...acc, done: acc.lines.length > 0 }), { lines: [], done: false })
    .lines.join(" ")
    .replace(/\s+/g, " ");

/** The first sentence of a module's comment, without "The `x` service:" in front. */
const firstSentence = (text) => {
  const s = summary(text).replace(/^The `?[a-z]+`? (service|kernel module|module)( \([^)]*\))?[.:]\s*/i, "");
  const end = s.search(/\.(\s|$)/);
  const sentence = end < 0 ? s : s.slice(0, end + 1);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** Every plugin, agent and built-in service the site ships, with the apps that link each. */
export async function buildCatalog(k, index) {
  k ??= await kernel();
  index ??= await buildIndex(k);
  const apps = scanApps();
  const offered = new Map(index.packages.map((p) => [p.href, p]));

  // The services built into the site: the kernel modules kernel.json lists, each provides one or more.
  const services = [];
  for (const name of json(new URL("kernel.json", SITE)).modules) {
    const file = new URL(`${name}/module.ts`, STD);
    const text = read(file);
    const names = sorted(new Set([...text.matchAll(/(?:^export default service|kernel\.service|kernel\.provide)\("([a-z][a-z0-9-]*)"/gm)].map((m) => m[1])));
    if (!names.length) throw new Error(`std/${name}/module.ts: provides no service the catalogue can find (export default service("…"), or kernel.provide("…"))`);
    for (const service of names) services.push({ id: service, module: name, description: firstSentence(text), href: `https://github.com/PaulKinlan/ExtensibleWebApps/blob/main/std/${name}/module.ts`, docs: `/docs/api#${service}` });
  }

  const plugins = [];
  const add = (file, source) => {
    const href = served(file);
    const text = read(new URL(file, SITE));
    const agent = file.endsWith(".agent.md");
    // An agent's manifest as the kernel makes it from the file, with what its loop needs added (llm, agents).
    const m = k.readManifest(agent ? k.fromAgentFile(text, "// The loop, which the manifest doesn't depend on.") : text);
    const linked = apps.filter((a) => (agent ? a.agents : a.plugins).includes(href)).map((a) => a.path);
    const pkg = offered.get(href);
    plugins.push({
      id: m.id,
      name: m.name,
      description: m.description ?? "",
      href,
      source,
      kind: agent ? "agent" : kindOf(m),
      ...(pkg ? { offered: true, group: pkg.group } : {}),
      permissions: m.permissions,
      provides: providesOf(m),
      services: sorted(m.services ?? []),
      places: placesOf(m),
      ...(m.runs ? { runs: m.runs } : {}),
      apps: linked,
    });
  };
  for (const file of pluginFiles("packages/")) add(file, "registry");
  for (const file of pluginFiles("std/")) add(file, "std");
  for (const file of pluginFiles("demos/")) add(file, file.split("/")[1]);
  // The site's own pages: the homepage's chapters, the workbench, the docs.
  for (const file of pluginFiles("site/")) add(file, "site");
  for (const file of pluginFiles("docs/")) add(file, "site");
  for (const p of index.packages) if (!plugins.some((c) => c.href === p.href)) throw new Error(`${p.href} is offered but the catalogue didn't find it`);
  return {
    apps: apps.map(({ path, title, href }) => ({ path, title, href })),
    services,
    plugins,
  };
}

export const render = (index) => `${JSON.stringify(index, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------------
// The page.

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** What a permission lets a plugin do, in words, for the page: the kernel's own words where it has them. */
function permissionWords(k, services) {
  const about = new Map(services.map((s) => [s.id, s.description]));
  return (permission) => {
    const [kind, ...rest] = permission.split(":");
    const what = rest.join(":");
    if (kind === "secret" && what) return `Use a key you give it for ${what}, which it never sees: the site adds it to its requests.`;
    if (kind === "network" && what) return `Connect to ${what}.`;
    if (kind === "ui" && what.startsWith("transform:")) return `Change how ${what.slice(10)}'s view looks.`;
    if (permission === "ui:theme") return "Change the app's colours and shapes.";
    if (kind === "bus" && rest[0] === "send") return `Send messages to ${rest.slice(1).join(":") === "*" ? "any agent" : rest.slice(1).join(":")}.`;
    if (kind === "agents" && rest[0] === "run") return `Start the ${rest.slice(1).join(":")} agent.`;
    const said = k.explain(permission);
    if (!said.startsWith("Use ")) return said;
    const service = about.get(kind);
    return service ? `Use the ${kind} service: ${service.charAt(0).toLowerCase()}${service.slice(1)}` : said;
  };
}

/** The page at /packages/: what the registry is, then every plugin, grouped, with a search. */
export function renderPage(index, catalog, k) {
  const words = permissionWords(k, catalog.services);
  const title = new Map(catalog.apps.map((a) => [a.path, a]));
  const named = new Map(catalog.plugins.map((p) => [p.id, p.name]));
  const providerNames = new Map();
  for (const p of catalog.plugins) for (const s of p.provides) providerNames.set(s, [...(providerNames.get(s) ?? []), p]);

  const appLinks = (paths) => paths.map((path) => `<a href="${escape(title.get(path)?.href ?? `/${path}/`)}">${escape(title.get(path)?.title ?? path)}</a>`).join(", ");

  const card = (p, { offered = false } = {}) => {
    const pkg = offered ? index.packages.find((x) => x.href === p.href) : undefined;
    const tags = [KINDS[p.kind].tag];
    if (p.runs === "server") tags.push("Runs on a space's server");
    if (p.runs === "both") tags.push("Runs in the page and on a space's server");
    const facts = [];
    if (p.provides.length) facts.push(`<li><b>Provides</b> the ${p.provides.map((s) => `<a href="/docs/api#${escape(s)}"><code>${escape(s)}</code></a>`).join(", ")} service</li>`);
    const needs = p.services.filter((s) => !p.provides.includes(s));
    if (needs.length) facts.push(`<li><b>Needs</b> ${needs.map((s) => `<code>${escape(s)}</code>`).join(", ")}${pkg?.needsOneOf ? `: add one of ${Object.values(pkg.needsOneOf).flat().map((id) => escape(named.get(id) ?? id)).join(", ")} too` : ""}</li>`);
    if (p.places.length) facts.push(`<li><b>Draws</b> ${p.places.map((at) => `<code>${escape(at)}</code>`).join(", ")}, so it works on a page with no slot for it</li>`);
    facts.push(`<li><b>In</b> ${p.apps.length ? appLinks(p.apps) : "no app yet: add it to one"}</li>`);
    const asks = p.permissions.length ? p.permissions.map((perm) => `<li><code>${escape(perm)}</code> ${escape(words(perm))}</li>`).join("") : "<li>Nothing: it can't draw, read or change anything.</li>";
    const search = [p.name, p.id, p.description, p.group ?? "", KINDS[p.kind].title, ...p.permissions, ...p.provides, ...p.services, ...p.apps.map((a) => title.get(a)?.title ?? a)].join(" ").toLowerCase();
    const tag = escape(`<link rel="${p.kind === "agent" ? "agent" : "plugin"}" href="${p.href}">`);
    return `        <li class="card" id="${escape(offered ? p.id : `${p.source}-${p.id}`)}" data-kind="${p.kind}" data-search="${escape(search)}">
          <h4>${escape(p.name)} <span class="tags">${tags.map((t) => `<span class="tag ${p.kind}">${escape(t)}</span>`).join("")}</span></h4>
          <p>${escape(p.description)}</p>
          <ul class="facts">${facts.join("")}</ul>
          <details><summary>Asks for ${p.permissions.length ? `${p.permissions.length} permission${p.permissions.length === 1 ? "" : "s"}` : "nothing"}</summary><ul class="asks">${asks}</ul></details>
          <p class="actions"><a href="${escape(p.href)}">Code</a> <button type="button" class="copy" data-copy="${escape(p.href)}">Copy address</button> <button type="button" class="copy" data-copy="${tag}">Copy ${p.kind === "agent" ? "agent" : "link"} tag</button></p>
        </li>`;
  };

  const list = (items, options) => `      <ul class="cards">\n${items.map((p) => card(p, options)).join("\n")}\n      </ul>`;
  const byName = (a, b) => a.name.localeCompare(b.name);

  // 1. Offered: by kind, then group.
  const order = Object.keys(json(new URL("groups.json", ROOT)).groups);
  const offered = catalog.plugins.filter((p) => p.offered);
  const offeredHtml = ["service", "ui", "background"]
    .map((kind) => {
      const ofKind = offered.filter((p) => p.kind === kind);
      if (!ofKind.length) return "";
      // In packages/groups.json's order, so the first group under a heading is the one to start with.
      const groups = order.filter((g) => ofKind.some((p) => p.group === g));
      return `      <section class="kind" data-section>
        <h3>${escape(KINDS[kind].title)}</h3>
        <p class="about">${escape(KINDS[kind].about)}</p>
${groups.map((g) => `        <div data-section>\n        <h4 class="group">${escape(g)}</h4>\n${list(ofKind.filter((p) => p.group === g).sort(byName), { offered: true })}\n        </div>`).join("\n")}
      </section>`;
    })
    .join("\n");

  // 2. Built in: each service, and the plugins that provide or use it.
  const users = (s) => catalog.plugins.filter((p) => p.services.includes(s) || p.permissions.some((perm) => perm === s || perm.startsWith(`${s}:`)));
  const builtIn = catalog.services
    .map((s) => {
      const answer = catalog.plugins.filter((p) => p.permissions.includes(`provide:${s.id}`) && p.source === "std");
      const used = users(s.id).filter((p) => !answer.includes(p));
      const search = [s.id, s.module, s.description, ...answer.map((p) => p.name)].join(" ").toLowerCase();
      return `        <li class="card" id="service-${escape(s.id)}" data-kind="builtin" data-search="${escape(search)}">
          <h4><code>${escape(s.id)}</code> <span class="tags"><span class="tag builtin">Built in</span></span></h4>
          <p>${escape(s.description)}</p>
          <ul class="facts">${answer.length ? `<li><b>Answered by</b> a plugin you add: ${answer.map((p) => `<a href="#${escape(p.offered ? p.id : `${p.source}-${p.id}`)}">${escape(p.name)}</a>`).join(", ")}</li>` : ""}<li><b>Used by</b> ${used.length} plugin${used.length === 1 ? "" : "s"} here${used.length ? `: ${used.slice(0, 6).map((p) => escape(p.name)).join(", ")}${used.length > 6 ? ", …" : ""}` : ""}</li></ul>
          <p class="actions"><a href="${escape(s.docs)}">How to call it</a> <a href="${escape(s.href)}">Code</a></p>
        </li>`;
    })
    .join("\n");

  // 3. Standard plugins and agents that apps link but no one adds to any app.
  const std = catalog.plugins.filter((p) => p.source === "std" && !p.offered).sort(byName);

  // 4. Each demo's plugins.
  const demos = catalog.apps
    .filter((a) => a.path.startsWith("demos/"))
    .map((a) => {
      const own = catalog.plugins.filter((p) => p.source === a.path.split("/")[1]).sort((x, y) => Number(y.apps.length > 0) - Number(x.apps.length > 0) || byName(x, y));
      if (!own.length) return "";
      return `      <section class="app" data-section>
        <h4 class="group"><a href="${escape(a.href)}">${escape(a.title)}</a> <span class="count">${own.length}</span></h4>
${list(own)}
      </section>`;
    })
    .join("\n");

  const total = catalog.plugins.length + catalog.services.length;
  return `<!doctype html>
<!--
  The plugin registry, as a page. Made by the build (scripts/generated.mjs, scripts/packages.mjs) from the same
  manifests as index.json, which Customize reads, and catalog.json; don't edit it by hand.
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Plugins · Extensible Web Apps</title>
  <meta name="description" content="Every plugin and service this site ships: the ones anyone can add to any app from Customize, the ones built in, and every demo's own.">
  <link rel="stylesheet" href="/platform/host.css">
  <link rel="stylesheet" href="/packages/registry.css">
  <script type="module" src="/packages/registry.js"></script>
</head>
<body>
  <header>
    <h1>Plugins</h1>
    <nav class="site" aria-label="This site">
      <a href="/">Home</a>
      <a href="/demos/">All demos</a>
      <a href="/packages/" aria-current="page">Plugins</a>
      <a href="/docs/">Docs</a>
      <a href="/workbench/">Workbench</a>
    </nav>
  </header>
  <main>
    <p class="lede">Every plugin this site ships. Add any plugin under <a href="#add">Add to any app</a> to <em>any</em> app: open the app, open <strong>Customize</strong> (bottom left) and pick it under <strong>Add a plugin</strong>. Your own plugins go there too, by file, code or address.</p>
    <dl class="key">
      <div><dt><span class="tag service">Service</span></dt><dd>Gives an app something new that other plugins use, such as a language model.</dd></div>
      <div><dt><span class="tag ui">On the page</span></dt><dd>Draws buttons, panels and views.</dd></div>
      <div><dt><span class="tag background">Behind the scenes</span></dt><dd>Checks, fetches or changes things, and draws nothing.</dd></div>
      <div><dt><span class="tag builtin">Built in</span></dt><dd>A service every app here already has. Some, such as <code>llm</code>, need a plugin you add to answer.</dd></div>
    </dl>
    <p class="how">You see a plugin's code and what it asks for before it is added; it is kept on your device and starts switched off. One that needs a service brings the plugin that provides it. <a href="/docs/guide/plugin-registry">How the registry works</a> · <a href="/packages/index.json">index.json</a> · <a href="/packages/catalog.json">catalog.json</a></p>
    <search class="find">
      <label for="find">Find a plugin</label>
      <input id="find" type="search" placeholder="Try “model”, “undo”, “data:read” or “reading list”" autocomplete="off">
      <div class="filters" role="group" aria-label="Show">
        <button type="button" data-filter="all" aria-pressed="true">All</button>
        <button type="button" data-filter="service" aria-pressed="false">Services</button>
        <button type="button" data-filter="ui" aria-pressed="false">On the page</button>
        <button type="button" data-filter="background" aria-pressed="false">Behind the scenes</button>
        <button type="button" data-filter="agent" aria-pressed="false">Agents</button>
        <button type="button" data-filter="builtin" aria-pressed="false">Built-in services</button>
      </div>
      <p class="shown" role="status" aria-live="polite">${total} plugins and services</p>
    </search>
    <nav class="toc" aria-label="On this page">
      <a href="#add">Add to any app <span class="count">${offered.length}</span></a>
      <a href="#built-in">Built into this site <span class="count">${catalog.services.length}</span></a>
      <a href="#std">For app authors <span class="count">${std.length}</span></a>
      <a href="#demos">From the demos <span class="count">${catalog.plugins.filter((p) => !["std", "registry", "site"].includes(p.source)).length}</span></a>
      <a href="#site">This site's pages <span class="count">${catalog.plugins.filter((p) => p.source === "site").length}</span></a>
    </nav>

    <section id="add" data-section>
      <h2>Add to any app</h2>
      <p class="about">These work in any app, even one whose author never planned for them. Add them from Customize in the app.</p>
${offeredHtml}
    </section>

    <section id="built-in" data-section>
      <h2>Built into this site</h2>
      <p class="about">Services every app here has, without adding anything. A plugin calls one with <code>ctx.call("name", …)</code> once its manifest asks for it. Which ones a site has is the site's choice, in <a href="/docs/layers">kernel.json</a>.</p>
      <ul class="cards">
${builtIn}
      </ul>
    </section>

    <section id="std" data-section>
      <h2>For app authors</h2>
      <p class="about">Standard plugins and agents an app links in its <code>app.html</code>, rather than ones a person adds: Customize (every app has it), the chat for an app's agents, the command palette, the app maker's own parts. Copy a link tag into your app to use one.</p>
${list(std)}
    </section>

    <section id="demos" data-section>
      <h2>From the demos</h2>
      <p class="about">Each demo's own plugins, and the samples it suggests. Most use their app's data or hooks, so they belong with that app, but each is an ordinary plugin to read and copy. Paste one's address into Customize's <strong>Add from URL</strong> to try it.</p>
${demos}
    </section>

    <section id="site" data-section>
      <h2>This site's pages</h2>
      <p class="about">The home page, the workbench and the docs are made of plugins too: each chapter of the home page's story, the workbench's examples, and the docs' panel.</p>
${list(catalog.plugins.filter((p) => p.source === "site").sort(byName))}
    </section>
    <p class="none" hidden>Nothing matches. Try fewer words, or <button type="button" class="clear">show everything</button>.</p>
  </main>
</body>
</html>
`;
}

/** The three files as they should be: what the build writes, and what tests/checks/registry.mjs checks it served. */
export async function expected() {
  const k = await kernel();
  const index = await buildIndex(k);
  const catalog = await buildCatalog(k, index);
  return { "index.json": render(index), "catalog.json": render(catalog), "index.html": renderPage(index, catalog, k) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const made = await expected();
  const index = JSON.parse(made["index.json"]);
  const catalog = JSON.parse(made["catalog.json"]);
  console.log(`The registry offers ${index.packages.length} plugins; its catalogue has ${catalog.plugins.length} plugins and agents and ${catalog.services.length} built-in services. The site makes /packages/index.json, catalog.json and index.html from them as it serves and builds.`);
}
