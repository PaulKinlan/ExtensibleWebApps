// What a server lets through from a member's client to a space's kernel, and
// what it tells the kernel about that client: which member of the space it
// is, and what that member may do there. The server checked the client's
// session before it joined, so only the server may say; a client that claims
// to be someone, or to have a role, is ignored.
//
// A page talks to its own kernel freely: the kernel is the person's. A
// space's kernel is everyone's, and a member's device needs to say very
// little to it, so everything here is a list of what is let through, and
// anything not on a list never reaches the kernel:
//
//   hello, bye, bridge:result   joining, leaving, and answers the kernel asked the client for
//   sync                        the space's own messages (std/spaces/hub.ts), each marked with the
//                               member's role; the space refuses the ones a reader may not send
//                               (std/spaces/permissions.ts), with words the person can act on
//   command                     only the commands below, by role
//
// The commands of a kernel (src/kernel/kernel.ts and the modules') that a
// client of a space may run:
//
//   anyone     changes, fetched, modules, reference, sync, trace: each only reads
//   the owner  also restart-module and reload (starting a part of the space's kernel again), and
//              user:list, user:add, user:remove, user:on, user:off (the plugin files the space's
//              folder keeps, which a space's server never runs)
//
// Every other command is refused for everyone, the owner too: install and
// uninstall (a space's server runs only the plugins of the apps the site
// serves), route, place:*, plugins-panel, the developer tools' own (bench,
// reload-test, game-state), follow, launch:arrived, outside:call, an agent's.
// A command added to the kernel later is refused until it is listed here.
//
// Nothing that speaks for a view passes either (a form's record, a button's
// event, a canvas, an app opening): a space's server draws nothing, and those
// are written as the plugin they name rather than as the member, which would
// get past the rules a collection sets for members.

import type { Role } from "./auth/roles.ts";

/** The commands any member's client may run: each only reads. */
const READS = new Set(["changes", "fetched", "modules", "reference", "sync", "trace"]);
/** The commands only the owner's client may run: they start parts of the space's kernel again, or change the plugin files its folder keeps. */
const OWNERS = new Set(["restart-module", "reload", "user:list", "user:add", "user:remove", "user:on", "user:off"]);
/** What a client may say besides `sync` and commands: it joins, leaves, and answers what the kernel asked it. */
const PASSES = new Set(["hello", "bye", "bridge:result"]);

/** Why a member's client may not run a command, in words for the person; nothing if it may. */
export function refused(name: unknown, role: Role = "editor"): string | undefined {
  const command = String(name);
  if (READS.has(command)) return undefined;
  if (OWNERS.has(command)) return role === "owner" ? undefined : `Only the space's owner can do that here (${command}). Ask them to, or to make the change for you.`;
  if (role === "reader") return "You can read this space but not change it. Ask the space's owner to make you an editor.";
  return `A space's server doesn't take this from a member's device (${command.slice(0, 40)}). Make the change in the app, opened in the space: it reaches the space as a change it can check.`;
}

/**
 * What to answer a client whose message won't reach the kernel, when it waits for an answer: a command it may
 * not run is answered as the command would be, with why and what to do. Nothing for a message that passes, or
 * one nobody waits on. The host sends it (serve.ts, cloudflare/kernel.ts).
 */
export function answerFor(message: unknown, role: Role = "editor"): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const m = message as Record<string, unknown>;
  if (m.t !== "command") return undefined;
  const error = refused(m.name, role);
  return error ? { t: "command:result", id: m.id, value: { ok: false, error } } : undefined;
}

/** A client's message as the kernel should hear it: a hello says which member it is, a sync message what they may do, and nothing else may. Null for one the kernel never hears. */
export function signed(message: unknown, member: string, role: Role = "editor"): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const { member: _claimed, role: _claimedRole, ...rest } = message as Record<string, unknown>;
  if (rest.t === "hello") return { ...rest, member };
  if (rest.t === "sync") return { ...rest, role };
  if (PASSES.has(String(rest.t))) return rest;
  if (rest.t === "command" && !refused(rest.name, role)) return rest;
  return null;
}
