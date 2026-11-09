// Moves: where the person put a plugin's view, when they didn't want it
// where the plugin's manifest said. A plugin names its places
// (`places: { clock: { at: "main", put: "append" } }`); in Customize, or in
// the page's arrange mode (src/host/arrange.ts), the person picks another
// spot, and that spot is kept here, per app, and used instead each time the
// app opens. Nothing in the plugin changes, and resetting a move puts the
// view back where its author meant it.
//
// A move is only ever a selector and before/after/prepend/append, with an
// order among other views at the same spot, so it can't hide or replace
// anything; and the page's own marks still hold at the new spot (a locked
// area stays locked: places.ts checks it as for any place).
//
// Kept in the data folder at moves/<app>.json, which is the platform's, so
// no plugin can write it.

import type { Place } from "../shared/protocol";
import type { Store } from "./store";

/** Where the person moved one place to. */
export interface Moved {
  at: string;
  put: "before" | "after" | "prepend" | "append";
  /** Among views placed at the same spot, lower first. */
  order?: number;
}

/** Per app: plugin id, then place name, then where it goes. */
type Moves = Record<string, Record<string, Moved>>;

const PUTS = new Set(["before", "after", "prepend", "append"]);
const file = (app: string) => `moves/${app.replace(/\//g, "~")}.json`;

/** A move as given, checked: undefined if it isn't one. */
export function asMove(value: unknown): Moved | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { at, put, order } = value as Record<string, unknown>;
  if (typeof at !== "string" || !at.trim() || at.length > 500 || typeof put !== "string" || !PUTS.has(put)) return undefined;
  return { at: at.trim(), put: put as Moved["put"], ...(typeof order === "number" && Number.isFinite(order) ? { order: Math.max(-1000, Math.min(1000, Math.round(order))) } : {}) };
}

export function moves(store: Store) {
  const cache = new Map<string, Moves>();
  const read = async (app: string): Promise<Moves> => {
    let all = cache.get(app);
    if (!all) {
      all = await store.readJson<Moves>(file(app), {});
      cache.set(app, all);
    }
    return all;
  };
  return {
    /** Every move the person made in an app. */
    get: read,

    /** Moves one of a plugin's places, or puts it back where the plugin said with `to` null. */
    async set(app: string, plugin: string, place: string, to: Moved | null): Promise<void> {
      const all = structuredClone(await read(app));
      if (to) all[plugin] = { ...all[plugin], [place]: to };
      else if (all[plugin]) {
        delete all[plugin][place];
        if (!Object.keys(all[plugin]).length) delete all[plugin];
      }
      cache.set(app, all);
      await store.writeJson(file(app), all);
    },

    /**
     * A plugin's places with the person's moves applied. A place that draws in every match (`each`), changes
     * another plugin's view (`in`), or hides or replaces a part of the page is the plugin's to say, so it isn't moved.
     */
    apply(places: Record<string, Place> | undefined, moved: Record<string, Moved> | undefined): Record<string, Place> | undefined {
      if (!places || !moved) return places;
      const out: Record<string, Place> = {};
      for (const [name, place] of Object.entries(places)) {
        const to = moved[name];
        out[name] = to && movable(place) ? { at: to.at, put: to.put, ...(to.order !== undefined && { order: to.order }) } : place;
      }
      return out;
    },
  };
}

/** Whether the person can move a place: one that adds a view at one spot on the page. */
export function movable(place: Place): boolean {
  return !place.each && !place.in && PUTS.has(place.put);
}

export type MovesStore = ReturnType<typeof moves>;
