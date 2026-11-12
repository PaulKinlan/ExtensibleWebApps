// @ts-check
// Preload hints for an app's page: the files its first view needs, named in
// the page itself, so the browser asks for them all as the page arrives.
//
// Without them a visit finds its files one after another, each only once the
// one before has arrived and been read:
//
//   app.html → host.js → the kernel, each plugin → its template file
//            → the ui-* elements the templates use → each element's script
//
// which is four to seven requests deep before the first view. The host
// already starts each as early as it can (src/host/prefetch.ts), but it can't
// ask for a file before it knows its name. This file reads the same chain
// ahead of time and writes it into the page as <link rel="preload"> lines:
//
//   - each plugin and agent the page links, and Customize's manifest
//   - the template files each plugin names: ctx.ui.views("x.html")
//   - the ui-* elements those templates use, the elements inside those, and
//     each element's script and what it imports
//   - the kernel, the plugin workers' script, and the kernel modules the
//     plugins' manifests say they use (`services`)
//
// A plugin that is only its manifest (`code`) is needed for no first view, so
// its code and templates are left to the host, some seconds into the visit.
//
// The lines are made, never written by hand and never committed:
//
//   - the build adds them to every app page in dist/ (vite.preload.ts)
//   - a project of your own gets them as it is served and deployed (scripts/extensible-app.mjs)
//   - the service worker adds them to an app made in the browser as it serves its page (sw/routes/made.js)
//
// They are for a visit no service worker answers, which is the first. A page the worker answers goes without
// them (sw/render-blocking.js): Chrome won't hand a file it preloaded through a service worker to the fetch()
// that then asks for it, so there each hint would be a second request. The worker asks for the same files
// itself instead, and answers the page's requests for them with those (sw.js, `ahead`).
//
// so this file is plain JavaScript that runs in Node and in a service worker:
// it is handed a way to read a file by its address, and touches nothing else.
// A hint that is wrong costs one request; a missing one costs what it did before.

import { tags } from "./made-page.js";

/** Marks a line this file made, so making them again replaces them. */
const MARK = "data-preload";
const MADE = new RegExp(`[ \\t]*<link\\b[^>]*\\b${MARK}\\b[^>]*>\\r?\\n?`, "gi");

/** A page without the hints this file made. @param {string} html */
export const withoutHints = (html) => html.replace(MADE, "");

/** The addresses the hints in a page name, as written there. @param {string} html @returns {string[]} */
export const hintedFiles = (html) => (html.match(MADE) ?? []).map((line) => /\bhref="([^"]*)"/.exec(line)?.[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") ?? "").filter(Boolean);

