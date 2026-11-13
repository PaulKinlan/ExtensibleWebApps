// The `sync` service: how a page in a space (/s/<space>/…) stands with the
// space, the drafts it keeps, and content-addressed binary/media blobs shared
// across the space. The spaces module (module.ts) gives it, from this file, as
// `ctx.call("sync", …)`.
//
// A change the space refused (someone changed the same field first) is
// replaced by the space's record, and the person's version is kept as a draft
// (device.ts). This service lists the drafts, and lets the person keep theirs
// after all, which makes it a new change to the record, or let it go. A plugin
// calls it for the person, from buttons (std/sync.js). Keeping a draft writes a
// record without a review, so `sync` is a permission to give only to a plugin
// that does it when the person asks.
//
// `putBlob(data, mediaType)` and `getBlob(hash)` store and fetch SHA-256
// content-addressed blobs under `sync/blobs/<hash>`, syncing them across space
// members. Plugins with `sync` or `files` permission may call them.
//
// In a kernel that keeps no space, state() says so and there's nothing to do.
//
// reflect() is for debuggers (demos/debugger/space.js): it asks the space's
// own kernel, on its server, what reflect.<method>() says there (reflect.ts).
// It needs reflect:read, as the reflect service does in this kernel. So does
// trace(), which streams that kernel's trace here as sync:trace (trace.ts).
//
// live() sends a live message between the members' devices and the space's
// server plugins (live.ts): a game's moves one way, its frames the other.
// It needs `live`. They hear each other with the sync:live hook.

