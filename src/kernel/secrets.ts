// Secrets: API keys and tokens the person gives the app. A plugin never reads
// one. It asks for a secret by name (the `secret:<name>` capability), the
// person pastes it into a card the kernel draws, and from then on the plugin
// can *use* it: the kernel puts it into a request the plugin makes with
// net.fetch (net.ts), and only to the hosts the secret was given for. So a
// key can't be copied out, logged, or sent anywhere but its own API.
//
// Secrets are kept with the app's data in `secrets.json`. A key the
// deployment provides (a server holding the app's key) comes with the
// servers in phase 2b, behind the same calls.

import type { View } from "../shared/protocol";
import type { Hosts } from "./hosts";
import type { ServiceProvider } from "./remote";
import type { Store } from "./store";
import { record } from "./trace";

const FILE = "secrets.json";
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;
const TIMEOUT = 10 * 60_000;

export interface Secret {
  value: string;
  /** The only hosts this secret may be sent to. */
  hosts: string[];
  label?: string;
}

type Pending = { name: string; hosts: string[]; label: string; plugin: string; typed: string; resolve: (set: boolean) => void; timer: ReturnType<typeof setTimeout> };

export function secrets(store: Store, hosts: Hosts, nameOf: (plugin: string) => string) {
  const kept: Record<string, Secret> = Object.create(null);
  const loaded = store.readJson<unknown>(FILE, {}).then((saved) => {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [name, s] of Object.entries(saved as Record<string, any>)) {
      if (NAME.test(name) && typeof s?.value === "string" && Array.isArray(s.hosts)) kept[name] = { value: s.value, hosts: s.hosts.filter((h: unknown) => typeof h === "string"), label: typeof s.label === "string" ? s.label : undefined };
    }
  });
  const persist = () => store.writeJson(FILE, kept).catch((error) => record({ kind: "error", name: "secrets:write-failed", detail: String(error) }));
  const pending = new Map<string, Pending>();
  let nextId = 0;

  const card = (id: string, p: Pending): View => ({
    type: "stack",
    children: [
      { type: "heading", text: `${nameOf(p.plugin)} asks for ${p.label}` },
      { type: "text", text: `It is kept with this app's data and only ever sent to ${p.hosts.join(", ")}. No plugin can read it.`, tone: "muted" },
      { type: "field", kind: "password", name: "secret", label: p.label, value: "", action: `typed:${id}` },
      {
        type: "stack",
        direction: "row",
        children: [
          { type: "button", label: "Save", action: `save:${id}`, primary: true },
          { type: "button", label: "Not now", action: `cancel:${id}` },
        ],
      },
    ],
  });

  const settle = (id: string, set: boolean) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    hosts.render("secrets", "main", `secrets:${id}`, null, 0);
    p.resolve(set);
  };

  /** Checks a secret name and the hosts it's for. */
  function checkArgs(name: unknown, options: unknown): { name: string; hosts: string[]; label: string } {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error("A secret's name is lowercase letters, digits and dashes");
    const o = (options && typeof options === "object" ? options : {}) as { hosts?: unknown; label?: unknown };
    const list = Array.isArray(o.hosts) ? o.hosts : [];
    if (!list.length || list.length > 5 || list.some((h) => typeof h !== "string" || !HOST.test(h))) throw new Error("Say which hosts the secret is for: { hosts: [\"api.example.com\"] }, up to 5");
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : `a key named “${name}”`;
    return { name, hosts: list as string[], label };
  }

  const service: ServiceProvider = {
    description: "API keys and tokens. A plugin never reads one: it asks the person for it by name, then uses it in requests it makes with net.fetch, which the kernel sends only to the hosts the secret was given for.",
    methods: {
      has: { args: "(name)", returns: "{ set, hosts }", needs: "secret:<name>", description: "Whether the person has given this secret, and the hosts it may be sent to." },
      request: {
        args: "(name, { hosts, label? })",
        returns: "{ set }",
        needs: "secret:<name>",
        description: "Asks the person to paste the secret, in a card the kernel draws; resolves when they save it or say not now (or after ten minutes). `hosts` are the only hosts it will ever be sent to.",
      },
      forget: { args: "(name)", returns: "true", needs: "secret:<name>", description: "Removes the secret." },
    },
    capability: (_method, args) => (typeof args[0] === "string" ? `secret:${args[0]}` : "secret:?"),
    call: async (plugin, method, args) => {
      await loaded;
      const name = String(args[0]);
      if (!NAME.test(name)) throw new Error("A secret's name is lowercase letters, digits and dashes");
      if (method === "has") return { set: name in kept, hosts: kept[name]?.hosts ?? [] };
      if (method === "forget") {
        const was = kept[name];
        delete kept[name];
        // Only say it's forgotten once it's gone from the disk too.
        await store.writeJson(FILE, kept).catch((error) => {
          if (was) kept[name] = was;
          throw new Error(`Couldn't forget ${name}: ${error instanceof Error ? error.message : error}`);
        });
        record({ kind: "note", name: "secret:forgotten", plugin, detail: name });
        return true;
      }
      if (method !== "request") throw new Error(`secrets.${method} is not a method`);
      const asked = checkArgs(args[0], args[1]);
      const id = String(++nextId);
      record({ kind: "note", name: "secret:asked", plugin, detail: `${name} for ${asked.hosts.join(", ")}` });
      const set = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(id, false), TIMEOUT);
        const p: Pending = { ...asked, plugin, typed: "", resolve, timer };
        pending.set(id, p);
        hosts.render("secrets", "main", `secrets:${id}`, card(id, p), 0);
      });
      return { set };
    },
  };

  return {
    service,
    loaded,
    /** The secret, for the kernel's own use in net.fetch. Never sent to a plugin. */
    get: (name: string): Secret | undefined => kept[name],
    event(action: string, value: unknown) {
      const [verb, id] = action.split(":");
      const p = pending.get(id);
      if (!p) return;
      if (verb === "typed") p.typed = typeof value === "string" ? value.trim().slice(0, 4000) : "";
      else if (verb === "cancel") settle(id, false);
      else if (verb === "save" && p.typed) {
        kept[p.name] = { value: p.typed, hosts: p.hosts, label: p.label };
        void persist();
        record({ kind: "note", name: "secret:saved", plugin: p.plugin, detail: `${p.name} for ${p.hosts.join(", ")}` });
        settle(id, true);
      }
    },
    /** Cancels a plugin instance's open requests when its worker goes. */
    cancelInstance(instance: string) {
      for (const [id, p] of pending) if (p.plugin === instance) settle(id, false);
    },
  };
}

export type Secrets = ReturnType<typeof secrets>;
