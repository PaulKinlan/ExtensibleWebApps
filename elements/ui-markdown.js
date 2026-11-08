// @ts-check
// <ui-markdown>: fetches a Markdown file and draws it. See ui-markdown.html.

import { parse } from "./markdown.js";
import { draw } from "./mermaid.js";

/** Kinds of file the site serves to be looked at or run, rather than read as source. */
const SHOWN = /\.(html|png|jpe?g|gif|svg|webp|avif)$/i;

export default class UiMarkdown extends HTMLElement {
  /** @type {HTMLTemplateElement | undefined} */
  static template;
  static observedAttributes = ["src", "pages", "repo"];
  /** Counts loads, so a slow one that a newer one overtook is dropped. */
  #load = 0;
  /** The page's title as it loaded, which sets-title adds to. */
  static #title = document.title;

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      const template = /** @type {typeof UiMarkdown} */ (this.constructor).template;
      if (template) root.append(document.importNode(template.content, true));
      root.addEventListener("click", (event) => this.#jump(/** @type {MouseEvent} */ (event)));
      addEventListener("popstate", () => this.#mark());
    }
    void this.#render();
  }

  /** @param {string} name @param {string | null} before @param {string | null} after */
  attributeChangedCallback(name, before, after) {
    if (this.shadowRoot && before !== after) void this.#render();
  }

  /** The file's address. */
  get #file() {
    return new URL(this.getAttribute("src") ?? "", document.baseURI);
  }

  async #render() {
    const article = this.shadowRoot?.querySelector("article");
    const src = this.getAttribute("src");
    if (!article || !src) return;
    const load = ++this.#load;
    const file = this.#file;
    let text;
    try {
      if (file.origin !== location.origin) throw new Error("only files from this site");
      const response = await fetch(file);
      if (!response.ok) throw new Error(String(response.status));
      // A server may answer a missing file with a page (a single-page fallback): that isn't Markdown.
      if ((response.headers.get("Content-Type") ?? "").includes("text/html")) throw new Error("not Markdown");
      text = await response.text();
    } catch {
      if (load !== this.#load) return;
      const missing = document.createElement("p");
      missing.className = "missing";
      missing.textContent = "This page isn't here. ";
      const pages = this.getAttribute("pages");
      if (pages) {
        const home = document.createElement("a");
        home.href = pages;
        home.textContent = "Go to the start of the docs.";
        missing.append(home);
      }
      article.replaceChildren(missing);
      return;
    }
    if (load !== this.#load) return;
    /** @type {[string, HTMLElement][]} */
    const diagrams = [];
    const content = parse(text, {
      link: (href) => this.#link(href),
      image: (src) => this.#image(src),
      code: (lang, code) => {
        if (lang !== "mermaid") return undefined;
        const figure = document.createElement("figure");
        figure.className = "diagram";
        figure.innerHTML = '<p class="waiting">Drawing the diagram…</p>';
        diagrams.push([code, figure]);
        return figure;
      },
    });
    article.replaceChildren(content);
    for (const [code, figure] of diagrams) void draw(code, figure);
    if (this.hasAttribute("sets-title")) {
      const heading = article.querySelector("h1")?.textContent;
      document.title = heading && heading !== UiMarkdown.#title ? `${heading} · ${UiMarkdown.#title}` : UiMarkdown.#title;
    }
    this.#mark();
    // A link to a part of this page (guide/agents#hooks) scrolls to it once it's drawn.
    if (this.hasAttribute("sets-title") && location.hash) this.#scrollTo(decodeURIComponent(location.hash.slice(1)));
    this.dispatchEvent(new Event("load"));
  }

  /** Where a link goes: a screen for a page of the docs, the repository for source, or as written. */
  /** @param {string} href */
  #link(href) {
    if (!href) return "";
    if (href.startsWith("#")) return href;
    let url;
    try {
      url = new URL(href, this.#file);
    } catch {
      return "";
    }
    if (url.protocol === "mailto:") return url.href;
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.origin !== location.origin) return url.href;
    const pages = this.getAttribute("pages");
    if (pages && url.pathname.startsWith(pages) && url.pathname.endsWith(".md")) {
      const screen = url.pathname.slice(0, -3).replace(/(^|\/)README$/, "$1");
      return screen + url.search + url.hash;
    }
    // A path from the site's root (/workbench/) is an address on the site; a relative one names a file.
    const repo = this.getAttribute("repo");
    if (repo && !href.startsWith("/") && !SHOWN.test(url.pathname)) {
      const folder = url.pathname.endsWith("/");
      return `${repo}/${folder ? "tree" : "blob"}/main${url.pathname}${url.hash}`;
    }
    return url.pathname + url.search + url.hash;
  }

  /** An image's address: from this site, or any https address. */
  /** @param {string} src */
  #image(src) {
    try {
      const url = new URL(src, this.#file);
      return url.origin === location.origin || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  /** Marks the link to the page being shown, in a list of contents. */
  #mark() {
    for (const a of this.shadowRoot?.querySelectorAll("a[href]") ?? []) {
      const href = /** @type {HTMLAnchorElement} */ (a).href;
      const here = new URL(href).pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, "");
      if (here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }

  /** A link to a heading on this page scrolls to it: the browser can't find ids inside the element. */
  /** @param {MouseEvent} event */
  #jump(event) {
    const link = event.composedPath().find((/** @type {EventTarget} */ el) => el instanceof HTMLAnchorElement);
    const href = link instanceof HTMLAnchorElement ? link.getAttribute("href") : null;
    if (!href?.startsWith("#") || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    history.replaceState(history.state, "", `${location.pathname}${location.search}#${encodeURIComponent(id)}`);
    this.#scrollTo(id);
  }

  /** @param {string} id */
  #scrollTo(id) {
    const target = this.shadowRoot?.getElementById(id);
    target?.scrollIntoView({ block: "start" });
  }
}
