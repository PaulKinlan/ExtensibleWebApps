// Places: where a plugin draws in a page that has no slot for it. A plugin
// names its places in its manifest, each a CSS selector and what to put
// there, and renders to a place's name as it would to a slot:
//
//   places: { days: { at: "main > h1", put: "after" } }
//   ctx.ui.views("countdown.html").render("days", "days-left", data);
//
// The selector runs against the app's own page, never inside another
// plugin's view or the platform's own panels. Each match gets a container,
// a <div class="place">, next to it or inside it; `replace` hides the match
// while the container holds a view, and `hide` hides it outright. All of it
// is undone when the plugin stops, so turning a plugin off gives the page
// back exactly as it was.
//
// The author marks areas with data-extend="open" (the default), "review" or
// "locked", and the nearest mark wins. Adding before or after an element
// changes its parent, so the parent's mark applies; prepend, append,
// replace and hide change the element itself, so its own mark applies. A
// review place asks the person once (they can always allow it); a locked
// place is refused unless the person unlocked it for that plugin.

import type { Opened, Place } from "../shared/protocol";

export type PlaceState = "drawn" | "waiting" | "declined" | "locked" | "no match" | "bad selector";

interface Applied {
  plugin: string;
  name: string;
  place: Place;
  /** What the manifest said and what the person unlocked, to tell when it changed. */
  signature: string;
  state: PlaceState;
  targets: Element[];
  containers: HTMLElement[];
  /** Elements this place hid, with whether they were hidden before. */
  hidden: [Element, boolean][];
}

/** Elements a place may never match: plugins' views, other places, and the platform's own panels. */
const OFF_LIMITS = ".place, [data-plugin], #review, #notice, #customize, .customize";
const MAX_MATCHES = 200;
const STRICTNESS = ["open", "review", "locked"];

export interface PlacesHost {
  /** Asks the person about a review place; resolves true if they allow it. */
  ask(plugin: string, place: string, target: string, what: string): Promise<boolean>;
  /** Told when a plugin's places were set up again, so its views can be drawn into them. */
  changed(plugin: string): void;
  /** Reports a problem, for the trace. */
  report(text: string): void;
}