/** `ctx.ui.views("x.html")` with a plain string, as the host reads it (src/host/prefetch.ts). */
const VIEWS = /\.views\(\s*(["'`])([^"'`$\n]{1,200}\.html)\1\s*\)/g;
/** A ui-* tag in some markup. */
const ELEMENT = /<(ui-[a-z0-9-]+)[\s>/]/gi;
/** A manifest that names a `code` file: the rest of the plugin is fetched later (src/host/prefetch.ts). */
const CODE = /\bcode["']?\s*:/;
/** The most elements followed from one page: an element may use others, which may use others. */
const MOST_ELEMENTS = 60;

/**
 * What the build knows about the platform's own files (/platform/preload.json, vite.preload.ts):
 * `kernel` and `runtime` are built files' addresses, `netRuntime` the workers' script for plugins with `network`,
 * `agents` the parts of the kernel and of the page's script that read agent files, and `modules` maps a service's
 * name to the files of the kernel module that gives it.
 * @typedef {{ kernel?: string; runtime?: string; netRuntime?: string; agents?: string[]; modules?: Record<string, string[]> }} Platform
 */

/** The manifest's own text: the first `export const manifest = { … }`, braces matched outside strings and comments. @param {string} source */
function manifestText(source) {
  const start = /export\s+const\s+manifest\s*=\s*\{/.exec(source);
  if (!start) return "";
  let depth = 0;
  /** @type {string | undefined} */
  let quote;
  for (let i = start.index + start[0].length - 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i + 2) < 0 ? source.length : source.indexOf("*/", i + 2) + 1;
    else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start.index, i + 1);
  }
  return "";
}

/** The strings in a manifest's list of that name: `services: ["router", "history"]`. @param {string} manifest @param {string} name */
function listed(manifest, name) {
  const list = new RegExp(`(?:^|[\\s,{])["']?${name}["']?\\s*:\\s*\\[([^\\]]*)\\]`).exec(manifest)?.[1] ?? "";
  return [...list.matchAll(/(["'])([^"']*)\1/g)].map((m) => m[2]);
}

/**
 * The hints for a page, as the addresses to ask for and how: `fetch` for a file the page reads as text, `module`
 * for a script. Addresses are paths from the site's root. Nothing for a page that isn't an app.
 * @param {string} html the page @param {string} at the page's own path (`/demos/habits/app.html`)
 * @param {(path: string) => Promise<string | undefined>} read a file's text by its path, or undefined if there is none
 * @param {Platform} [platform]
 * @returns {Promise<{ href: string; as: "fetch" | "module" }[]>}
 */
export async function hintsFor(html, at, read, platform = {}) {
  const { tags: all } = tags(html);
  const open = all.filter((tag) => !tag.closing);
  if (!open.some((tag) => tag.name === "script" && /\/platform\/host\.js$/.test(tag.attributes.src ?? ""))) return [];
  const page = new URL(at, "https://site.invalid");
  const base = new URL(open.find((tag) => tag.name === "base" && tag.attributes.href)?.attributes.href ?? ".", page);
  /** A path on this site, or undefined for an address anywhere else. @param {string} href @param {URL} from */
  const path = (href, from) => {
    try {
      const url = new URL(href, from);
      return url.origin === page.origin && !url.search && !url.hash ? url.pathname : undefined;
    } catch {
      return undefined;
    }
  };
  /** @type {Map<string, "fetch" | "module">} */
  const out = new Map();
  const add = (/** @type {string | undefined} */ href, /** @type {"fetch" | "module"} */ as) => void (href && !out.has(href) && out.set(href, as));

  const rel = (/** @type {string} */ name) => (/** @type {typeof open[number]} */ tag) => tag.name === "link" && (tag.attributes.rel ?? "").toLowerCase().split(/\s+/).includes(name) && tag.attributes.href;
  const links = open.filter((tag) => rel("plugin")(tag) || rel("agent")(tag)).map((tag) => path(tag.attributes.href, base));
  // Customize is on every app unless its author says otherwise (src/host/main.ts).
  const customize = open.find((tag) => tag.name === "meta" && tag.attributes.name === "customize")?.attributes.content?.trim().toLowerCase() !== "off";
  if (customize && !open.some((tag) => tag.attributes.id === "devtools")) links.push("/std/customize.js");

  /** @type {Set<string>} */
  const elements = new Set();
  const uses = (/** @type {string} */ markup) => {
    for (const match of markup.matchAll(ELEMENT)) elements.add(match[1].toLowerCase());
  };
  /** @type {Set<string>} */
  const services = new Set();
  let network = false;
  let agents = false;
  let plugins = 0;

  await Promise.all(
    [...new Set(links)].map(async (href) => {
      if (!href) return;
      const source = await read(href);
      if (source === undefined) return;
      add(href, "fetch");
      // An agent file is Markdown: the kernel makes its plugin from it (src/kernel/agents/file.ts), with the
      // part of the kernel that reads agent files, and the host fetches the loop it runs beside it
      // (src/shared/agent-runner.ts): the one its frontmatter names, or the standard one.
      if (/\.agent\.md$/i.test(href)) {
        plugins++;
        agents = true;
        const front = /^\uFEFF?---\r?\n([^]*?)\r?\n---/.exec(source)?.[1] ?? "";
        const runner = /^\s*runner\s*:\s*(["']?)([^\s"'#]+)\1/m.exec(front)?.[2] ?? "/std/agents/runner.js";
        const loop = path(runner, new URL(href, page));
        if (loop && (await read(loop)) !== undefined) add(loop, "fetch");
        for (const name of /^\s*outside\s*:\s*true\b/m.test(front) ? ["outside", "tools"] : ["agents", "bus", "tools"]) services.add(name);
        return;
      }
      const manifest = manifestText(source);
      for (const name of listed(manifest, "services")) services.add(name);
      // The view that holds a plugin's place until it is first used (`standIn`) is drawn by the kernel, from the
      // manifest; the plugin itself starts no worker until then.
      uses(manifest);
      const waits = /\bstandIn["']?\s*:/.test(manifest);
      if (!waits && listed(manifest, "permissions").some((p) => p === "network" || p.startsWith("network:"))) network = true;
      if (CODE.test(manifest)) return;
      if (!waits) plugins++;
      // Only the elements of its template files, which the host loads as soon as it has read them: an element
      // named in markup the plugin's code builds may never be drawn, and a hint nothing uses is a warning in the console.
      await Promise.all(
        [...source.matchAll(VIEWS)].map(async (match) => {
          const src = path(match[2], new URL(href, page));
          const file = src && (await read(src));
          if (!src || file === undefined) return;
          add(src, "fetch");
          uses(file);
        }),
      );
    }),
  );

  // Each element's file, the elements inside it, its script and what the script imports (src/host/elements.ts).
  const seen = new Set();
  for (let round = [...elements]; round.length && seen.size < MOST_ELEMENTS; ) {
    const next = new Set();
    await Promise.all(
      round.map(async (name) => {
        if (seen.has(name) || seen.size >= MOST_ELEMENTS) return;
        seen.add(name);
        const src = `/elements/${name}.html`;
        const file = await read(src);
        if (file === undefined) return;
        add(src, "fetch");
        const from = new URL(src, page);
        for (const tag of tags(file).tags) {
          if (tag.closing) continue;
          if (tag.name.startsWith("ui-") && !seen.has(tag.name)) next.add(tag.name);
          if (tag.name === "script" && tag.attributes.type === "module" && tag.attributes.src) add(path(tag.attributes.src, from), "module");
          if (tag.name === "link" && tag.attributes.rel === "modulepreload" && tag.attributes.href) add(path(tag.attributes.href, from), "module");
        }
      }),
    );
    round = [...next];
  }

  // The platform's own files, which only the build can name: their content's hash is in each name. First, as
  // the largest and the ones everything else waits for.
  /** @type {string[]} */
  const first = [];
  if (platform.kernel) first.push(platform.kernel);
  if (plugins && platform.runtime) first.push(platform.runtime);
  if (network && platform.netRuntime) first.push(platform.netRuntime);
  if (agents) first.push(...(platform.agents ?? []));
  for (const name of services) for (const file of platform.modules?.[name] ?? []) if (!first.includes(file)) first.push(file);
  return [...first.map((href) => ({ href, as: /** @type {const} */ ("module") })), ...[...out].map(([href, as]) => ({ href, as }))];
}

/**
 * The page with its hints in it, after the line that loads the host. A page that isn't an app comes back as it
 * was. The app's own files are named as the page names them (relative to it), so the page works wherever it is
 * served: in a space, /s/family/demos/habits/ reads its files from there.
 * @param {string} html @param {string} at @param {(path: string) => Promise<string | undefined>} read @param {Platform} [platform]
 */
export async function withHints(html, at, read, platform) {
  const clean = withoutHints(html);
  const hints = await hintsFor(clean, at, read, platform);
  if (!hints.length) return clean;
  const { tags: all } = tags(clean);
  const host = all.find((tag) => !tag.closing && tag.name === "script" && /\/platform\/host\.js$/.test(tag.attributes.src ?? ""));
  if (!host) return clean;
  // After the script's closing tag, on a line of its own with the script's indent.
  const close = all.find((tag) => tag.closing && tag.name === "script" && tag.index >= host.end);
  const end = close ? close.end : host.end;
  const indent = /(^|\n)([ \t]*)[^\n]*$/.exec(clean.slice(0, host.index))?.[2] ?? "";
  const folder = at.slice(0, at.lastIndexOf("/") + 1);
  const based = all.some((tag) => !tag.closing && tag.name === "base");
  const lines = hints.map(({ href, as }) => {
    // Its own files as the page names them; with a <base> of its own, a path from the root says the same wherever it is.
    const named = !based && href.startsWith(folder) ? href.slice(folder.length) : href;
    const address = named.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return as === "module" ? `<link rel="modulepreload" href="${address}" ${MARK}>` : `<link rel="preload" as="fetch" crossorigin href="${address}" ${MARK}>`;
  });
  return `${clean.slice(0, end)}\n${lines.map((line) => `${indent}${line}`).join("\n")}${clean.slice(end)}`;
}
