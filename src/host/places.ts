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
// place is refused unless the person unlocked it for that plugin. Replace
// and hide take everything inside the element with them, so a mark anywhere
// inside it counts too: hiding <main> can't take a locked section with it.
//
// A place with `in: "<plugin>"` is a view transform: its selector runs inside
// that plugin's views instead of the page, and only marks inside those views
// count. Each time the plugin draws, its transforms are taken down before the
// update and put back after it, and the transforming plugin hears
// "place:changed" if what the place matches changed, so it can draw again.

import type { Opened, Place } from "../shared/protocol";

/** "slot": the page has a <slot> of the place's name, so the plugin's views go there and the place isn't used. */
export type PlaceState = "drawn" | "waiting" | "declined" | "locked" | "no match" | "bad selector" | "slot";

interface Applied {
  plugin: string;
  name: string;
  place: Place;
  /** What the manifest said and what the person unlocked, to tell when it changed. */
  signature: string;
  state: PlaceState;
  /** The places the person unlocked for this plugin, and whether they allowed this one on a review card. */
  unlocked: string[];
  allowed: boolean;
  /** What the place matched when last drawn, to tell the plugin when that changes. */
  seen: string;
  targets: Element[];
  containers: HTMLElement[];
  /** Elements this place hid. */
  hidden: Element[];
}

/** Whether the page itself (not a plugin's view) has a <slot> of this name. */
const pageHasSlot = (name: string) => [...document.querySelectorAll(`slot[name="${CSS.escape(name)}"]`)].some((slot) => !slot.closest("[data-plugin]"));

/** Elements a place may never match: plugins' views, other places, and the platform's own panels. */
const OFF_LIMITS = ".place, [data-plugin], #review, #notice, #inspect, #arrange";
/** The platform's own panels, which a transform can't reach either. */
const PLATFORM = "#review, #notice, #inspect, #arrange";
const MAX_MATCHES = 200;
const STRICTNESS = ["open", "review", "locked"];

export interface PlacesHost {
  /** Asks the person about a review place; resolves true if they allow it. */
  ask(plugin: string, place: string, target: string, what: string): Promise<boolean>;
  /** Told when one of a plugin's places was set up again, so its views can be drawn into it; `moved` if what it matches changed. */
  changed(plugin: string, name: string, moved: boolean): void;
  /** Reports a problem, for the trace. */
  report(text: string): void;
}

/**
 * Who hides each element, and whether it was hidden before the first of them. Two places may hide the
 * same element; it shows again only when the last of them lets go, and only if it was showing before.
 */
const hiders = new Map<Element, { by: Set<object>; was: boolean }>();

/** Where each container was put, so views placed at the same spot keep the order the person gave them (Place.order). */
const anchors = new WeakMap<Element, { el: Element; put: Place["put"]; order: number }>();

/** Moves a container among the others put at the same spot, lower `order` first. Equal orders stay as they were put. */
function settle(container: HTMLElement) {
  const me = anchors.get(container);
  if (!me) return;
  const peer = (n: Element | null) => {
    const a = n ? anchors.get(n) : undefined;
    return a && a.el === me.el && a.put === me.put ? a : undefined;
  };
  for (let prev = container.previousElementSibling; prev && (peer(prev)?.order ?? -Infinity) > me.order; prev = container.previousElementSibling) prev.before(container);
  for (let next = container.nextElementSibling; next && (peer(next)?.order ?? Infinity) < me.order; next = container.nextElementSibling) next.after(container);
}

