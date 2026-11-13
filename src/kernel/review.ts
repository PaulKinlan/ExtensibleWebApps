// Change review: a write outside a plugin's own data (a record in another
// plugin's collection, or a file in the data folder) is shown to the person as
// a diff with the plugin's reason before it happens. They accept it once,
// allow that plugin to change that place without asking again, or decline.
// A request nobody answers within five minutes is cancelled.
//
// "Always allow" grants are kept with the data (`grants.json`), per plugin
// and place, so they belong to this app and no other. Every outcome is
// appended to the change log. Outcomes follow DeepSeek Harness's closed set:
// allowed-once, allowed-always, granted (an earlier grant applied),
// rejected and cancelled; anything but an allow means no write.
//
// An agent may act for the person (`acts-as: person` in its file). The person
// lets it on a card here, for one run or always (a grant of the place
// `acts-as:person`). Its changes are still reviewed, one card each, but the
// card and the change log say they are the person's, made through the agent.
//
// What a card looks like, and the diff it shows, is a part of its own
// (review-card.ts), fetched the first time the person is asked: a page where
// nothing writes outside its own data never needs it.

import type { Dispatch } from "../shared/protocol";
import type { ChangeLog } from "./changes";
import type { Hosts } from "./hosts";
import { part } from "./part";
import type { Store } from "./store";
import { record } from "./trace";

const FILE = "grants.json";
const TIMEOUT = 5 * 60_000;

export type Outcome = "allowed-once" | "allowed-always" | "granted" | "rejected" | "cancelled";
export const allowed = (outcome: Outcome) => outcome === "allowed-once" || outcome === "allowed-always" || outcome === "granted";

export interface Request {
  plugin: string; // plugin id
  /** The plugin instance that asked; its request is cancelled if that instance stops. */
  instance: string;
  name: string; // plugin's display name
  /** What a grant covers: `data:<collection>`, or `files:<folder>`. */
  place: string;
  /** What is being changed, as the person should read it. */
  target: string;
  before: string;
  after: string;
  reason: string;
  /** A place in the page rather than data: the card says what will appear or disappear, with no diff. */
  kind?: "place";
  /** Asked every time: the card offers no "always allow", and no earlier grant answers it. */
  once?: boolean;
  /**
   * Asked for a space's server (std/spaces/reviews.ts): the answer goes back there, which keeps any grant, so
   * none is kept here and none here answers it.
   */
  elsewhere?: boolean;
}

export type Pending = { request: Request; resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout>; dispatch: Dispatch };
type Batches = ReturnType<typeof import("./review-batch").reviewBatches>;

/** The place an agent is granted to act for the person: `acts-as: person` in its file. */
export const ACTS_AS = "acts-as:person";

export const placeLabel = (place: string) =>
  place === ACTS_AS ? "acting for you" : place.startsWith("files:") ? `${place.slice(6)}/` : place.startsWith("place:") || place.startsWith("unlock:") ? `${place.split("#")[1]}` : place;