export function places(host: PlacesHost) {
  const applied = new Map<string, Applied>();
  const names = new Map<string, string>();
  const key = (plugin: string, name: string) => `${plugin}/${name}`;

  /** The author's mark that governs a change at `el`: the nearest data-extend, or open. */
  function markOf(el: Element, put: Place["put"]): string {
    const at = put === "before" || put === "after" ? el.parentElement : el;
    const mark = at?.closest("[data-extend]")?.getAttribute("data-extend");
    return mark && STRICTNESS.includes(mark) ? mark : "open";
  }

  /** How a review card names an element: its label or heading, as the person sees it, then how the page names it. */
  function describe(el: Element): string {
    const labelledBy = el.getAttribute("aria-labelledby");
    const name =
      el.getAttribute("aria-label") ??
      (labelledBy ? document.getElementById(labelledBy)?.textContent : undefined) ??
      el.querySelector("h1, h2, h3, h4, h5, h6")?.textContent ??
      el.textContent ??
      "";
    const words = name.trim().replace(/\s+/g, " ");
    const what = el.id ? `#${el.id}` : el.localName;
    return words ? `“${words.length > 40 ? `${words.slice(0, 40)}…` : words}” (${what})` : what;
  }

  const verbs: Record<Place["put"], string> = {
    before: "It will add a view before it.",
    after: "It will add a view after it.",
    prepend: "It will add a view at its start.",
    append: "It will add a view at its end.",
    replace: "It will hide it and show its own view instead.",
    hide: "It will hide it.",
  };

  function find(place: Place): Element[] | "bad selector" {
    let all: Element[];
    try {
      all = [...document.body.querySelectorAll(place.at)];
    } catch {
      return "bad selector";
    }
    const ok = all.filter((el) => !el.closest(OFF_LIMITS));
    return place.each ? ok.slice(0, MAX_MATCHES) : ok.slice(0, 1);
  }

  function hide(a: Applied, el: Element) {
    if (a.hidden.some(([e]) => e === el)) return;
    a.hidden.push([el, el.hasAttribute("hidden")]);
    el.setAttribute("hidden", "");
  }

  /** Puts the containers in the page, now that the place may be used. */
  function draw(a: Applied) {
    a.state = "drawn";
    for (const el of a.targets) {
      el.classList.remove("place-pending");
      if (a.place.put === "hide") {
        hide(a, el);
        continue;
      }
      const container = document.createElement("div");
      container.className = "place";
      container.dataset.place = key(a.plugin, a.name);
      if (a.place.put === "before" || a.place.put === "replace") el.before(container);
      else if (a.place.put === "after") el.after(container);
      else if (a.place.put === "prepend") el.prepend(container);
      else el.append(container);
      a.containers.push(container);
    }
    host.changed(a.plugin);
  }

  async function apply(a: Applied, unlocked: string[]) {
    const found = find(a.place);
    if (found === "bad selector") {
      a.state = "bad selector";
      host.report(`${a.plugin}: the place ${a.name} has a selector the browser can't read: ${a.place.at}`);
      return;
    }
    a.targets = found;
    if (!found.length) {
      a.state = "no match";
      host.report(`${a.plugin}: the place ${a.name} matches nothing in this page (${a.place.at})`);
      return;
    }
    const mark = found.map((el) => markOf(el, a.place.put)).sort((x, y) => STRICTNESS.indexOf(y) - STRICTNESS.indexOf(x))[0];
    if (mark === "locked" && !unlocked.includes(a.name)) {
      a.state = "locked";
      host.report(`${a.plugin}: the place ${a.name} is in an area the app's author locked`);
      return;
    }
    if (mark === "review" && !unlocked.includes(a.name)) {
      a.state = "waiting";
      for (const el of found) el.classList.add("place-pending");
      const ok = await host.ask(a.plugin, a.name, describe(found[0]), verbs[a.place.put]);
      // It may have been taken down while the person decided.
      if (applied.get(key(a.plugin, a.name)) !== a) return;
      for (const el of found) el.classList.remove("place-pending");
      if (!ok) {
        a.state = "declined";
        return;
      }
    }
    draw(a);
  }

  function undo(a: Applied) {
    for (const container of a.containers) container.remove();
    for (const [el, was] of a.hidden) if (!was) el.removeAttribute("hidden");
    for (const el of a.targets) el.classList.remove("place-pending");
    a.containers = [];
    a.hidden = [];
  }

  return {
    /** Sets up the places of the plugins this page shows, and takes down the places of any that stopped. */
    configure(plugins: Opened[]) {
      const wanted = new Set<string>();
      for (const p of plugins) {
        if (!p.id || p.error || !p.places) continue;
        names.set(p.id, p.name ?? p.id);
        for (const [name, place] of Object.entries(p.places)) {
          const k = key(p.id, name);
          wanted.add(k);
          const signature = JSON.stringify([place, p.unlocked?.includes(name)]);
          const old = applied.get(k);
          if (old?.signature === signature) continue;
          if (old) undo(old);
          const a: Applied = { plugin: p.id, name, place, signature, state: "waiting", targets: [], containers: [], hidden: [] };
          applied.set(k, a);
          void apply(a, p.unlocked ?? []);
        }
      }
      for (const [k, a] of applied) {
        if (wanted.has(k)) continue;
        undo(a);
        applied.delete(k);
      }
    },

    /**
     * The containers a render to `slot` goes to, for the plugin that owns `owner`: every match of the
     * place named `slot`, or one match for `slot#index`. Undefined if the plugin has no such place.
     */
    containers(plugin: string, slot: string): [string, HTMLElement][] | undefined {
      const [name, index] = slot.split("#");
      const a = applied.get(key(plugin, name));
      if (!a) return undefined;
      const all = a.containers.map((c, i): [string, HTMLElement] => [`${key(plugin, name)}#${i}`, c]);
      return index === undefined ? all : all.filter((_, i) => String(i) === index);
    },

    /** Called after a container gains or loses its views: `replace` hides its match only while it holds one. */
    sync(container: HTMLElement, count: number) {
      for (const a of applied.values()) {
        const i = a.containers.indexOf(container);
        if (i < 0 || a.place.put !== "replace") continue;
        const el = a.targets[i];
        if (count) hide(a, el);
        else {
          const at = a.hidden.findIndex(([e]) => e === el);
          if (at >= 0) {
            if (!a.hidden[at][1]) el.removeAttribute("hidden");
            a.hidden.splice(at, 1);
          }
        }
      }
    },

    /** What a place matches, for `page.matches`: each element's text and data-* attributes. */
    matches(plugin: string, name: string): { text: string; data: Record<string, string> }[] {
      const a = applied.get(key(plugin, name));
      if (!a) throw new Error(`${plugin} has no place named ${name} in this page`);
      return a.targets.map((el) => ({ text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500), data: { ...(el as HTMLElement).dataset } as Record<string, string> }));
    },

    /** Every place and how it went, for the Customize panel. */
    status(): { plugin: string; name: string; at: string; put: string; each: boolean; state: PlaceState; matches: number }[] {
      return [...applied.values()].map((a) => ({ plugin: a.plugin, name: a.name, at: a.place.at, put: a.place.put, each: !!a.place.each, state: a.state, matches: a.targets.length }));
    },
  };
}

export type Places = ReturnType<typeof places>;

/** True if a selector leans on the page's structure rather than names the author chose, so an edit to the page may break it. */
export function fragile(selector: string): boolean {
  return /:nth-|:first-|:last-|:only-/.test(selector) || (selector.match(/>/g) ?? []).length > 2;
}
