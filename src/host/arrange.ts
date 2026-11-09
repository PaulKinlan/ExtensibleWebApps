// Arrange mode: the person moves plugins' views around the page. Every view
// that sits in a place (places.ts) and only adds something at one spot is
// outlined and named; the person picks one, from the page or the list, then
// points at where it should go and says above, below, or inside at the top
// or bottom. Up and down step it past its neighbour, and among views at the
// same spot change their order. Reset puts it back where its plugin said.
//
// Each move is kept by the kernel for this person and app (src/kernel/moves.ts)
// and used whenever the app opens; the plugin itself doesn't change. The
// author's marks still hold: a view moved into a locked area isn't drawn
// there, and Customize says so.
//
// `choose()` is the same pointing on its own, for a plugin that is being made:
// Customize's "Make a plugin" asks where the new plugin should draw.
//
// It is platform chrome, like inspect mode: plain DOM built here, which
// plugins can't draw into or point a place at.

import "./arrange.css";
import type { Command, Opened } from "../shared/protocol";
import type { Places } from "./places";
import { selectorFor } from "./inspect";
import { nameOf } from "./names";

export interface ArrangeHost {
  app: string;
  command(name: Command, arg?: unknown): Promise<unknown>;
  places: Places;
  running(): Opened[];
}

type Put = "before" | "after" | "prepend" | "append";
/** A spot on the page: a selector and where to put a view against what it matches. */
export interface Spot {
  at: string;
  put: Put;
  /** How the person would say it: “below “Stories” (h2)”. */
  label: string;
}

/** The platform's own parts of the page, never arranged or pointed at. */
const CHROME = '#arrange, #inspect, slot[name="customize"], #review, #notice';
const MOVABLE = new Set(["before", "after", "prepend", "append"]);
const SAY: Record<Put, string> = { before: "above", after: "below", prepend: "inside, at the top of", append: "inside, at the bottom of" };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

/** A view the person can move: one place of one plugin, drawn at one spot. */
interface Movable {
  plugin: string;
  place: string;
  name: string;
  put: Put;
  at: string;
  order: number;
  moved: boolean;
  containers: HTMLElement[];
}

