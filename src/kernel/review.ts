// Change review: a write outside a plugin's own data (a note, which belongs
// to the notes app, or a file in the data folder) is shown to the person as
// a diff with the plugin's reason before it happens. They accept it once,
// allow that plugin to change that place without asking again, or decline.
// A request nobody answers within five minutes is cancelled.
//
// "Always allow" grants are kept with the data (`grants.json`), per plugin
// and place, so they belong to this app and no other. Every outcome is
// appended to the change log. Outcomes follow DeepSeek Harness's closed set:
// allowed-once, allowed-always, granted (an earlier grant applied),
// rejected and cancelled; anything but an allow means no write.

import type { Dispatch, View } from "../shared/protocol";
import type { ChangeLog } from "./changes";
import { diffLines, trim } from "./diff";
import type { Hosts } from "./hosts";
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
  /** What a grant covers: `notes`, or `files:<folder>`. */
  place: string;
  /** What is being changed, as the person should read it. */
  target: string;
  before: string;
  after: string;
  reason: string;
  /** A place in the page rather than data: the card says what will appear or disappear, with no diff. */
  kind?: "place";
}

type Pending = { request: Request; resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout>; dispatch: Dispatch };

export const placeLabel = (place: string) =>
  place.startsWith("author:") ? "your plugins" : place.startsWith("files:") ? `${place.slice(6)}/` : place.startsWith("place:") || place.startsWith("unlock:") ? `${place.split("#")[1]}` : place;

export function reviews(store: Store, hosts: Hosts, log: ChangeLog) {
  // No prototype, so a plugin id such as `constructor` finds nothing it shouldn't.
  const grants: Record<string, string[]> = Object.create(null);
  const loaded = store.readJson<unknown>(FILE, {}).then((saved) => {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [plugin, places] of Object.entries(saved)) if (Array.isArray(places)) grants[plugin] = places.filter((p): p is string => typeof p === "string");
  });
  const pending = new Map<string, Pending>();
  let nextId = 0;
  const api = {
    /** Told when a plugin's grants change, so its panel can redraw. */
    onGrants: undefined as ((plugin: string) => void) | undefined,
  };

  const persist = () => store.writeJson(FILE, grants).catch((error) => record({ kind: "error", name: "grants:write-failed", detail: String(error) }));

  /** A change to a place in the page: what will appear or disappear there, with no diff. */
  const placeCard = (id: string, r: Request): View => ({
    type: "stack",
    children: [
      { type: "heading", text: `${r.name} wants to change ${r.target}` },
      { type: "text", text: `${r.reason} The app's author asked to review changes here.`, tone: "muted" },
      {
        type: "stack",
        direction: "row",
        children: [
          { type: "button", label: "Allow", action: `accept:${id}`, primary: true },
          { type: "button", label: "Always allow here", action: `always:${id}` },
          { type: "button", label: "Decline", action: `decline:${id}` },
        ],
      },
    ],
  });

  const card = (id: string, r: Request): View =>
    r.kind === "place"
      ? placeCard(id, r)
      : {
          type: "stack",
          children: [
            { type: "heading", text: `${r.name} wants to change ${r.target}` },
            { type: "text", text: r.reason ? `Reason: ${r.reason}` : "No reason given.", tone: "muted" },
            { type: "diff", lines: trim(diffLines(r.before, r.after)) },
            {
              type: "stack",
              direction: "row",
              children: [
                { type: "button", label: "Accept", action: `accept:${id}`, primary: true },
                { type: "button", label: `Always allow in ${placeLabel(r.place)}`, action: `always:${id}` },
                { type: "button", label: "Decline", action: `decline:${id}` },
              ],
            },
          ],
        };

  const settle = (id: string, outcome: Outcome, trace?: string) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    hosts.render("review", "main", `review:${id}`, null, 0);
    if (outcome === "allowed-always") {
      const list = (grants[p.request.plugin] ??= []);
      if (!list.includes(p.request.place)) list.push(p.request.place);
      void persist();
      void log.append({ kind: "grant", plugin: p.request.plugin, detail: placeLabel(p.request.place), trace });
      api.onGrants?.(p.request.plugin);
    }
    void log.append({ kind: "write", plugin: p.request.plugin, detail: p.request.target, outcome, trace: trace ?? p.dispatch.trace });
    p.resolve(outcome);
  };

  return Object.assign(api, {
    /** Asks the person about a write, unless an earlier grant covers it. */
    async ask(request: Request, dispatch: Dispatch): Promise<Outcome> {
      await loaded;
      if (grants[request.plugin]?.includes(request.place)) {
        void log.append({ kind: "write", plugin: request.plugin, detail: request.target, outcome: "granted", trace: dispatch.trace });
        return "granted";
      }
      const id = String(++nextId);
      record({ kind: "note", name: "review:asked", plugin: request.plugin, trace: dispatch.trace, detail: request.target });
      return new Promise<Outcome>((resolve) => {
        const timer = setTimeout(() => settle(id, "cancelled"), TIMEOUT);
        pending.set(id, { request, resolve, timer, dispatch });
        hosts.render("review", "main", `review:${id}`, card(id, request), 0);
      });
    },

    event(action: string, trace: string) {
      const [verb, id] = action.split(":");
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
