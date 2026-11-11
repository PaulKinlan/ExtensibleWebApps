// Who may change what in a space, decided on the space's server (the hub,
// hub.ts, asks here before it takes a change). Two things decide:
//
// A member's role, which the space's owner gives on their account page and
// the server names with each message (src/server/signed.ts): the owner and
// editors change what the space keeps, and a reader only sees it.
//
// A collection's rules, which the plugin that keeps the collection writes in
// its manifest, beside the schema:
//
//   collections: {
//     chores: { title: "Chores", schema: { … }, rules: { change: "author", remove: "owner" } },
//   }
//
//   add     who may add a record:     "editors" (anyone but a reader) or "owner"
//   change  who may change a record:  "editors", "author" (whoever added it) or "owner"
//   remove  who may remove a record:  "editors", "author" or "owner"
//
// Left out, each is "editors". The space's owner may always do all three, and
// so may the app's own plugins that run on the server: the rules are for what
// members' devices send. Only the manifests of an app's own plugins count
// (the files the site serves, which the server reads itself, server-apps.ts):
// nothing a device sends can set a rule. Rules that aren't written as above
// lock their collection to the owner until the plugin is fixed, and say so,
// rather than quietly letting everyone in.
//
// Kept in the space's folder:
//   sync/rules.json     each collection's rules, so they hold from the moment the space starts again
//   sync/authors.json   who added each record of a collection with an "author" rule

import type { Host, Hosts } from "../../src/kernel/hosts";
import type { Manifest } from "../../src/shared/protocol";
import type { Store } from "../../src/kernel/store";
import { record as trace } from "../../src/kernel/trace";
import type { Outgoing, SyncRecord, SyncToDevice, SyncToSpace } from "../../src/shared/sync";
import { checkRules, type Role, type Rules } from "./rules";

const RULES = "sync/rules.json";
const AUTHORS = "sync/authors.json";

type Member = { id: string; name: string; role?: Role };
type Kept = Rules | { broken: string };

export const READER = "You can read this space but not change it";