export function arrange(host: ArrangeHost) {
  // A div, not an aside: an <aside> in the body gives an app page its second column (styles.css).
  const panel = h("div", { id: "arrange", class: "arrange", role: "dialog", "aria-label": "Arrange the page", tabindex: "-1", hidden: "" });
  document.body.append(panel);
  let on = false;
  /** The view being moved, or none while the person picks one. */
  let moving: Movable | undefined;
  /** Where the person pointed, waiting for above/below/inside. */
  let spot: Element | null = null;
  let hovered: Element | null = null;
  let message = "";
  /** Set while choose() waits: what to say, and who hears the spot. */
  let choosing: { prompt: string; done: (spot: Spot | null) => void } | undefined;

  const mark = (el: Element | null, cls: string) => {
    for (const old of document.querySelectorAll(`.${cls}`)) old.classList.remove(cls);
    el?.classList.add(cls);
  };

  /** Every view on the page the person can move, in page order. */
  function movables(): Movable[] {
    const names = new Map(host.running().map((p) => [p.id, p.name ?? p.id]));
    const moved = new Map(host.running().map((p) => [p.id, new Set(p.moved ?? [])]));
    return host.places
      .status()
      .filter((p) => p.state === "drawn" && !p.each && !p.in && MOVABLE.has(p.put))
      .map((p) => ({ plugin: p.plugin, place: p.name, name: names.get(p.plugin) ?? p.plugin, put: p.put as Put, at: p.at, order: p.order ?? 0, moved: !!moved.get(p.plugin)?.has(p.name), containers: host.places.drawn(p.plugin, p.name) }))
      .filter((m) => m.containers.length)
      .sort((a, b) => (a.containers[0].compareDocumentPosition(b.containers[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  /**
   * What the person sees of a view: a place's container takes no room of its own (display: contents), so
   * its first view stands for it.
   */
  const seen = (m: Movable) => m.containers[0].firstElementChild ?? m.containers[0];

  /** Names each movable view on the page while arranging, so the person sees what they can pick. */
  function label() {
    for (const old of document.querySelectorAll("[data-arrange]")) old.removeAttribute("data-arrange");
    if (!on || choosing) return;
    for (const m of movables()) for (const c of m.containers) for (const entry of c.children) entry.setAttribute("data-arrange", m.name);
  }

  /**
   * The element a spot is against: the page's own, never inside a plugin's view or a place, where places
   * can't reach. Pointing inside one means the slot or element it sits in.
   */
  function pageElement(el: Element | null): Element | null {
    while (el && el.closest(".place, [data-plugin]")) el = el.closest(".place, [data-plugin]")!.parentElement;
    if (!el || el === document.body || el === document.documentElement || el.closest(CHROME)) return null;
    return el;
  }

  async function save(m: Movable, to: { at: string; put: Put; order?: number } | null, said: string) {
    const result = (await host.command("place:move", { app: host.app, plugin: m.plugin, place: m.place, to })) as { ok?: boolean; error?: string } | undefined;
    message = result?.ok ? said : (result?.error ?? "That didn't work");
    moving = undefined;
    spot = null;
    mark(null, "arrange-spot");
    mark(null, "arrange-moving");
    // The kernel opens the app again with the new places; label them once they are drawn.
    setTimeout(() => {
      const now = movables().find((n) => n.plugin === m.plugin && n.place === m.place);
      if (to && result?.ok && !now) message = `${m.name} was moved, but it isn't showing there: the app's author may have locked that part of the page, or it is waiting for your OK. Customize says which.`;
      label();
      draw();
    }, 400);
    draw();
  }

  /** Steps a view past its neighbour: among views at the same spot it changes order; past the page's own element it moves to that element's other side. */
  function step(m: Movable, by: -1 | 1) {
    const first = m.containers[0];
    const last = m.containers[m.containers.length - 1];
    const sibling = (el: Element) => (by < 0 ? el.previousElementSibling : el.nextElementSibling);
    let next = sibling(by < 0 ? first : last);
    // Hidden things, scripts and other plugins' views at other spots aren't steps a person sees.
    while (next && (next.matches("script, style, template, link, meta, [hidden]") || next.closest(CHROME))) next = sibling(next);
    const peer = next ? movables().find((o) => o !== m && o.containers.includes(next as HTMLElement)) : undefined;
    if (peer && peer.at === m.at && peer.put === m.put) return save(m, { at: m.at, put: m.put, order: peer.order + by }, `${m.name} moved ${by < 0 ? "up" : "down"}.`);
    if (next && !next.matches(".place, [data-plugin]")) {
      const put: Put = by < 0 ? "before" : "after";
      return save(m, { at: selectorFor(next), put }, `${m.name} is now ${SAY[put]} ${nameOf(next)}.`);
    }
    if (next) {
      // Another plugin's view at another spot: go to the far side of the page element it belongs to.
      const owner = pageElement(next.parentElement);
      if (owner) return save(m, { at: selectorFor(next.parentElement!.closest(".place") ? owner : next.parentElement!), put: by < 0 ? "prepend" : "append" }, `${m.name} moved ${by < 0 ? "up" : "down"}.`);
    }
    // At the top or bottom of its part of the page: step out of it.
    const parent = first.parentElement;
    if (!parent || parent === document.body) {
      message = `${m.name} is already at the ${by < 0 ? "top" : "bottom"} of the page.`;
      return draw();
    }
    const put: Put = by < 0 ? "before" : "after";
    return save(m, { at: selectorFor(parent), put }, `${m.name} is now ${SAY[put]} ${nameOf(parent)}.`);
  }

  function pickView(m: Movable) {
    moving = m;
    spot = null;
    message = "";
    mark(seen(m), "arrange-moving");
    mark(null, "arrange-spot");
    draw();
  }

  /** The person pointed at a spot: offer above, below, or inside. */
  function pickSpot(el: Element) {
    spot = el;
    mark(null, "arrange-hover");
    mark(el, "arrange-spot");
    draw();
    panel.querySelector<HTMLButtonElement>("[data-put]")?.focus();
  }

  function put(where: Put) {
    if (!spot) return;
    const at = selectorFor(spot);
    const said = `${SAY[where]} ${nameOf(spot)}`;
    if (choosing) {
      const { done } = choosing;
      choosing = undefined;
      stop();
      return done({ at, put: where, label: said });
    }
    if (moving) void save(moving, { at, put: where }, `${moving.name} is now ${said}.`);
  }

  function draw() {
    panel.replaceChildren();
    const title = choosing ? choosing.prompt : moving ? `Moving ${moving.name}: point at where it should go, and click` : "Arrange: pick a view to move, on the page or here";
    panel.append(h("p", { class: "arrange-title" }, h("strong", {}, choosing ? "Choose a spot" : "Arrange"), ` · ${title}`));
    if (spot) {
      panel.append(h("p", {}, "Put it ", h("strong", {}, nameOf(spot)), ":"));
      const row = h("div", { class: "arrange-actions" });
      for (const where of ["before", "after", "prepend", "append"] as Put[]) {
        // Inside only makes sense for an element that holds others, not a heading's words or an input.
        if ((where === "prepend" || where === "append") && spot.matches("input, img, br, hr, textarea, select, button, h1, h2, h3, h4, h5, h6, p, a, label, code, span, strong, em")) continue;
        const b = h("button", { type: "button", "data-put": where }, { before: "Above it", after: "Below it", prepend: "Inside, at the top", append: "Inside, at the bottom" }[where]);
        b.addEventListener("click", () => put(where));
        row.append(b);
      }
      const back = h("button", { type: "button", class: "secondary" }, "Somewhere else");
      back.addEventListener("click", () => {
        spot = null;
        mark(null, "arrange-spot");
        draw();
      });
      row.append(back);
      panel.append(row);
    } else if (!moving && !choosing) {
      const list = h("ul", { class: "arrange-list" });
      const all = movables();
      if (!all.length) panel.append(h("p", { class: "muted" }, "No plugin's view on this page can be moved. A view in one of the app's slots goes where its author put it."));
      for (const m of all) {
        const move = h("button", { type: "button", "data-arrange-move": `${m.plugin}/${m.place}` }, "Move");
        move.addEventListener("click", () => pickView(m));
        const up = h("button", { type: "button", "aria-label": `Move ${m.name} up`, "data-arrange-up": `${m.plugin}/${m.place}` }, "↑");
        up.addEventListener("click", () => void step(m, -1));
        const down = h("button", { type: "button", "aria-label": `Move ${m.name} down`, "data-arrange-down": `${m.plugin}/${m.place}` }, "↓");
        down.addEventListener("click", () => void step(m, 1));
        let reset: HTMLButtonElement | null = null;
        if (m.moved) {
          reset = h("button", { type: "button", class: "secondary", "data-arrange-reset": `${m.plugin}/${m.place}` }, "Put back");
          reset.addEventListener("click", () => void save(m, null, `${m.name} is back where its plugin puts it.`));
        }
        const where = h("span", { class: "muted" }, ` ${SAY[m.put]} ${(() => {
          try {
            const el = document.querySelector(m.at);
            return el ? nameOf(el) : m.at;
          } catch {
            return m.at;
          }
        })()}${m.moved ? " · moved by you" : ""}`);
        const li = h("li", {}, h("span", {}, h("strong", {}, m.name), where), h("span", { class: "arrange-actions" }, up, down, move, reset));
        li.addEventListener("pointerenter", () => mark(seen(m), "arrange-hover"));
        li.addEventListener("pointerleave", () => mark(null, "arrange-hover"));
        list.append(li);
      }
      if (all.length) panel.append(list);
    }
    if (message) panel.append(h("p", { role: "status" }, message));
    const done = h("button", { type: "button", "data-arrange-done": "" }, choosing ? "Cancel" : moving ? "Cancel the move" : "Done");
    done.addEventListener("click", () => {
      if (moving && !choosing) {
        moving = undefined;
        spot = null;
        mark(null, "arrange-moving");
        mark(null, "arrange-spot");
        return draw();
      }
      cancel();
    });
    panel.append(done);
  }

  const targetOf = (e: Event) => (e.target instanceof Element && !e.target.closest(CHROME) ? e.target : null);
  const over = (e: Event) => {
    const el = targetOf(e);
    if (spot || !el) return;
    if (!moving && !choosing) {
      const view = movables().find((m) => m.containers.some((c) => c.contains(el)));
      return mark(view ? seen(view) : null, "arrange-hover");
    }
    hovered = pageElement(el);
    // A view can't go into itself.
    if (hovered && moving?.containers.some((c) => c.contains(hovered!) || hovered!.contains(c) && hovered === c)) hovered = null;
    mark(hovered, "arrange-hover");
  };
  const click = (e: Event) => {
    const el = targetOf(e);
    if (!el) return;
    // While arranging, a click picks; it doesn't press the button or follow the link.
    e.preventDefault();
    e.stopPropagation();
    if (!moving && !choosing) {
      const view = movables().find((m) => m.containers.some((c) => c.contains(el)));
      if (view) pickView(view);
      return;
    }
    const at = pageElement(el);
    if (at && !moving?.containers.some((c) => c.contains(at))) pickSpot(at);
  };
  /** Every part of the page a spot can be against, in reading order, for the keyboard. */
  const pointable = () => [...document.body.querySelectorAll("*")].filter((el) => !el.closest(CHROME) && !el.closest(".place, [data-plugin], script, style, template, [hidden]") && el.getClientRects().length > 0);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (spot) {
        spot = null;
        mark(null, "arrange-spot");
        draw();
      } else if (moving && !choosing) {
        moving = undefined;
        mark(null, "arrange-moving");
        draw();
      } else cancel();
      return;
    }
    if (spot || !(moving || choosing) || (e.target instanceof Element && e.target.closest("#arrange button"))) return;
    const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (by) {
      e.preventDefault();
      const all = pointable();
      const i = hovered ? all.indexOf(hovered) : -1;
      hovered = all[i < 0 ? (by > 0 ? 0 : all.length - 1) : (i + by + all.length) % all.length] ?? null;
      mark(hovered, "arrange-hover");
      hovered?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && hovered) {
      e.preventDefault();
      pickSpot(hovered);
    }
  };

  function begin() {
    if (!on) {
      on = true;
      document.body.classList.add("arranging");
      panel.hidden = false;
      document.addEventListener("pointerover", over, true);
      document.addEventListener("click", click, true);
      document.addEventListener("keydown", key, true);
    }
    message = "";
    spot = null;
    label();
    draw();
    panel.focus();
  }

  function stop() {
    on = false;
    moving = undefined;
    spot = hovered = null;
    for (const cls of ["arrange-hover", "arrange-spot", "arrange-moving"]) mark(null, cls);
    label();
    document.body.classList.remove("arranging");
    panel.hidden = true;
    document.removeEventListener("pointerover", over, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
  }

  /** Done, or Escape: stop, and tell a waiting choose() the person changed their mind. */
  function cancel() {
    const waiting = choosing;
    choosing = undefined;
    stop();
    waiting?.done(null);
  }

  return {
    /** Starts arrange mode; with a plugin (and one of its places), that view is picked to move. */
    start(plugin?: string, place?: string) {
      if (choosing) cancel();
      begin();
      const m = plugin ? movables().find((v) => v.plugin === plugin && (!place || v.place === place)) : undefined;
      if (m) pickView(m);
      else if (plugin) {
        message = "That plugin has no view on this page that can be moved: it draws in one of the app's slots, or isn't on.";
        draw();
      }
      return true;
    },
    /** Asks the person to point at a spot on the page; null if they cancel. */
    choose(prompt = "Point at where it should go, and click"): Promise<Spot | null> {
      if (choosing) cancel();
      return new Promise((resolve) => {
        choosing = { prompt, done: resolve };
        begin();
      });
    },
    /** Labels the views again after the app's plugins changed (a move took effect). */
    refresh() {
      if (on) {
        label();
        if (!moving && !spot && !choosing) draw();
      }
    },
    stop: cancel,
    get on() {
      return on;
    },
  };
}

export type Arranger = ReturnType<typeof arrange>;
