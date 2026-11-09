// The `sync` service: how a page in a space (/s/<space>/…) stands with the
// space, and the drafts it keeps. The spaces module (module.ts) gives it,
// from this file, as `ctx.call("sync", …)`.
//
// A change the space refused (someone changed the record first) is replaced
// by the space's record, and the person's version is kept as a draft
// (device.ts). This service lists the drafts, and lets the
// person keep theirs after all, which makes it a new change to the record,
// or let it go. A plugin calls it for the person, from buttons (std/sync.js).
// Keeping a draft writes a record without a review, so `sync` is a permission
// to give only to a plugin that does it when the person asks.
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
import type { ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";
import { thisDevice } from "./this-device";
import { askSpace, READS } from "./reflect";
import { checkTopic, LIVE_HOOK, type LiveSpace } from "./live";
import type { SyncToDevice } from "../../src/shared/sync";

export default ({ root, collections, hook, cleanup, remote }: ModuleKernel, space: { live?: LiveSpace } = {}): ServiceProvider => {
  hook("sync:live", LIVE_HOOK);
  hook("sync:trace", {
    mode: "emit",
    quiet: true,
    needs: "reflect:read",
    args: "{ events: [{ seq, at, kind, name, plugin?, trace?, ms?, detail? }], first?, error? }",
    description: "New events in the trace of the space's own kernel, on its server, for a debugger that asked with sync.trace(true): first is the batch from before it asked (again after each reconnection), and error says the space stopped sending. They name every server plugin and what it did, so listening needs reflect:read.",
  });
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
    clearTimeout(soon);
    soon = setTimeout(async () => {
      root.emit({}, "sync:changed", {});
      const s = await thisDevice.sync?.state();
      const now = JSON.stringify([s?.member ?? null, s?.members ?? {}]);
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
    return { space: s.space, ...(s.member ? { member: s.member } : {}), connected: s.connected, pending: s.pending, drafts };
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
    description: "How a page in a space stands with it, and the drafts it kept when someone else changed a record first.",
    methods: {
      state: {
        args: "()",
        returns: "{ space: null } or { space, member?, connected, pending, drafts }",
        needs: "sync",
        params: [],
        description: "Whether this page keeps a copy of a space, who it is signed in as there (`member`, once the space has said), whether it reaches the space now, how many changes wait to be sent, and its drafts. A draft is `{ ref, collection, title, id, label?, mine, why, at }`: mine is the record as this device had made it (null for a delete).",
      },
      members: {
        args: "()",
        returns: "{ space, you?, members: [{ id, name }] }",
        needs: "members",
        params: [],
        description: "The space's members, each with the name on their account, and which of them this page is signed in as (`you`). A change's `by` and data:changed's `by` are a member's id: show the name from here. Outside a space, `space` is null and the list is empty.",
      },
      keep: {
        args: "(ref)",
        returns: "{ ok } or { ok: false, error }",
        needs: "sync",
        params: [{ name: "ref", schema: { type: "string", description: "The draft's ref, from state()" } }],
        description: "Makes a draft the record again, with no review, as a new change sent to the space. data:beforeWrite listeners can still stop it.",
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
      dismiss: {
        args: "(ref)",
        returns: "{ ok }",
        needs: "sync",
        params: [{ name: "ref", schema: { type: "string", description: "The draft's ref, from state()" } }],
        description: "Lets a draft go: the record stays as the space has it.",
      },
    },
    capability: (method) => (method === "members" ? "members" : method === "reflect" || method === "trace" ? "reflect:read" : method === "live" ? "live" : "sync"),
    call: async (instance, method, args, dispatch) => {
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
      if (method === "state") return state();
      if (method === "members") return members();
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
