// Loads the custom elements views use. Each element is one file in
// /elements/, named after its tag: ui-table is /elements/ui-table.html. The
// file holds a <template> (the element's shadow content and style) and, if
// the element needs behaviour, a module script, inline or linked by src,
// whose default export is the element's class. Nothing is built: the browser
// runs the files as they are written.
//
// An element is loaded the first time a view uses it. A file with no script
// gets a class from templateElement() below, which fills {{name}} holes from
// the element's attributes.

import { cleanCss } from "./plugin-styles";
import { sanitizeFragment, setUserComponent } from "./sanitize";
import { html } from "./trusted";

const BASE = new URL("/elements/", location.href);
const loading = new Map<string, Promise<void>>();
/** Custom zero-script `ui-*` components added by the person or an agent, hot-reloadable in place. */
const userElements = new Map<string, { html: string; template: HTMLTemplateElement; instances: Set<{ refresh(): void }> }>();
let reportError: (name: string, error: unknown) => void = () => {};

/** Tells `fn` when an element's file can't be loaded, so the host can report it. */
export function onElementError(fn: (name: string, error: unknown) => void): void {
  reportError = fn;
}

/** Element classes get their template as a static property. */
type ElementClass = CustomElementConstructor & { template?: HTMLTemplateElement };

/** Starts loading every ui-* element under `root` that isn't defined yet. */
export function defineElementsIn(root: ParentNode): void {
  for (const el of root.querySelectorAll(":not(:defined)")) if (el.localName.startsWith("ui-")) void loadElement(el.localName);
}

/** Loads and defines one element; repeated calls share the first load. */
export function loadElement(name: string): Promise<void> {
  if (userElements.has(name)) return Promise.resolve();
  let pending = loading.get(name);
  if (!pending) {
    pending = define(name).catch((error) => {
      // Forget the failure so a later render can try again.
      loading.delete(name);
      console.warn(`Couldn't load <${name}>:`, error);
      reportError(name, error);
    });
    loading.set(name, pending);
  }
  return pending;
}

async function define(name: string): Promise<void> {
  const url = new URL(`${name}.html`, BASE);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const file = new DOMParser().parseFromString(html(await response.text()), "text/html");
  const template = file.querySelector("template") ?? undefined;
  const script = file.querySelector<HTMLScriptElement>('script[type="module"]');
  // The elements its own template uses load alongside it, not after it is first drawn.
  for (const inner of template?.content.querySelectorAll("*") ?? []) if (inner.localName.startsWith("ui-") && inner.localName !== name && !customElements.get(inner.localName)) void loadElement(inner.localName);

  let element: ElementClass;
  if (script?.hasAttribute("src")) {
    element = (await import(/* @vite-ignore */ new URL(script.getAttribute("src")!, url).href)).default;
  } else if (script) {
    // Inline behaviour runs from a blob: URL, so relative imports don't work in it; link a file for those.
    const blob = URL.createObjectURL(new Blob([script.textContent ?? ""], { type: "text/javascript" }));
    try {
      element = (await import(/* @vite-ignore */ blob)).default;
    } finally {
      URL.revokeObjectURL(blob);
    }
  } else {
    element = templateElement(template);
  }
  if (template) element.template = template;
  if (!customElements.get(name)) customElements.define(name, element);
}

const HOLE = /\{\{\s*([a-z][\w-]*)\s*\}\}/gi;

/**
 * A class for an element with no script: its template, with each {{name}}
 * in text or an attribute value filled from the attribute of that name.
 * Values go in as text, never parsed as HTML.
 */
export function templateElement(template: HTMLTemplateElement | undefined): ElementClass {
  const names = new Set<string>();
  for (const match of (template?.innerHTML ?? "").matchAll(HOLE)) names.add(match[1].toLowerCase());

  return class TemplateElement extends HTMLElement {
    static template = template;
    static observedAttributes = [...names];
    /** Every text node or attribute with holes, and what it said before they were filled. */
    private parts: { node: Text | Attr; source: string }[] = [];

    connectedCallback() {
      if (!this.shadowRoot && template) {
        const content = document.importNode(template.content, true);
        this.parts = holes(content);
        this.attachShadow({ mode: "open" }).append(content);
      }
      this.fill();
    }

    attributeChangedCallback() {
      if (this.shadowRoot) this.fill();
    }

    private fill() {
      for (const { node, source } of this.parts) {
        const value = source.replace(HOLE, (_, name: string) => this.getAttribute(name.toLowerCase()) ?? "");
        if (node instanceof Text) node.data = value;
        else node.value = value;
      }
    }
  };
}