import { env } from "../../src/kernel/env";
import { check, grants } from "../../src/kernel/gate";
import type { ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";
import type { SyncToDevice } from "../../src/shared/sync";
import { clientBlobs, type SpaceBlobs } from "./blobs";
import { checkTopic, LIVE_HOOK, type LiveSpace } from "./live";
import { askSpace, READS } from "./reflect";
import { allowed, type Rules } from "./rules";
import { thisDevice } from "./this-device";

export default ({ root, store, collections, hook, cleanup, remote, reviewed }: ModuleKernel, space: { live?: LiveSpace; blobs?: SpaceBlobs } = {}): ServiceProvider => {
  hook("sync:live", LIVE_HOOK);
  hook("sync:trace", {
    mode: "emit",
    quiet: true,
    needs: "reflect:read",
    args: "{ events: [{ seq, at, kind, name, plugin?, trace?, ms?, detail? }], first?, error? }",
    description: "New events in the trace of the space's own kernel, on its server, for a debugger that asked with sync.trace(true): first is the batch from before it asked (again after each reconnection), and error says the space stopped sending. They name every server plugin and what it did, so listening needs reflect:read.",
  });
  hook("sync:blobs", {
    mode: "emit",
    needs: "sync",
    args: "{ hash, size, mediaType }",
    description: "Another member or server plugin stored a content-addressed blob in this space. Read its bytes with sync.getBlob(hash).",
  });
  const blobs = clientBlobs(store, () => thisDevice.sync, (blob) => root.emit({ trace: `blob-${blob.hash.slice(0, 12)}` }, "sync:blobs", blob));

  /** The devices this service listens to for live messages and the space's trace, once a plugin has used either. */
  const attached = new WeakSet<object>();
  /** The plugins hearing the space's trace on this device: it stops once none of them is running. */
  const watchers = new Set<string>();
  const attach = (device: NonNullable<typeof thisDevice.sync>) => {
    if (attached.has(device)) return;
    attached.add(device);
    const listen = (m: SyncToDevice) => {
      if (m.op === "live") return void root.emit({ trace: `live-${m.topic}` }, "sync:live", { topic: m.topic, value: m.value, from: "space" });
      if (m.op !== "trace") return;
      for (const w of [...watchers]) if (!remote.live.has(w)) watchers.delete(w);
      if (!watchers.size) return void (m.on !== false && device.send({ t: "sync", op: "trace", on: false }));
      // The space said no (too many debuggers watching): the watchers hear why, and stop.
      if (m.on === false && m.error) {
        watchers.clear();
        return void root.emit({}, "sync:trace", { events: [], error: m.error });
      }
      if (m.events?.length) root.emit({}, "sync:trace", { events: m.events, ...(m.on ? { first: true } : {}) });
    };
    // A new connection is a new socket the space knows nothing of: ask for the trace again, if anyone still listens.
    const again = () => {
      for (const w of [...watchers]) if (!remote.live.has(w)) watchers.delete(w);
      if (watchers.size) device.send({ t: "sync", op: "trace", on: true });
    };
    device.heard.add(listen);
    device.caughtUp.add(again);
    cleanup(() => {
      device.heard.delete(listen);
      device.caughtUp.delete(again);
    });
  };
  hook("sync:changed", {
    mode: "emit",
    needs: "sync",
    args: "{}",
    description: "This page's sync with its space changed: it connected or lost the server, sent what it had, or kept or let go of a draft. Read sync.state().",
  });
  hook("members:changed", {
    mode: "emit",
    needs: "members",
    args: "{}",
    description: "The space told this page who its members are and which one this page is signed in as, or that changed. Read sync.members().",
  });
  // Many changes at once (a whole push answered) are told once, just after the last.
  let soon: ReturnType<typeof setTimeout> | undefined;
  /** The members as last told, to tell members:changed only when they change. */
  let told = "";
  const heard = () => {
    blobs.attach(thisDevice.sync);
    clearTimeout(soon);
    soon = setTimeout(async () => {
      root.emit({}, "sync:changed", {});
      const s = await thisDevice.sync?.state();
      const now = JSON.stringify([s?.member ?? null, s?.members ?? {}, s?.access ?? null]);
      if (now !== told) {
        told = now;
        root.emit({}, "members:changed", {});
      }
    }, 50);
  };
  thisDevice.changed.add(heard);
  cleanup(() => {
    thisDevice.changed.delete(heard);
    clearTimeout(soon);
  });

  async function state() {
    const device = thisDevice.sync;
    if (!device) return { space: null };
    const s = await device.state();
    const drafts = s.drafts.map((d) => {
      const shown: Record<string, unknown> = d.mine ?? {};
      const label = ["title", "name", "item", "label", "description"].map((k) => shown[k]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.slice(0, 60);
      const title = collections.registry.get(d.collection)?.title ?? d.collection;
      return { ref: d.ref, collection: d.collection, title, id: d.id, ...(label ? { label } : {}), mine: d.mine, why: d.why, at: d.at };
    });
    return { space: s.space, ...(s.member ? { member: s.member } : {}), ...(s.access ? { role: s.access.role, ...(s.access.owner ? { owner: s.access.owner } : {}) } : {}), connected: s.connected, pending: s.pending, drafts };
  }

  /** What this page's member may do to a collection, or to one record of it, as the space last said (rules.ts): the space decides again on each change. */
  async function may(collection: unknown, id: unknown) {
    const all = { add: true, change: true, remove: true };
    const s = await thisDevice.sync?.state();
    if (!s?.access || typeof collection !== "string") return all;
    const { role, rules, authors, owner } = s.access;
    const mine = typeof id === "string" && !!s.member && authors[`${collection}/${id}`] === s.member;
    const r = rules[collection] as Rules | undefined;
    const out = { add: allowed(r, "add", role, false), change: allowed(r, "change", role, mine), remove: allowed(r, "remove", role, mine) };
    if (out.add && out.change && out.remove) return out;
    const ask = owner ? `the space's owner, ${owner},` : "the space's owner";
    return { ...out, why: role === "reader" ? `You can read this space but not change it. Ask ${ask} to make you an editor.` : `Some of this is for whoever added it, or ${ask}.` };
  }

  /** The space's members by name, and which one this page is signed in as: from the device's copy, or on the space's server from its accounts. */
  async function members() {
    const device = thisDevice.sync;
    if (device) {
      const s = await device.state();
      return { space: s.space, ...(s.member ? { you: s.member } : {}), members: Object.entries(s.members).map(([id, name]) => ({ id, name })) };
    }
    if (env().kind === "server" && env().members) return { space: true, members: await env().members!() };
    return { space: null, members: [] };
  }

  return {
    description: "How a page in a space stands with it, the drafts it kept when someone else changed a record first, and content-addressed blobs synced across the space.",
    methods: {
      state: {
        args: "()",
        returns: "{ space: null } or { space, member?, role?, owner?, connected, pending, drafts }",
        needs: "sync",
        params: [],
        description: "Whether this page keeps a copy of a space, who it is signed in as there (`member`, once the space has said) and what they may do (`role`: \"owner\", \"editor\", or \"reader\", who can see the space but not change it; `owner` is the owner's name, to say whom to ask), whether it reaches the space now, how many changes wait to be sent, and its drafts. A draft is `{ ref, collection, title, id, label?, mine, why, at }`: mine is the record as this device had made it (null for a delete).",
      },
      members: {
        args: "()",
        returns: "{ space, you?, members: [{ id, name }] }",
        needs: "members",
        params: [],
        description: "The space's members, each with the name on their account, and which of them this page is signed in as (`you`). A change's `by` and data:changed's `by` are a member's id: show the name from here. Outside a space, `space` is null and the list is empty.",
      },
      may: {
        args: "(collection, id?)",
        returns: "{ add, change, remove, why? }",
        needs: "members",
        params: [
          { name: "collection", schema: { type: "string", description: "The collection's name" } },
          { name: "id", optional: true, schema: { type: "string", description: "A record's id, to ask about that record: under an \"author\" rule only whoever added it may change it" } },
        ],
        description: "Whether the person signed in here may add to a collection, and change or remove a record of it, in this space: from their role (a reader changes nothing) and the collection's `rules` in its plugin's manifest. For showing a form or a button only to those who can use it, with `why` to say when they can't. The space's server decides again on every change. All true outside a space.",
      },
      keep: {
        args: "(ref)",
        returns: "{ ok } or { ok: false, error }",
        needs: "sync",
        params: [{ name: "ref", schema: { type: "string", description: "The draft's ref, from state()" } }],
        description: "Makes a draft the record again, with no review, as a new change sent to the space. data:beforeWrite listeners can still stop it.",
      },
      putBlob: {
        args: "(data, mediaType?)",
        returns: "{ hash, size, mediaType }",
        needs: "sync",
        params: [
          { name: "data", schema: { description: "Binary bytes (Uint8Array, ArrayBuffer or Blob), a data URL, or a UTF-8 string, up to 2 MB" } },
          { name: "mediaType", optional: true, schema: { type: "string", description: "MIME type, such as image/png or audio/webm" } },
        ],
        description: "Stores a content-addressed binary or media blob under sync/blobs/<sha256> (capped at 2 MB per blob and 32 MB per space) and syncs it with the space. Plugins with `sync` or `files` permission may call this.",
      },
      getBlob: {
        args: "(hash)",
        returns: "{ data, mediaType } or null",
        needs: "sync",
        params: [{ name: "hash", schema: { type: "string", description: "The 64-character SHA-256 hex digest returned by putBlob" } }],
        description: "Reads a content-addressed blob by its SHA-256 hash from local storage or the space, returning `{ data, mediaType }` (`data` is a `Uint8Array`) or `null` if unknown. Plugins with `sync` or `files` permission may call this.",
      },
      reflect: {
        args: "(method, id?)",
        returns: "what the space's reflect.<method>() returns",
        needs: "reflect:read",
        params: [
          { name: "method", schema: { type: "string", enum: READS, description: "One of the reflect service's methods: snapshot, plugins, hooks, workers, tabs or source" } },
          { name: "id", optional: true, schema: { type: "string", description: "For source: the plugin's id" } },
        ],
        description: "For debuggers: asks the space's own kernel, on its server, what its reflect service says (its server plugins, their permissions, hooks and workers, and the members' devices connected, each with its member). A snapshot also lists `shared`: the plugins members share, which the space keeps but never runs ({ app, id, by?, at }); source reads theirs too. Read only, like reflect. Fails outside a space, or while this page can't reach it.",
      },
      live: {
        args: "(topic, value, device?)",
        returns: "{ sent } (on a server, { sent, reached })",
        needs: "live",
        quiet: true,
        params: [
          { name: "topic", schema: { type: "string", description: "What it's about: lowercase letters, digits and dashes, such as a game's name" } },
          { name: "value", schema: { description: "Anything JSON: a move, a frame. A device's is at most 4,000 characters of JSON, the space's 64,000" } },
          { name: "device", optional: true, schema: { type: "string", description: "On the space's server: only this device, as sync:live named it" } },
        ],
        description:
          "Sends a live message, kept nowhere: from a page in a space, to the space's server plugins, which hear it as sync:live with the member and device it came from; from a server plugin, to every device that has said something on the topic (or only `device`), whose plugins hear it as sync:live. For moves and frames of a game played together, cursors, presence. A device may send 60 a second. Fails outside a space, or while the page can't reach it.",
      },
      trace: {
        args: "(on)",
        returns: "{ on }",
        needs: "reflect:read",
        params: [{ name: "on", schema: { type: "boolean", description: "true to start hearing the space's trace, false to stop" } }],
        description: "For debuggers: streams the trace of the space's own kernel, on its server, to this device as it happens: the sync:trace hook carries each batch, starting with a few hundred events from before. Stops when no plugin that asked is running. Fails outside a space, or while this page can't reach it.",
      },
      model: {
        args: "()",
        returns: "{ space: null } or { space, set: false } or { space, set, model, vendor, byName, yours, asked, daily, refused? }",
        // No `params`: with them, a method that needs no permission would be a tool every agent is handed (std/tools).
        description: "Whether the space holds a model key for its members (its owner gives one on their account page): which model it is for, the name of who gave it and pays (`byName`), whether that is you (`yours`), and how many of the day's questions you have asked. Never the key, which stays on the space's server. Outside a space, `space` is null. Needs no permission.",
      },
      ask: {
        args: "(request)",
        returns: "what llm.complete returns, or { models, tiers } for { models: true }",
        needs: "space-model",
        params: [{ name: "request", schema: { type: "object", description: "A request as llm.complete takes it ({ messages, system?, tools?, schema?, model?, maxTokens? }), or { models: true } for the models the key can use" } }],
        description: "Asks a language model on the key the space holds for its members: the request goes to the space's server, which asks the vendor with the key and sends back only the answer. The person is first shown whose key pays, once they allow it for good. What /std/llm/space.js uses to be a provider for llm: other plugins ask through llm. Fails outside a space, when the space has no key, or past a member's questions for the day.",
      },
      role: {
        args: "()",
        returns: "{ space: null } or { space, role?, owner? }",
        // No `params`, as for model().
        description: "What the person signed in here may do in this space: `role` is \"owner\", \"editor\", or \"reader\" (who sees the space but can't change it), once the space has said, and `owner` the owner's name, to say whom to ask. For saying so before they try. Outside a space, `space` is null. Needs no permission.",
      },
      dismiss: {
        args: "(ref)",
        returns: "{ ok }",
        needs: "sync",
        params: [{ name: "ref", schema: { type: "string", description: "The draft's ref, from state()" } }],
        description: "Lets a draft go: the record stays as the space has it.",
      },
    },
    capability: (method) =>
      method === "putBlob" || method === "getBlob" || method === "model" || method === "role"
        ? undefined
        : method === "ask"
          ? "space-model"
          : method === "members" || method === "may"
            ? "members"
            : method === "reflect" || method === "trace"
              ? "reflect:read"
              : method === "live"
                ? "live"
                : "sync",
    call: async (instance, method, args, dispatch) => {
      if (method === "putBlob" || method === "getBlob") {
        const caps = remote.installed.get(instance.split("@")[0])?.caps ?? new Set<string>();
        const allowed = grants(caps, "sync") || grants(caps, "files") || [...caps].some((c) => c.startsWith("files:"));
        if (!allowed && !check(instance, caps, "sync")) throw new Error("Missing capability sync");
        if (method === "putBlob") return space.blobs ? space.blobs.put(args?.[0], args?.[1]) : blobs.put(args?.[0], args?.[1]);
        return space.blobs ? space.blobs.get(String(args?.[0] ?? "")) : blobs.get(String(args?.[0] ?? ""));
      }
      if (method === "live") {
        const topic = checkTopic(args?.[0]);
        if (space.live) {
          const device = args?.[2];
          return { sent: true, reached: space.live.say(topic, args?.[1], typeof device === "string" ? device : undefined) };
        }
        const device = thisDevice.sync;
        if (!device) throw new Error("Live messages are for pages in a space: open the app at /s/<space>/…");
        if (JSON.stringify(args?.[1] ?? null).length > 4000) throw new Error("A live message from a page is at most 4,000 characters of JSON");
        attach(device);
        if (!device.send({ t: "sync", op: "live", topic, value: args?.[1] ?? null })) throw new Error("This page isn't connected to its space right now");
        return { sent: true };
      }
      if (method === "trace") {
        const device = thisDevice.sync;
        if (!device) throw new Error("This page isn't in a space: open the debugger at /s/<space>/… to hear its server");
        attach(device);
        const on = args?.[0] !== false;
        if (on) watchers.add(instance);
        else watchers.delete(instance);
        if (on && watchers.size === 1 && !device.send({ t: "sync", op: "trace", on: true })) {
          watchers.delete(instance);
          throw new Error("This page isn't connected to its space right now");
        }
        if (on && watchers.size > 1) device.send({ t: "sync", op: "trace", on: true });
        if (!on && !watchers.size) device.send({ t: "sync", op: "trace", on: false });
        return { on };
      }
      if (method === "model" || method === "ask") {
        const device = thisDevice.sync;
        const { space: name, member } = device ? await device.state() : { space: null, member: undefined };
        if (!name) {
          if (method === "model") return { space: null };
          throw new Error("A space's model is for pages in a space: open the app at /s/<space>/…, or add a model of your own from Customize");
        }
        const { modelState, askModel } = await import("./model-device");
        if (method === "model") {
          const { by, today: _today, vendors: _vendors, ...rest } = await modelState(name);
          return { space: name, ...rest, ...(rest.set ? { yours: !!member && by === member } : {}) };
        }
        const request = args?.[0];
        if (!request || typeof request !== "object") throw new Error("sync.ask takes a request, as llm.complete does");
        if ((request as { models?: unknown }).models === true) return askModel(name, { models: true });
        // Whose key pays, before the first question goes: the person may allow it for good.
        const has = await modelState(name);
        if (!has.set) throw new Error("This space has no model key. Its owner can give it one on their account page, or you can add a model of your own from Customize.");
        const whose = member && has.by === member ? "your key, which you gave this space" : `${has.byName}'s key`;
        await reviewed(
          instance,
          // Allowed for good only for this space and this person's key: a key someone else gives is asked about again.
          // (Shown as the space's name alone: review.ts shows what follows the #.)
          `place:space-model:${name}:${has.by}#${name}`,
          `the space ${name}: asks ${has.model} on ${whose}`,
          "",
          `What you ask, and what the app sends with it, goes to the space's server and from there to ${has.model}.\n${member && has.by === member ? "You pay" : `${has.byName} pays`} for each question. A member may ask ${has.daily} a day; you have asked ${has.asked} today.`,
          member && has.by === member ? "You pay for what is asked on this key" : `${has.byName} pays for what you ask`,
          dispatch,
        );
        return (await askModel(name, { request })).answer;
      }
      if (method === "role") {
        const s = await thisDevice.sync?.state();
        return s ? { space: s.space, ...(s.access ? { role: s.access.role, ...(s.access.owner ? { owner: s.access.owner } : {}) } : {}) } : { space: null };
      }
      if (method === "state") return state();
      if (method === "members") return members();
      if (method === "may") return may(args?.[0], args?.[1]);
      if (method === "reflect") {
        const device = thisDevice.sync;
        if (!device) throw new Error("This page isn't in a space: open the debugger at /s/<space>/… to look inside its server");
        return askSpace(device, String(args?.[0] ?? ""), (args ?? []).slice(1));
      }
      const device = thisDevice.sync;
      const ref = String(args?.[0] ?? "");
      if (method === "keep") return device ? device.keep(ref, dispatch) : { ok: false, error: "This page isn't in a space" };
      if (method === "dismiss") return device ? device.dismiss(ref) : { ok: false };
      throw new Error(`sync.${method} is not a method`);
    },
  };
};
