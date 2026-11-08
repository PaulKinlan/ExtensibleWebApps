// Inspect mode: the person points at any part of the page and sees who drew
// it (which plugin, in which slot, under which key, or the app's own page),
// then changes it. Every change is a small plugin of the person's own, made
// here and added to this app like any other: a place that hides the part, or
// one that adds a note beside it. Inside another plugin's view the place is a
// view transform (`in`, with ui:transform:<plugin>). So the author's locks
// still hold, Customize lists the change, and turning it off undoes it.
//
// It is platform chrome, like Customize: plain DOM built here, which plugins
// can't draw into or point a place at.

import type { Command } from "../shared/protocol";

export interface InspectHost {
  app: string;
  command(name: Command, arg?: unknown): Promise<unknown>;
}

/** Parts of the page that are the platform's own, never inspected. */
const CHROME = "#inspect, #customize, .customize-button, #review, #notice";
/** data-* attributes the platform sets, which say nothing the author chose. */
const OURS = new Set(["data-plugin", "data-key", "data-place", "data-owner", "data-canvas"]);

/** What drew an element: a plugin's view entry, or the app's page. */
export interface Origin {
  plugin?: string;
  key?: string;
  slot?: string;
}

/** The view entry an element is in, if it is in one, and what that entry says about it. */
export function originOf(el: Element): Origin & { entry?: HTMLElement } {
  const entry = el.closest<HTMLElement>("[data-plugin][data-key]");
  if (!entry) return {};
  const place = entry.parentElement?.closest<HTMLElement>("slot[name], .place[data-place]");
  const slot = place?.localName === "slot" ? place.getAttribute("name")! : place?.dataset.place;
  return { entry, plugin: entry.dataset.plugin, key: entry.dataset.key, slot };
}

const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** One step of a selector for `el`: its tag with the attribute the author most likely chose to name it by. */
function step(el: Element, inView: boolean): string {
  const tag = el.localName;
  // In a view, ids are prefixed with the plugin's instance, so they don't last; on the page they're the best name there is.
  if (!inView && el.id) return `#${CSS.escape(el.id)}`;
  for (const { name, value } of [...el.attributes]) if (name.startsWith("data-") && !OURS.has(name) && value && value.length <= 80) return `${tag}[${name}=${quote(value)}]`;
  for (const name of ["aria-label", "name", "role"]) {
    const value = el.getAttribute(name);
    if (value && value.length <= 80) return `${tag}[${name}=${quote(value)}]`;
  }
  return tag;
}

/**
 * A selector that finds `el` again, as places run it: against the page, or (in a view) among the
 * elements in that plugin's views. Names the author chose come first; positions only when nothing else
 * tells it apart, which Customize then flags as fragile.
 */
export function selectorFor(el: Element): string {
  const { entry, plugin } = originOf(el);
  const root = entry ?? document.body;
  const within = (sel: string) => {
    try {
      return [...document.body.querySelectorAll(sel)].filter((m) => (plugin ? originOf(m).plugin === plugin && m.closest("[data-plugin][data-key]") !== m : !m.closest("[data-plugin], .place")));
    } catch {
      return [];
    }
  };
  let selector = "";
  let at: Element | null = el;
  for (let depth = 0; at && at !== root && depth < 5; depth++, at = at.parentElement) {
    selector = selector ? `${step(at, !!plugin)} > ${selector}` : step(at, !!plugin);
    const found = within(selector);
    if (found.length === 1 && found[0] === el) return selector;
    if (selector.startsWith("#")) break;
  }
  // Nothing names it apart: say where it is among its kind.
  const parent = el.parentElement;
  const nth = parent ? [...parent.children].filter((c) => c.localName === el.localName).indexOf(el) + 1 : 1;
  const own = `${step(el, !!plugin)}:nth-of-type(${nth})`;
  const parentStep = parent && parent !== root ? `${step(parent, !!plugin)} > ` : "";
  return `${parentStep}${own}`;
}

/** How the person sees an element: its label, heading or first words. */
function label(el: Element): string {
  // Its own words: not what places or other plugins' views added inside it.
  const copy = el.cloneNode(true) as Element;
  for (const added of copy.querySelectorAll(".place, slot")) added.remove();
  const words = (el.getAttribute("aria-label") ?? copy.querySelector("h1, h2, h3, h4")?.textContent ?? copy.textContent ?? "").trim().replace(/\s+/g, " ");
  return words ? (words.length > 40 ? `${words.slice(0, 40)}…` : words) : el.localName;
}

/** A plugin id for something the person made here: hide-the-dentist-row-3f. */
function idFor(kind: string, el: Element): string {
  const words = label(el).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return `${kind}-${words || el.localName}-${Math.random().toString(36).slice(2, 5)}`.replace(/^([^a-z])/, "x$1");
}