export function spacePermissions(store: Store, hosts: Hosts, members: () => Promise<Member[] | undefined>, titleOf: (collection: string) => string) {
  let rules: Record<string, Kept> = {};
  let authors: Record<string, string> = {};
  const loaded = Promise.all([store.readJson<unknown>(RULES, {}), store.readJson<unknown>(AUTHORS, {})]).then(([r, a]) => {
    if (r && typeof r === "object" && !Array.isArray(r)) rules = { ...(r as Record<string, Kept>), ...rules };
    if (a && typeof a === "object" && !Array.isArray(a)) authors = { ...(a as Record<string, string>), ...authors };
  });
  let saving: Promise<unknown> = Promise.resolve();
  const save = (file: string, value: () => unknown) => (saving = saving.then(() => store.writeJson(file, value())).catch((error) => trace({ kind: "error", name: "space:rules", detail: String(error) })));

  /** The space's members as the accounts last said, for the names in what a refusal says. Asked again after a few seconds. */
  let known: { at: number; list: Member[] } = { at: 0, list: [] };
  const people = async () => {
    if (Date.now() - known.at > 5000) known = { at: Date.now(), list: (await members().catch(() => undefined)) ?? known.list };
    return known.list;
  };
  const ownerName = async () => (await people()).find((m) => m.role === "owner")?.name;
  const nameOf = async (id: string) => (await people()).find((m) => m.id === id)?.name;
  const askOwner = async () => {
    const owner = await ownerName();
    return owner ? `the space's owner, ${owner},` : "the space's owner";
  };

  const key = (collection: string, id: string) => `${collection}/${id}`;
  const usesAuthor = (r: Kept | undefined) => !!r && !("broken" in r) && (r.change === "author" || r.remove === "author");

  return {
    loaded,
    /**
     * An app's plugin, as the server read it: what its manifest says of each collection it keeps. Rules that
     * can't be read lock the collection to the owner, and the trace says what is wrong with them.
     */
    learn(manifest: Manifest) {
      let changed = false;
      for (const [name, spec] of Object.entries(manifest.collections ?? {})) {
        const written = (spec as { rules?: unknown }).rules;
        let now: Kept | undefined;
        if (written !== undefined) {
          try {
            now = checkRules(written, `Collection ${name}`);
          } catch (error) {
            now = { broken: error instanceof Error ? error.message : String(error) };
            trace({ kind: "error", name: "space:rules", plugin: manifest.id, detail: `${now.broken}. Until it is fixed, only the space's owner can change ${name}.` });
          }
        }
        if (JSON.stringify(rules[name] ?? null) === JSON.stringify(now ?? null)) continue;
        changed = true;
        if (now) rules[name] = now;
        else delete rules[name];
      }
      if (changed) {
        save(RULES, () => rules);
        void this.told().then((told) => {
          for (const host of hosts.list) if (host.member) hosts.send(host, { t: "sync", op: "rules", ...told } as SyncToDevice);
        });
      }
    },

    /** What a device is told with the space's answer to its hello: each collection's rules, and who added each record under an "author" rule. */
    async told(): Promise<{ rules: Record<string, Rules>; authors: Record<string, string>; owner?: string }> {
      await loaded;
      const out: Record<string, Rules> = {};
      for (const [name, r] of Object.entries(rules)) out[name] = "broken" in r ? { add: "owner", change: "owner", remove: "owner" } : r;
      const owner = await ownerName();
      return { rules: out, authors: Object.fromEntries(Object.entries(authors).filter(([k]) => usesAuthor(rules[k.slice(0, k.indexOf("/"))]))), ...(owner ? { owner } : {}) };
    },

    /**
     * Whether a member may make a change: nothing if so, and otherwise what to tell them, with who can do it
     * instead. `before` is the record as the space has it (null for one being added).
     */
    async may(change: Outgoing, before: SyncRecord | null, by: string | undefined, role: Role | undefined): Promise<string | undefined> {
      await loaded;
      if (role === "reader") return `${READER}. Ask ${await askOwner()} to make you an editor.`;
      if (role === "owner") return undefined;
      const r = rules[change.collection];
      if (!r) return undefined;
      const title = titleOf(change.collection);
      if ("broken" in r) return `Only ${await askOwner()} can change ${title} for now: its rules can't be read (${r.broken}).`;
      const doing = !before ? "add" : change.after === null ? "remove" : "change";
      // Removing something that isn't there changes nothing.
      if (!before && change.after === null) return undefined;
      const who = r[doing] ?? "editors";
      if (who === "editors") return undefined;
      const act = doing === "add" ? `add to ${title}` : `${doing} this in ${title}`;
      if (who === "owner") return `Only ${await askOwner()} can ${act}.`;
      const author = authors[key(change.collection, change.id)];
      if (author && author === by) return undefined;
      const name = author && !author.startsWith("plugin:") ? await nameOf(author) : undefined;
      return name ? `${name} added this, so only ${name} or ${await askOwner()} can ${doing} it.` : `Only whoever added this, or ${await askOwner()}, can ${doing} it.`;
    },

    /** A change the space took: who added a record is kept while its collection has an "author" rule, and let go when the record goes. */
    did(collection: string, id: string, added: boolean, removed: boolean, by: string | undefined) {
      const k = key(collection, id);
      if (removed) {
        if (!(k in authors)) return;
        delete authors[k];
      } else if (added && by && usesAuthor(rules[collection])) authors[k] = by;
      else return;
      save(AUTHORS, () => authors);
      for (const host of hosts.list) if (host.member) hosts.send(host, { t: "sync", op: "author", key: k, ...(authors[k] ? { by: authors[k] } : {}) } as SyncToDevice);
    },

    /**
     * A reader's message that isn't a push (the hub answers those, change by change): true when it was one
     * that changes the space, which is refused here in the shape the device waits for.
     */
    async reader(host: Host, message: SyncToSpace): Promise<boolean> {
      const no = async () => `${READER}. Ask ${await askOwner()} to make you an editor.`;
      if (message.op === "plugins" && (message.action === "add" || message.action === "remove")) return hosts.send(host, { t: "sync", op: "plugins:reply", id: message.id, ok: false, error: await no() }), true;
      if (message.op === "apps" && (message.action === "share" || message.action === "unshare")) return hosts.send(host, { t: "sync", op: "apps:reply", id: message.id, ok: false, error: await no() }), true;
      // Allowing what the space's own plugins ask to change is changing it; so is a move in a game.
      if (message.op === "review" && message.action === "answer") return true;
      if (message.op === "live") return true;
      return false;
    },
    /** Resolves once what was to be kept is written. */
    settled: () => saving,
  };
}

export type SpacePermissions = ReturnType<typeof spacePermissions>;
