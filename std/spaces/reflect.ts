// A member's debugger, looking inside the space's own kernel on its server.
//
// The debugger (demos/debugger/) reads a kernel through the `reflect`
// service, which only sees the kernel it runs in: in a browser, this
// device's tabs. A space's server runs a kernel of its own, with the
// plugins that run there (`runs: "server"`), the hooks they listen to and
// the members' devices connected to it. This file lets a page in the space
// ask that kernel the same questions, over the socket the page already
// keeps with its space:
//
//   page  ctx.call("sync", "reflect", "snapshot")      needs reflect:read (service.ts)
//    → device.ts sends { op: "reflect", id, method }   on the member's own socket
//    → the space's kernel asks its reflect service     only its read-only methods
//    ← { op: "reflect:reply", id, ok, value }
//
// Who may ask: a member of the space, since only members can open its
// socket (src/server/front-door.ts), and only from a plugin given
// reflect:read on their own device. What comes back is what reflect gives
// anywhere: manifests, permissions, hooks, workers, the devices connected
// and which member each is, a plugin's code, and whether each secret is
// set, never its value. Members can already read the space's plugins in
// Customize, so this shows them nothing they couldn't find, only how it is
// running now.

import type { Dispatch } from "../../src/shared/protocol";
import type { ReflectRequest, SyncToDevice } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import type { RemotePlugins } from "../../src/kernel/remote";
import { record as trace } from "../../src/kernel/trace";

/** The reflect methods a member's device may ask the space: every one, as reflect only reads. */
export const READS = ["snapshot", "plugins", "hooks", "workers", "tabs", "source"];

/** How long a device waits for the space's answer. */
const WAIT_MS = 10_000;

/** On the space's server: answers each member's question from the kernel's own reflect service. */
export function spaceReflect(remote: RemotePlugins, hosts: Hosts) {
  let asked = 0;
  return async (host: Host, m: ReflectRequest): Promise<void> => {
    const reply = (rest: Omit<Extract<SyncToDevice, { op: "reflect:reply" }>, "t" | "op" | "id">) => hosts.send(host, { t: "sync", op: "reflect:reply", id: m.id, ...rest });
    const reflect = remote.services.reflect;
    if (!reflect) return reply({ ok: false, error: "This space's kernel has no reflect module" });
    if (!READS.includes(m.method)) return reply({ ok: false, error: `reflect.${String(m.method)} isn't something a member can ask the space` });
    const args = Array.isArray(m.args) ? m.args.slice(0, 1).map(String) : [];
    const dispatch: Dispatch = { trace: `reflect-${host.member ?? "member"}-${++asked}` };
    try {
      const value = await reflect.call(`space-debugger@${host.tab}`, m.method, args, dispatch);
      trace({ kind: "note", name: "reflect:space", detail: `${m.method}, for ${host.member ?? "a member"}` });
      reply({ ok: true, value });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** What a page's sync service needs of this device's link to its space (device.ts). */
interface Link {
  send(message: ReflectRequest): boolean;
  heard: Set<(message: SyncToDevice) => void>;
}

let next = 0;

/** In a browser kernel for a space: asks the space's kernel one reflect question, and waits for its answer. */
export function askSpace(link: Link, method: string, args: unknown[]): Promise<unknown> {
  if (!READS.includes(method)) return Promise.reject(new Error(`reflect.${method} isn't something you can ask the space`));
  const id = ++next;
  return new Promise((resolve, reject) => {
    const done = () => {
      link.heard.delete(listen);
      clearTimeout(timer);
    };
    const listen = (message: SyncToDevice) => {
      if (message.op !== "reflect:reply" || message.id !== id) return;
      done();
      if (message.ok) resolve(message.value);
      else reject(new Error(message.error ?? "The space couldn't answer"));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("The space didn't answer in time"));
    }, WAIT_MS);
    link.heard.add(listen);
    if (!link.send({ t: "sync", op: "reflect", id, method, args: args.slice(0, 1) })) {
      done();
      reject(new Error("This page isn't connected to its space right now"));
    }
  });
}
