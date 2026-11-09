// View templates: a plugin's views can live in an .html file next to it, as
// <template id="…"> elements. The plugin sends only data; the host fills the
// template and draws the result like any HTML view (through the sanitiser).
//
//   <template id="due">
//     <h3>{{title}}</h3>
//     <ul>
//       <template for="book of books"><li>{{book.title}}</li></template>
//     </ul>
//     <template if="!books.length"><p>Nothing due.</p></template>
//   </template>
//
// {{path}} holes go in text and attribute values, and are filled as text,
// never parsed as HTML. An attribute that is a single hole is left out when
// its value is false, null or missing, and present with no value when it is
// true: checked="{{done}}". A path is names joined by dots (book.title,
// books.length), optionally starting with !. `for="x of path"` repeats its
// content for each item; `if="path"` keeps its content when the value is
// truthy. There are no other expressions, so there is no code in a template.

import { html } from "./trusted";

const files = new Map<string, Promise<Document>>();
const ready = new Map<string, Document>();

/** The parsed file, if it has loaded. */
export const loadedFile = (src: string) => ready.get(src);

/** Loads a template file once; later calls share the first load. */
/**
 * A person's own plugins live on this device, and only the service worker can serve their files
 * (/user/…). On a first visit it takes charge of the page a moment after the page loads, so wait for
 * that, for up to three seconds.
 */
function controlled(src: string): Promise<unknown> {
  if (!/^(\/s\/[a-z0-9-]+)?\/user\//.test(new URL(src, location.href).pathname) || !("serviceWorker" in navigator) || navigator.serviceWorker.controller) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

export function loadFile(src: string): Promise<Document> {
  let pending = files.get(src);
  if (!pending) {
    // Hosts redirect (Cloudflare sends /budget.html to /budget), so redirects are
    // followed, but only a file that ends up on this page's origin is used: the
    // kernel checked the plugin's URL, and the operator's own server decides
    // where its redirects go, not the plugin.
    pending = controlled(src).then(() => fetch(src, { credentials: "same-origin" })).then(async (response) => {
      if (new URL(response.url).origin !== location.origin) throw new Error(`${src} redirected to another origin`);
      if (!response.ok) throw new Error(`${src} answered ${response.status}`);
      const file = new DOMParser().parseFromString(html(await response.text()), "text/html");
      ready.set(src, file);
      return file;
    });
    // A failed load can be tried again later.
    pending.catch(() => files.delete(src));
    files.set(src, pending);
  }
  return pending;
}

/** Forgets the loaded files under a path (`/user/demos/trip/`), so the next view that needs one loads it again. */
export function forgetFiles(path: string): void {
  for (const src of [...files.keys()]) if (new URL(src, location.href).pathname.startsWith(path)) {
    files.delete(src);
    ready.delete(src);
  }
}

type Scope = Record<string, unknown>;
const HOLE = /\{\{\s*(!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*(!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}\s*$/;

/** The file's own CSS: every <style> outside its templates. The host scopes it to the plugin's views. */
export const styleOf = (file: Document) => [...file.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");

/** Fills template `id` from `file` with `data`, and returns the HTML, for the sanitiser to check. */
export function fill(file: Document, id: string, data: unknown): string {
  const template = [...file.querySelectorAll("template")].find((t) => t.id === id);
  if (!template) return `<p>No template with id ${escapeText(id)}.</p>`;
  const scope: Scope = data && typeof data === "object" && !Array.isArray(data) ? (data as Scope) : { value: data };
  const out = inert.createElement("div");
  try {
    out.append(render(template.content, scope, { left: MAX_NODES }));
  } catch (error) {
    if (error instanceof TooBig) return `<p>The template ${escapeText(id)} makes more than ${MAX_NODES} nodes, so it wasn't drawn.</p>`;
    throw error;
  }
  return out.innerHTML;
}

/**
 * Loops can multiply: two nested loops over 1,000 items make a million nodes
 * from a small payload. Filling stops at this many nodes, before it can
 * freeze the page.
 */
const MAX_NODES = 20_000;
class TooBig extends Error {}
type Budget = { left: number };

/** Built in a document with no scripts or custom elements, so nothing runs or upgrades before the sanitiser sees it. */
const inert = document.implementation.createHTMLDocument("");

function render(from: ParentNode, scope: Scope, budget: Budget): DocumentFragment {
  const fragment = inert.createDocumentFragment();
  for (const node of from.childNodes) {
    if (--budget.left < 0) throw new TooBig();
    if (node.nodeType === Node.TEXT_NODE) {
      fragment.append((node as Text).data.replace(HOLE, (_, path: string) => text(lookup(scope, path))));
    } else if (node instanceof HTMLTemplateElement && node.hasAttribute("for")) {
      const [, name, path] = /^\s*([A-Za-z_$][\w$]*)\s+of\s+(\S+)\s*$/.exec(node.getAttribute("for")!) ?? [];
      const items = name ? lookup(scope, path) : undefined;
      if (Array.isArray(items)) for (const item of items) fragment.append(render(node.content, { ...scope, [name]: item }, budget));
    } else if (node instanceof HTMLTemplateElement && node.hasAttribute("if")) {
      if (lookup(scope, node.getAttribute("if")!.trim())) fragment.append(render(node.content, scope, budget));
    } else if (node instanceof Element) {
      const copy = inert.createElement(node.localName);
      for (const attr of node.attributes) {
        // An attribute that is one whole hole comes and goes with its value: false, null or
        // missing leaves it out, true makes it present (checked="{{done}}"). Anything else is text.
        const whole = WHOLE.exec(attr.value);
        if (whole) {
          const value = lookup(scope, whole[1]);
          if (value === false || value === null || value === undefined) continue;
          copy.setAttribute(attr.name, value === true ? "" : text(value));
        } else copy.setAttribute(attr.name, attr.value.replace(HOLE, (_, path: string) => text(lookup(scope, path))));
      }
      copy.append(render(node instanceof HTMLTemplateElement ? node.content : node, scope, budget));
      fragment.append(copy);
    }
    // Comments are left out.
  }
  return fragment;
}

/** The value at a dotted path, reading only the data's own properties (and length). */
function lookup(scope: Scope, path: string): unknown {
  const not = path.startsWith("!");
  let value: unknown = scope;
  for (const name of (not ? path.slice(1) : path).split(".")) {
    if (value === null || value === undefined) break;
    const own = typeof value === "object" && Object.hasOwn(value, name);
    value = own || (name === "length" && (Array.isArray(value) || typeof value === "string")) ? (value as Record<string, unknown>)[name] : undefined;
  }
  return not ? !value : value;
}

const text = (value: unknown) => (value === null || value === undefined || value === false ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
const escapeText = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
