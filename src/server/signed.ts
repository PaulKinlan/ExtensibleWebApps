// What a server tells a space's kernel about each client: which member of
// the space it is, and what that member may do there. The server checked the
// client's session before it joined, so only the server may say; a client that
// claims to be someone, or to have a role, is ignored.
//
// A reader sees a space and changes nothing, so only what reads gets past
// here from a reader's client: hello and bye, answers the kernel asked the
// client for, the commands that read, and `sync` messages. Each `sync`
// message is marked with the role, and the space's own handlers refuse the
// ones that change something with words the person can act on
// (std/spaces/permissions.ts, hub.ts). Anything else a reader's client sends
// (a view's event, a record from a form, a command that installs or removes)
// would change the space, and never reaches its kernel.
//
// And from anyone's client, nothing that speaks for a view (VIEWS below):
// those are written as a plugin, not as the member, so they would get past
// the rules a collection sets for members.

import type { Role } from "./auth/roles.ts";

/** The commands a reader's client may run: each only reads. */
const READS = new Set(["changes", "fetched", "modules", "reference", "sync", "trace"]);
/** What a reader's client may say besides `sync`: it joins, leaves, and answers what the kernel asked it. */
const PASSES = new Set(["hello", "bye", "bridge:result"]);

/**
 * What a page says to its own kernel about a view: a form's record, a button's event, a canvas. A space's server
 * draws nothing, so no client has one to speak of, and each would act as the plugin it names rather than as the
 * member who sent it, past the collection's rules. None reaches a space's kernel, whoever sends it.
 */
const VIEWS = new Set(["record", "bind", "unbind", "event", "canvas", "canvas:theme"]);

/** A client's message as the kernel should hear it: a hello says which member it is, a sync message what they may do, and nothing else may. */
export function signed(message: unknown, member: string, role: Role = "editor"): unknown {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const { member: _claimed, role: _claimedRole, ...rest } = message as Record<string, unknown>;
    if (rest.t === "hello") return { ...rest, member };
    if (rest.t === "sync") return { ...rest, role };
    if (VIEWS.has(String(rest.t))) return { t: "refused:view" };
    if (role !== "reader" || PASSES.has(String(rest.t))) return rest;
    // A command always gets an answer, so a reader's client isn't left waiting: one that would change something is answered as a command nobody has.
    if (rest.t === "command") return READS.has(String(rest.name)) ? rest : { ...rest, name: "refused:reader", arg: undefined };
    return { t: "refused:reader" };
  }
  return message;
}