export function reviews(store: Store, hosts: Hosts, log: ChangeLog) {
  // No prototype, so a plugin id such as `constructor` finds nothing it shouldn't.
  const grants: Record<string, string[]> = Object.create(null);
  const loaded = store.readJson<unknown>(FILE, {}).then((saved) => {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [plugin, places] of Object.entries(saved)) if (Array.isArray(places)) grants[plugin] = places.filter((p): p is string => typeof p === "string");
  });
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let batches: Batches | undefined;
  let loadingBatches: Promise<Batches> | undefined;
  const syncBatches = () =>
    void (loadingBatches ??= part("batched reviews", () => import("./review-batch")).then(
      (m) => (batches = m.reviewBatches(hosts, pending, settle, placeLabel)),
      (e) => ((loadingBatches = undefined), Promise.reject(e)),
    )).then((b) => b.sync(), () => {});
  const api = {
    /** Told when a plugin's grants change, so its panel can redraw. */
    onGrants: undefined as ((plugin: string) => void) | undefined,
    /**
     * On a space's server, which has no screen: told of each request as it is asked, and when it is settled,
     * to show it on members' devices instead (std/spaces/reviews.ts).
     */
    relay: undefined as ((id: string, request: Request) => void) | undefined,
    relayDone: undefined as ((id: string) => void) | undefined,
  };

  const persist = () => store.writeJson(FILE, grants).catch((error) => record({ kind: "error", name: "grants:write-failed", detail: String(error) }));

  /** A write by an agent acting for the person: its call carries the agent's id as `via`. */
  const forPerson = (r: Request, dispatch: Dispatch) => dispatch.via === r.plugin;

  /** What draws a card (review-card.ts), fetched the first time the person is asked: most visits never ask. */
  let drawing: Promise<typeof import("./review-card")> | undefined;
  const cards = () => (drawing ??= part("the card that asks you about a change", () => import("./review-card")).catch((error) => ((drawing = undefined), Promise.reject(error))));

  const settle = (id: string, outcome: Outcome, trace?: string) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    hosts.render("review", "main", `review:${id}`, null, 0);
    api.relayDone?.(id);
    if (outcome === "allowed-always" && !p.request.once && !p.request.elsewhere) {
      const list = (grants[p.request.plugin] ??= []);
      if (!list.includes(p.request.place)) list.push(p.request.place);
      void persist();
      void log.append({ kind: "grant", plugin: p.request.plugin, detail: placeLabel(p.request.place), trace });
      api.onGrants?.(p.request.plugin);
      for (const [otherId, other] of [...pending])
        if (other.request.plugin === p.request.plugin && other.request.place === p.request.place && !other.request.once && !other.request.elsewhere)
          settle(otherId, "granted", trace);
    }
    // Letting an agent act for the person is a grant, not a write: only "always" (above) is kept.
    if (p.request.place !== ACTS_AS) void log.append({ kind: "write", plugin: p.request.plugin, detail: p.request.target, outcome, ...(forPerson(p.request, p.dispatch) ? { as: "person" as const } : {}), trace: trace ?? p.dispatch.trace });
    if (batches) batches.sync();
    else if (loadingBatches) void loadingBatches.then((b) => b.sync(), () => {});
    p.resolve(outcome);
  };

  return Object.assign(api, {
    /** Asks the person about a write, unless an earlier grant covers it. */
    async ask(request: Request, dispatch: Dispatch): Promise<Outcome> {
      await loaded;
      if (!request.once && !request.elsewhere && grants[request.plugin]?.includes(request.place)) {
        if (request.place !== ACTS_AS) void log.append({ kind: "write", plugin: request.plugin, detail: request.target, outcome: "granted", ...(forPerson(request, dispatch) ? { as: "person" as const } : {}), trace: dispatch.trace });
        return "granted";
      }
      const id = String(++nextId);
      record({ kind: "note", name: "review:asked", plugin: request.plugin, trace: dispatch.trace, detail: request.target });
      return new Promise<Outcome>((resolve, reject) => {
        const timer = setTimeout(() => settle(id, "cancelled"), TIMEOUT);
        // Waiting from now, so a plugin that stops while the card's code is on its way still has its request cancelled.
        pending.set(id, { request, resolve, timer, dispatch });
        let same = 0;
        for (const p of pending.values()) if (p.request.plugin === request.plugin && p.request.place === request.place && ++same > 1) break;
        if (same > 1 || batches) syncBatches();
        api.relay?.(id, request);
        cards().then(
          (made) => pending.has(id) && hosts.render("review", "main", `review:${id}`, made.card(id, request, forPerson(request, dispatch)), 0),
          (error) => {
            // No card can be shown, so nothing is changed, and the plugin hears why (part.ts says what the person can do).
            if (!pending.delete(id)) return;
            clearTimeout(timer);
            api.relayDone?.(id);
            if (batches) batches.sync();
            else if (loadingBatches) void loadingBatches.then((b) => b.sync(), () => {});
            reject(error);
          },
        );
      });
    },

    /** An answer from elsewhere (a member's device, for a space's server): allowed once, always, or declined. */
    answer(id: string, outcome: Outcome, trace?: string) {
      if (outcome === "allowed-once" || outcome === "allowed-always" || outcome === "rejected") settle(id, outcome, trace);
    },

    /** The requests waiting for an answer, by id: for a device that comes after they were asked. */
    waiting(): [string, Request][] {
      return [...pending].map(([id, p]) => [id, p.request]);
    },

    event(action: string, trace: string) {
      const [verb, id] = action.split(":");
      if (verb === "accept-batch" || verb === "decline-batch" || verb === "batch") return void batches?.event(action, trace);
      if (verb === "accept") settle(id, "allowed-once", trace);
      else if (verb === "always") settle(id, "allowed-always", trace);
      else if (verb === "decline") settle(id, "rejected", trace);
    },

    /** Cancels a plugin's open requests, when it is turned off or removed. */
    cancel(plugin: string) {
      for (const [id, p] of pending) if (p.request.plugin === plugin) settle(id, "cancelled");
    },

    /** Cancels one instance's open requests, whenever its worker goes (reload, replacement, handover, tab closed). */
    cancelInstance(instance: string) {
      for (const [id, p] of pending) if (p.request.instance === instance) settle(id, "cancelled");
    },

    /** Grants a plugin a place without a card: the person did it in a panel, such as unlocking an area. */
    async grant(plugin: string, place: string, trace?: string) {
      await loaded;
      const list = (grants[plugin] ??= []);
      if (list.includes(place)) return;
      list.push(place);
      void persist();
      void log.append({ kind: "grant", plugin, detail: placeLabel(place), trace });
      api.onGrants?.(plugin);
    },

    grantsFor(plugin: string): string[] {
      return [...(grants[plugin] ?? [])];
    },

    async forget(plugin: string, place: string, trace?: string) {
      await loaded;
      if (!grants[plugin]?.includes(place)) return;
      grants[plugin] = grants[plugin].filter((p) => p !== place);
      if (!grants[plugin].length) delete grants[plugin];
      void persist();
      void log.append({ kind: "revoke", plugin, detail: placeLabel(place), trace });
      api.onGrants?.(plugin);
    },

    loaded,
  });
}

export type Reviews = ReturnType<typeof reviews>;