function holes(root: Node): { node: Text | Attr; source: string }[] {
  const found: { node: Text | Attr; source: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // A style's text is CSS, not a place for values.
    if (node instanceof Text && node.parentElement?.localName !== "style" && /\{\{/.test(node.data)) found.push({ node, source: node.data });
    if (node instanceof Element) for (const attr of node.attributes) if (/\{\{/.test(attr.value)) found.push({ node: attr, source: attr.value });
  }
  return found;
}

/** Builds a safe shadow <template> for a user/agent component: cleaned CSS, sanitized markup, preserved <slot>s, zero script. */
function safeComponentTemplate(tag: string, rawHtml: string): HTMLTemplateElement {
  const file = new DOMParser().parseFromString(html(rawHtml), "text/html");
  const source = file.querySelector("template");
  const out = document.createElement("template");
  if (!source) return out;
  const css = [...source.content.querySelectorAll("style"), ...[...file.querySelectorAll("style")].filter((s) => !source.content.contains(s))]
    .map((s) => cleanCss(s.textContent ?? ""))
    .filter(Boolean)
    .join("\n");
  if (css) {
    const style = document.createElement("style");
    style.textContent = `*, *::before, *::after { box-sizing: border-box; }\n${css}`;
    out.content.append(style);
  }
  const copySlots = (from: ParentNode, into: ParentNode) => {
    for (const child of [...from.childNodes]) {
      if (child instanceof Element && child.localName === "slot") {
        const s = document.createElement("slot");
        const slotName = child.getAttribute("name");
        if (slotName && /^[\w-]{1,64}$/.test(slotName)) s.setAttribute("name", slotName);
        copySlots(child, s);
        into.append(s);
        continue;
      }
      const scratch = document.createDocumentFragment();
      scratch.append(child.cloneNode(true));
      into.append(sanitizeFragment(scratch, tag, { remote: false }));
    }
  };
  copySlots(source.content, out.content);
  return out;
}

/** Installs, updates or removes the person's custom `ui-*` template components; true when the allowed tag set changed. */
export function syncUserComponents(list: { tag: string; html: string }[]): boolean {
  let tagsChanged = false;
  const active = new Set<string>();
  for (const { tag, html: source } of list) {
    if (!/^ui-[a-z][a-z0-9-]{1,46}$/.test(tag)) continue;
    active.add(tag);
    setUserComponent(tag, true);
    const existing = userElements.get(tag);
    if (existing && existing.html === source) continue;
    if (!existing || !existing.html) tagsChanged = true;
    const template = safeComponentTemplate(tag, source);
    if (existing) {
      existing.html = source;
      existing.template = template;
      for (const instance of existing.instances) instance.refresh();
      continue;
    }
    const entry = { html: source, template, instances: new Set<{ refresh(): void }>() };
    userElements.set(tag, entry);
    if (!customElements.get(tag)) {
      customElements.define(
        tag,
        class UserComponent extends HTMLElement {
          private parts: { node: Text | Attr; source: string }[] = [];
          private observer?: MutationObserver;
          connectedCallback() {
            entry.instances.add(this);
            if (!this.shadowRoot) {
              const root = this.attachShadow({ mode: "open" });
              root.addEventListener("click", (e) => {
                const target = e.target instanceof Element ? e.target.closest("[data-action]") : null;
                if (!target || target.matches("input, select, textarea, form")) return;
                this.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action: target.getAttribute("data-action")!, value: target.getAttribute("data-value") ?? undefined } }));
              });
            }
            this.refresh();
            this.observer ??= new MutationObserver(() => this.fill());
            this.observer.observe(this, { attributes: true });
          }
          disconnectedCallback() {
            entry.instances.delete(this);
            this.observer?.disconnect();
          }
          refresh() {
            if (!this.shadowRoot) return;
            const content = document.importNode(entry.template.content, true);
            this.parts = holes(content);
            this.shadowRoot.replaceChildren(content);
            this.fill();
          }
          private fill() {
            for (const { node, source: raw } of this.parts) {
              const value = raw.replace(HOLE, (_, attr: string) => this.getAttribute(attr.toLowerCase()) ?? "");
              if (node instanceof Text) node.data = value;
              else node.value = value;
            }
          }
        },
      );
    }
  }
  for (const [tag, entry] of userElements) {
    if (active.has(tag) || !entry.html) continue;
    tagsChanged = true;
    setUserComponent(tag, false);
    entry.html = "";
    entry.template = document.createElement("template");
    for (const instance of entry.instances) instance.refresh();
  }
  return tagsChanged;
}