export function places(host: PlacesHost) {
  const applied = new Map<string, Applied>();
  /** Plugins whose transforms are being put back now: drawing into them may draw a view that has transforms of its own. */
  const redoing = new Set<string>();
  const names = new Map<string, string>();
  const key = (plugin: string, name: string) => `${plugin}/${name}`;

  /** The author's mark that governs a change at `el`: the nearest data-extend, or open. */
  function markOf(el: Element, put: Place["put"], within?: Element): string {
    const at = put === "before" || put === "after" ? el.parentElement : el;
    const mark = at?.closest("[data-extend]");
    // In a transform, only the marks in the plugin's own view count, not the page's around it.
    const marks = [mark && (!within || within.contains(mark)) ? mark.getAttribute("data-extend") : null];
    // Replace and hide hide the whole element, so the marks inside it count as well.
    if (put === "replace" || put === "hide") for (const inner of el.querySelectorAll("[data-extend]")) marks.push(inner.getAttribute("data-extend"));
    return strictest(marks.map((m) => (m && STRICTNESS.includes(m) ? m : "open")));
  }
  const strictest = (marks: string[]) => [...marks].sort((x, y) => STRICTNESS.indexOf(y) - STRICTNESS.indexOf(x))[0] ?? "open";

  /** The page's own text in `el`: without plugins' views, places or the platform's panels, which a place may not read. */
  function ownText(el: Element): string {
    const copy = el.cloneNode(true) as Element;
    for (const inner of copy.querySelectorAll(OFF_LIMITS)) inner.remove();
    return (copy.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
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

  /** The view entry of `plugin` that holds `el`, if `el` is inside one (and not in another plugin's view or a place within it). */
  function viewOf(el: Element, plugin: string): HTMLElement | null {
    const entry = el.closest<HTMLElement>("[data-plugin]");
    if (!entry || entry === el || entry.dataset.plugin !== plugin || el.closest(PLATFORM)) return null;
    const place = el.closest(".place");
    return place && entry.contains(place) ? null : entry;
  }

  function find(place: Place): Element[] | "bad selector" {
    let all: Element[];
    try {
      // The body itself too, so a place `at: "body"` works: querySelectorAll looks only below it.
      all = [...(document.body.matches(place.at) ? [document.body] : []), ...document.body.querySelectorAll(place.at)];
    } catch {
      return "bad selector";
    }
    const ok = all.filter((el) => (place.in ? !!viewOf(el, place.in) : !el.closest(OFF_LIMITS)));
    return place.each ? ok.slice(0, MAX_MATCHES) : ok.slice(0, 1);
  }

  function hide(a: Applied, el: Element) {
    if (a.hidden.includes(el)) return;
    a.hidden.push(el);
    const entry = hiders.get(el) ?? { by: new Set(), was: el.hasAttribute("hidden") };
    entry.by.add(a);
    hiders.set(el, entry);
    el.setAttribute("hidden", "");
  }

  function unhide(a: Applied, el: Element) {
    const at = a.hidden.indexOf(el);
    if (at < 0) return;
    a.hidden.splice(at, 1);
    const entry = hiders.get(el);
    if (!entry) return;
    entry.by.delete(a);
    if (entry.by.size) return;
    hiders.delete(el);
    if (!entry.was) el.removeAttribute("hidden");
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
      anchors.set(container, { el, put: a.place.put, order: a.place.order ?? 0 });
      settle(container);
      a.containers.push(container);
    }
    const seen = JSON.stringify(a.targets.map((el) => [ownText(el), (el as HTMLElement).dataset]));
    const moved = seen !== a.seen;
    a.seen = seen;
    host.changed(a.plugin, a.name, moved);
  }

  async function apply(a: Applied) {
    const unlocked = a.unlocked;
    // The page's own <slot> of that name wins (the host renders there first), so the place gets no container and
    // isn't reported. What it matches is still kept, for page.matches. A `hide` place draws nothing, so it still applies.
    if (!a.place.in && a.place.put !== "hide" && pageHasSlot(a.name)) {
      const found = find(a.place);
      a.targets = Array.isArray(found) ? found : [];
      a.state = "slot";
      return;
    }
    const found = find(a.place);
    if (found === "bad selector") {
      a.state = "bad selector";
      host.report(`${a.plugin}: the place ${a.name} has a selector the browser can't read: ${a.place.at}`);
      return;
    }
    a.targets = found;
    if (!found.length) {
      a.state = "no match";
      // A transform matches nothing until its plugin draws, and again whenever it draws nothing to change.
      if (a.place.in) {
        if (a.seen !== "[]") host.changed(a.plugin, a.name, a.seen !== "");
        a.seen = "[]";
      } else host.report(`${a.plugin}: the place ${a.name} matches nothing in this page (${a.place.at})`);
      return;
    }
    const mark = strictest(found.map((el) => markOf(el, a.place.put, a.place.in ? (viewOf(el, a.place.in) ?? undefined) : undefined)));
    if (mark === "locked" && !unlocked.includes(a.name)) {
      a.state = "locked";
      host.report(`${a.plugin}: the place ${a.name} is in an area the app's author locked`);
      return;
    }
    if (mark === "review" && !unlocked.includes(a.name) && !a.allowed) {
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
      a.allowed = true;
      // The page (or the view, for a transform) may have changed while the person decided: look again.
      return apply(a);
    }
    draw(a);
  }

  function undo(a: Applied) {
    for (const container of a.containers) container.remove();
    for (const el of [...a.hidden]) unhide(a, el);
    for (const el of a.targets) el.classList.remove("place-pending");
    a.containers = [];
  }

  /** Callers waiting for a plugin's place to be set up: a plugin may ask about it while the page is still opening. */
  const waiting = new Set<() => void>();

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
          const a: Applied = { plugin: p.id, name, place, signature, state: "waiting", unlocked: p.unlocked ?? [], allowed: false, seen: "", targets: [], containers: [], hidden: [] };
          applied.set(k, a);
          void apply(a);
        }
      }
      for (const wake of [...waiting]) wake();
      for (const [k, a] of applied) {
        if (wanted.has(k)) continue;
        undo(a);
        applied.delete(k);
      }
    },

    /** Takes down the transforms of `plugin`'s views, before it draws: its update must not see them. */
    lift(plugin: string) {
      for (const a of applied.values()) if (a.place.in === plugin && a.state !== "waiting") undo(a);
    },

    /** Puts the transforms of `plugin`'s views back, after it drew (or after its views went). */
    redo(plugin: string) {
      // Two plugins transforming each other would put each other's transforms back forever.
      if (redoing.has(plugin)) return;
      redoing.add(plugin);
      try {
        for (const a of applied.values()) {
          if (a.place.in !== plugin || a.state === "waiting") continue;
          undo(a);
          void apply(a);
        }
      } finally {
        redoing.delete(plugin);
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
        else unhide(a, el);
      }
    },

    /**
     * What a place matches, for `page.matches`: each element's own text and data-* attributes. A plugin
     * may ask as it starts, before the page has heard about its places, so this waits for them a while.
     */
    async matches(plugin: string, name: string): Promise<{ text: string; data: Record<string, string> }[]> {
      const k = key(plugin, name);
      if (!applied.has(k))
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (!applied.has(k)) return;
            waiting.delete(wake);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            waiting.delete(wake);
            resolve();
          }, 10_000);
          waiting.add(wake);
        });
      const a = applied.get(k);
      if (!a) throw new Error(`${plugin} has no place named ${name} in this page`);
      return a.targets.map((el) => ({ text: ownText(el), data: { ...(el as HTMLElement).dataset } as Record<string, string> }));
    },

    /** Every place and how it went, for the Customize panel. */
    status(): { plugin: string; name: string; at: string; put: string; each: boolean; in?: string; order?: number; state: PlaceState; matches: number }[] {
      return [...applied.values()].map((a) => ({ plugin: a.plugin, name: a.name, at: a.place.at, put: a.place.put, each: !!a.place.each, ...(a.place.in && { in: a.place.in }), ...(a.place.order !== undefined && { order: a.place.order }), state: a.state, matches: a.targets.length }));
    },

    /** The containers one place drew, in page order: arrange mode (arrange.ts) outlines and moves them. */
    drawn(plugin: string, name: string): HTMLElement[] {
      return [...(applied.get(key(plugin, name))?.containers ?? [])];
    },
  };
}

export type Places = ReturnType<typeof places>;
