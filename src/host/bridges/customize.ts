// customize: what the Customize plugin (std/customize.js) needs from the page,
// through the authoring service: how each plugin's places went, which plugins
// run and which locked places each was let into, the samples the app offers,
// the file chooser, inspect mode (inspect.ts), arrange mode and pointing at a
// spot (arrange.ts), and a map of where plugins can go on this page: its
// slots, the parts its author named, and the ui-* elements views can use.
// No page needs it as it starts, so the host fetches this file the first time
// the kernel asks for it (bridges/index.ts): it imports nothing the page's own
// script holds, or the two would be split into a third file every page loads.

import { nameOf } from "../names";
import type { BridgeHost } from "./index";

/** True if a selector leans on the page's structure rather than names the author chose, so an edit to the page may break it. */
function fragile(selector: string): boolean {
  return /:nth-|:first-|:last-|:only-/.test(selector) || (selector.match(/>/g) ?? []).length > 2;
}

/** Files a person picks to add as a plugin: the plugin's .js and the files it lists, or an agent's .agent.md. */
const ACCEPT = ".js,.md,.html,.css,.json,.svg,.png,.jpg,.jpeg,.webp,.gif";
/** The most a pick reads, all files together. */
const MAX = 5_000_000;

/** Parts of the page a person might want a plugin beside: what the author named, and the landmarks. */
const PARTS = "[id], [data-part], [data-extend], header, nav, main, aside, footer, section, form, h1, h2";
/** The platform's own parts, which aren't the app's. */
const CHROME = '#inspect, #arrange, #review, #notice, slot[name="customize"]';

/** The page's own slots, each with the plugins drawing there now. */
function slots() {
  return [...document.querySelectorAll<HTMLElement>("slot[name]")]
    .filter((slot) => !slot.closest("[data-plugin]") && !slot.closest(CHROME))
    .map((slot) => ({ name: slot.getAttribute("name")!, plugins: [...new Set([...slot.querySelectorAll<HTMLElement>(":scope > [data-plugin]")].map((el) => el.dataset.plugin!))] }));
}

/** The page's named parts and landmarks, with the author's mark (open, review or locked) that governs adding inside each. */
function parts() {
  const seen = new Set<string>();
  const out: { selector: string; name: string; mark: string }[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>(PARTS)) {
    if (el.closest(".place, [data-plugin], slot") || el.closest(CHROME) || el.closest("[hidden], template")) continue;
    const selector = el.id ? `#${CSS.escape(el.id)}` : el.dataset.part ? `[data-part="${el.dataset.part}"]` : el.localName;
    if (seen.has(selector) || out.length >= 60) continue;
    // A bare tag that appears more than once isn't a name a place can count on.
    if (!el.id && !el.dataset.part && document.querySelectorAll(selector).length > 1) continue;
    seen.add(selector);
    const mark = el.closest("[data-extend]")?.getAttribute("data-extend") ?? "open";
    out.push({ selector, name: nameOf(el), mark: ["review", "locked"].includes(mark) ? mark : "open" });
  }
  return out;
}

export default ({ places, running, inspect, arrange }: BridgeHost) => ({
  state: () => ({
    // fragile: the selector leans on the page's layout, so an update to the app may break it.
    places: places.status().map((p) => ({ ...p, fragile: fragile(p.at) })),
    running: running().map(({ id, name, user, unlocked, moved, error }) => ({ id, name, user: !!user, unlocked: unlocked ?? [], moved: moved ?? [], ...(error ? { error } : {}) })),
    samples: [...document.querySelectorAll<HTMLLinkElement>('link[rel~="plugin-sample"]')].map((link) => ({ href: link.href, title: link.title || link.getAttribute("href") || "" })),
    inspect: !!inspect,
    arrange: !!arrange,
  }),
  /** Where plugins can go on this page, for Customize's Layout: its slots, its named parts and their marks, and the ui-* elements a view can use. */
  layout: async () => ({
    slots: slots(),
    parts: parts(),
    // What each element is for is words only this panel shows: fetched when it asks, so no page carries them.
    elements: Object.entries((await import("../../shared/html")).COMPONENTS).map(([tag, c]) => ({ tag, attributes: c.attributes, about: c.about })),
  }),
  arrange: async (plugin?: string, place?: string) => {
    if (!arrange) throw new Error("This page has no arrange mode");
    return (await arrange()).start(plugin, place);
  },
  choose: async (prompt?: string) => {
    if (!arrange) throw new Error("This page has no arrange mode");
    return (await arrange()).choose(prompt);
  },
  /** Opens the file chooser (only right after the person clicks) and reads what they pick, as text or as a Blob for images. */
  pick: (): Promise<{ name: string; data: string | Blob }[] | null> => {
    if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("Files can be chosen only right after the person clicks"));
    return new Promise((resolve, reject) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ACCEPT, multiple: true, hidden: true });
      input.addEventListener("cancel", () => resolve(null));
      input.addEventListener("change", () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (!files.length) return resolve(null);
        if (files.reduce((n, f) => n + f.size, 0) > MAX) return reject(new Error(`Pick at most ${MAX / 1_000_000} MB of files`));
        Promise.all(files.map(async (f) => ({ name: f.name, data: /\.(js|md|html|css|json|svg)$/.test(f.name) ? await f.text() : (f as Blob) }))).then(resolve, reject);
      });
      document.body.append(input);
      input.click();
    });
  },
  inspect: () => {
    if (!inspect) throw new Error("This page has no inspect mode");
    inspect();
    return true;
  },
});