/** The source of a plugin the person made in inspect mode. Its manifest is a plain literal, as every manifest must be. */
export function madePlugin(kind: "hide" | "note", el: Element, text = ""): { id: string; source: string } {
  const { plugin } = originOf(el);
  const at = selectorFor(el);
  const id = idFor(kind, el);
  const place: Record<string, unknown> = { at, put: kind === "hide" ? "hide" : "after", ...(plugin && { in: plugin }) };
  const manifest = {
    id,
    name: kind === "hide" ? `Hide “${label(el)}”` : `Note by “${label(el)}”`,
    description: `Made in inspect mode: ${kind === "hide" ? "hides" : "adds a note after"} ${at}${plugin ? ` in ${plugin}'s view` : ""}.`,
    version: "1.0.0",
    permissions: plugin ? ["ui", `ui:transform:${plugin}`] : ["ui"],
    places: { it: place },
  };
  const body = kind === "hide" ? "export default function () {}\n" : `export default function (ctx) {\n  ctx.ui.render("it", "note", { type: "text", text: ${JSON.stringify(text)} });\n}\n`;
  return { id, source: `// Made in inspect mode. Customize turns it off or removes it.\nexport const manifest = ${JSON.stringify(manifest, null, 2)};\n\n${body}` };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

export function inspect(host: InspectHost) {
  const panel = h("aside", { id: "inspect", class: "inspect", role: "dialog", "aria-label": "Inspect", hidden: "" });
  document.body.append(panel);
  let on = false;
  let hovered: Element | null = null;
  let picked: Element | null = null;
  let message = "";

  const mark = (el: Element | null, cls: string) => {
    for (const old of document.querySelectorAll(`.${cls}`)) old.classList.remove(cls);
    el?.classList.add(cls);
  };
  const target = (e: Event) => {
    const el = e.target instanceof Element ? e.target : null;
    return el && !el.closest(CHROME) && el !== document.body && el !== document.documentElement ? el : null;
  };

  function who(el: Element): HTMLElement {
    const o = originOf(el);
    return o.plugin
      ? h("p", {}, "Drawn by ", h("strong", {}, o.plugin), o.slot ? ` in ${o.slot}` : "", o.key ? h("span", { class: "muted" }, ` · key ${o.key}`) : "")
      : h("p", {}, "Part of the app's own page");
  }

  async function make(kind: "hide" | "note", el: Element, text?: string) {
    const { id, source } = madePlugin(kind, el, text);
    const added = (await host.command("user:add", { app: host.app, files: [{ name: `${id}.js`, data: source }] })) as { ok?: boolean; error?: string } | undefined;
    if (!added?.ok) {
      message = added?.error ?? "That didn't work";
      return draw();
    }
    await host.command("user:on", { app: host.app, id });
    message = `${kind === "hide" ? "Hidden" : "Note added"}. Customize lists it as one of your plugins, to turn off or remove.`;
    picked = null;
    mark(null, "inspect-picked");
    draw();
  }

  function draw() {
    panel.replaceChildren();
    const done = h("button", { type: "button" }, "Done");
    done.addEventListener("click", () => stop());
    const el = picked ?? hovered;
    panel.append(h("p", { class: "inspect-title" }, h("strong", {}, "Inspect"), " · point at any part of the page, then click it"));
    if (el) {
      panel.append(who(el), h("p", {}, h("code", {}, selectorFor(el))));
    }
    if (picked) {
      const hide = h("button", { type: "button", "data-inspect": "hide" }, "Hide this");
      hide.addEventListener("click", () => void make("hide", picked!));
      const note = h("input", { type: "text", "aria-label": "A note to add after it", placeholder: "A note to add after it" });
      const add = h("button", { type: "button", "data-inspect": "note" }, "Add note");
      add.addEventListener("click", () => {
        if (note.value.trim()) void make("note", picked!, note.value.trim());
      });
      panel.append(h("div", { class: "inspect-actions" }, hide, note, add));
    }
    if (message) panel.append(h("p", { role: "status" }, message));
    panel.append(done);
  }

  const over = (e: Event) => {
    const el = target(e);
    if (picked || !el) return;
    hovered = el;
    mark(el, "inspect-hover");
    draw();
  };
  const click = (e: Event) => {
    const el = target(e);
    if (!el) return;
    // While inspecting, a click picks; it doesn't press the button or follow the link.
    e.preventDefault();
    e.stopPropagation();
    picked = el;
    message = "";
    mark(null, "inspect-hover");
    mark(el, "inspect-picked");
    draw();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (picked) {
      picked = null;
      mark(null, "inspect-picked");
      draw();
    } else stop();
  };

  function start() {
    if (on) return;
    on = true;
    message = "";
    document.body.classList.add("inspecting");
    panel.hidden = false;
    document.addEventListener("pointerover", over, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    draw();
  }

  function stop() {
    on = false;
    picked = hovered = null;
    mark(null, "inspect-hover");
    mark(null, "inspect-picked");
    document.body.classList.remove("inspecting");
    panel.hidden = true;
    document.removeEventListener("pointerover", over, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
  }

  return { start, stop, get on() { return on; } };
}
