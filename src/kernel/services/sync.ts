// The `sync` service: how a page in a space (/s/<space>/…) stands with the
// space, and the drafts it keeps. Found by name: this file is
// src/kernel/services/sync.ts, so it is `ctx.call("sync", …)`.
//
// A change the space refused (someone changed the record first) is replaced
// by the space's record, and the person's version is kept as a draft
// (src/kernel/sync-device.ts). This service lists the drafts, and lets the
// person keep theirs after all, which makes it a new change to the record,
// or let it go. A plugin calls it for the person, from buttons (std/sync.js).
// Keeping a draft writes a record without a review, so `sync` is a permission
// to give only to a plugin that does it when the person asks.
//
// In a kernel that keeps no space, state() says so and there's nothing to do.

import { env } from "../env";
import { defineHook } from "../hooks";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";
import { thisDevice } from "../sync-device";

defineHook("sync:changed", {
  mode: "emit",
  needs: "sync",
  args: "{}",
  description: "This page's sync with its space changed: it connected or lost the server, sent what it had, or kept or let go of a draft. Read sync.state().",
});

defineHook("members:changed", {
  mode: "emit",
  needs: "members",
  args: "{}",
  description: "The space told this page who its members are and which one this page is signed in as, or that changed. Read sync.members().",
});

export default ({ root, collections }: Kernel): ServiceProvider => {
  // Many changes at once (a whole push answered) are told once, just after the last.
  let soon: ReturnType<typeof setTimeout> | undefined;
  /** The members as last told, to tell members:changed only when they change. */
  let told = "";
  thisDevice.changed.add(() => {
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
    return { space: s.space, ...(s.member ? { member: s.member } : {}), members: s.members, connected: s.connected, pending: s.pending, drafts };
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
        returns: "{ space: null } or { space, member?, members, connected, pending, drafts }",
        needs: "sync",
        params: [],
        description: "Whether this page keeps a copy of a space, who it is signed in as there (`member`, once the space has said), each member's name by id (`members`), whether it reaches the space now, how many changes wait to be sent, and its drafts. A draft is `{ ref, collection, title, id, label?, mine, why, at }`: mine is the record as this device had made it (null for a delete).",
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
      dismiss: {
        args: "(ref)",
        returns: "{ ok }",
        needs: "sync",
        params: [{ name: "ref", schema: { type: "string", description: "The draft's ref, from state()" } }],
        description: "Lets a draft go: the record stays as the space has it.",
      },
    },
    capability: (method) => (method === "members" ? "members" : "sync"),
    call: async (_instance, method, args, dispatch) => {
      if (method === "state") return state();
      if (method === "members") return members();
      const device = thisDevice.sync;
      const ref = String(args?.[0] ?? "");
      if (method === "keep") return device ? device.keep(ref, dispatch) : { ok: false, error: "This page isn't in a space" };
      if (method === "dismiss") return device ? device.dismiss(ref) : { ok: false };
      throw new Error(`sync.${method} is not a method`);
    },
  };
};
