// The card that asks the person for a secret (secrets.ts): an API key a plugin
// asked for by name, or a passphrase the kernel itself needs. The kernel draws
// it, so what is typed goes to the kernel and never to a plugin. Fetched the
// first time something asks, since most pages never do.

import type { View } from "../shared/protocol";
import type { Hosts } from "./hosts";
import type { Secret } from "./secrets";
import { record } from "./trace";

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;
const TIMEOUT = 10 * 60_000;

type Pending = { name: string; hosts: string[]; label: string; plugin: string; typed: string; resolve: (set: boolean) => void; timer: ReturnType<typeof setTimeout>; own?: Own };
/** A secret the kernel asks for itself (`ask`), rather than for a plugin: the card's words, and what was typed again when it is asked twice. */
type Own = { heading: string; text: string; twice: boolean; again: string; wrong: string; tab?: string };

/** `save` keeps a secret a person gave for a plugin. */
export function cards(hosts: Hosts, nameOf: (plugin: string) => string, save: (name: string, secret: Secret) => void) {
  const pending = new Map<string, Pending>();
  let nextId = 0;

  const card = (id: string, p: Pending): View => ({
    type: "stack",
    children: [
      { type: "heading", text: p.own?.heading ?? `${nameOf(p.plugin)} asks for ${p.label}` },
      { type: "text", text: p.own?.text ?? `It is kept with this app's data and only ever sent to ${p.hosts.join(", ")}. No plugin can read it.`, tone: "muted" },
      { type: "field", kind: "password", name: "secret", label: p.label, value: "", action: `typed:${id}` },
      ...(p.own?.twice ? [{ type: "field", kind: "password", name: "again", label: `${p.label}, again`, value: "", action: `again:${id}` } as View] : []),
      ...(p.own?.wrong ? [{ type: "text", text: p.own.wrong, tone: "error" } as View] : []),
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
    hosts.render("secrets", "main", `secrets:${id}`, null, 0, p.own?.tab);
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

  return {
    /** Asks the person for a secret a plugin named; whether they gave it. */
    request(plugin: string, name: string, options: unknown): Promise<boolean> {
      const asked = checkArgs(name, options);
      const id = String(++nextId);
      record({ kind: "note", name: "secret:asked", plugin, detail: `${name} for ${asked.hosts.join(", ")}` });
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(id, false), TIMEOUT);
        const p: Pending = { ...asked, plugin, typed: "", resolve, timer };
        pending.set(id, p);
        hosts.render("secrets", "main", `secrets:${id}`, card(id, p), 0);
      });
    },
    /** Asks the person for a secret the kernel itself needs, in one tab; what they typed, or undefined. Kept nowhere. */
    ask(words: { heading: string; text: string; label: string; twice?: boolean; tab?: string }): Promise<string | undefined> {
      const id = String(++nextId);
      return new Promise((done) => {
        const p: Pending = { name: "", hosts: [], label: words.label, plugin: "", typed: "", timer: setTimeout(() => settle(id, false), TIMEOUT), resolve: (set) => done(set ? p.typed : undefined), own: { heading: words.heading, text: words.text, twice: !!words.twice, again: "", wrong: "", tab: words.tab } };
        pending.set(id, p);
        hosts.render("secrets", "main", `secrets:${id}`, card(id, p), 0, words.tab);
      });
    },
    event(action: string, value: unknown) {
      const [verb, id] = action.split(":");
      const p = pending.get(id);
      if (!p) return;
      if (verb === "typed") p.typed = typeof value === "string" ? value.trim().slice(0, 4000) : "";
      else if (verb === "again" && p.own) p.own.again = typeof value === "string" ? value.trim().slice(0, 4000) : "";
      else if (verb === "cancel") settle(id, false);
      else if (verb === "save" && p.own) {
        // The kernel's own: what was typed goes to the part that asked, and is kept nowhere.
        const wrong = p.own.twice && p.typed !== p.own.again ? "Those two aren't the same. Type both again." : !p.typed ? "Type it first." : "";
        if (!wrong) return settle(id, true);
        p.own.wrong = wrong;
        hosts.render("secrets", "main", `secrets:${id}`, card(id, p), 0, p.own.tab);
      } else if (verb === "save" && p.typed) {
        save(p.name, { value: p.typed, hosts: p.hosts, label: p.label });
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
