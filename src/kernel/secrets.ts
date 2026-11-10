// Secrets: API keys and tokens the person gives the app. A plugin never reads
// one. It asks for a secret by name (the `secret:<name>` capability), the
// person pastes it into a card the kernel draws, and from then on the plugin
// can *use* it: the kernel puts it into a request the plugin makes with
// net.fetch (net.ts), and only to the hosts the secret was given for. So a
// key can't be copied out, logged, or sent anywhere but its own API.
//
// The card itself, and the wait for the person to answer it, is a part of its
// own (secrets-card.ts), fetched the first time a key is asked for: most pages
// never ask for one.
//
// Secrets are kept with the app's data in `secrets.json`. A key the
// deployment provides (a server holding the app's key) comes with the
// servers in phase 2b, behind the same calls.

import type { Hosts } from "./hosts";
import { part } from "./part";
import type { ServiceProvider } from "./remote";
import type { Store } from "./store";
import { record } from "./trace";

const FILE = "secrets.json";
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;

export interface Secret {
  value: string;
  /** The only hosts this secret may be sent to. */
  hosts: string[];
  label?: string;
}

type Cards = ReturnType<typeof import("./secrets-card").cards>;

export function secrets(store: Store, hosts: Hosts, nameOf: (plugin: string) => string) {
  const kept: Record<string, Secret> = Object.create(null);
  const loaded = store.readJson<unknown>(FILE, {}).then((saved) => {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [name, s] of Object.entries(saved as Record<string, any>)) {
      if (NAME.test(name) && typeof s?.value === "string" && Array.isArray(s.hosts)) kept[name] = { value: s.value, hosts: s.hosts.filter((h: unknown) => typeof h === "string"), label: typeof s.label === "string" ? s.label : undefined };
    }
  });
  const persist = () => store.writeJson(FILE, kept).catch((error) => record({ kind: "error", name: "secrets:write-failed", detail: String(error) }));
  /** The cards, once one has been asked for. */
  let made: Cards | undefined;
  let making: Promise<Cards> | undefined;
  const cards = () =>
    (making ??= part("the card that asks for a key", () => import("./secrets-card")).then((m) => (made = m.cards(hosts, nameOf, (name, secret) => ((kept[name] = secret), void persist()))), (error) => ((making = undefined), Promise.reject(error))));

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
      return { set: await (await cards()).request(plugin, name, args[1]) };
    },
  };

  return {
    service,
    loaded,
    /** The secret, for the kernel's own use in net.fetch. Never sent to a plugin. */
    get: (name: string): Secret | undefined => kept[name],
    /** Every secret, for the part of the kernel that carries them, encrypted, between the person's devices (std/follow). Never sent to a plugin. */
    all: (): Record<string, Secret> => ({ ...kept }),
    /** Keeps a secret as another of the person's devices has it, or (given none) removes it. */
    async keep(name: string, secret?: Secret) {
      if (!NAME.test(name) || (secret && (!secret.value || !secret.hosts.length || secret.hosts.some((h) => !HOST.test(h))))) throw new Error("Not a secret this device can keep");
      if (secret) kept[name] = { value: secret.value, hosts: [...secret.hosts], label: secret.label };
      else delete kept[name];
      await store.writeJson(FILE, kept);
    },
    /**
     * Asks the person to type a secret the kernel itself needs (the passphrase that unlocks their keys, std/account),
     * in a card in one tab, twice if it is a new one. What they typed, or undefined if they said not now. It is
     * handed to the part of the kernel that asked and kept nowhere: no plugin is ever given it.
     */
    ask: async (words: { heading: string; text: string; label: string; twice?: boolean; tab?: string }): Promise<string | undefined> => (await cards()).ask(words),
    /** What the person did in a card. */
    event: (action: string, value: unknown) => made?.event(action, value),
    /** Cancels a plugin instance's open requests when its worker goes. */
    cancelInstance: (instance: string) => made?.cancelInstance(instance),
  };
}

export type Secrets = ReturnType<typeof secrets>;
