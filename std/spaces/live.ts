// Live messages: what the people in a space, and the space's own server
// plugins, say to each other as it happens, without keeping it. A game's
// moves and frames, a cursor, "I'm here". Changes to records go through sync
// (hub.ts) and are kept, ordered and reviewed; a live message is gone once
// it has been heard, so it can come many times a second.
//
//   a page    ctx.call("sync", "live", topic, value)       needs `live`
//    → device.ts sends { op: "live", topic, value }        on the member's own socket
//    → the space's kernel emits sync:live                  { topic, value, member, device }
//      where its server plugins hear it (hook:listen:sync:live)
//
//   a server plugin  ctx.call("sync", "live", topic, value, device?)
//    → { op: "live", topic, value } to every device that has said something
//      on that topic (or only to `device`)
//    → each device's kernel emits sync:live                { topic, value, from: "space" }
//      where the pages' plugins hear it
//
// A device hears a topic once it has said something on it, so the frames of a
// game go only to the devices playing it. When a device leaves, the space's
// plugins hear { topic, gone: true, member, device } for each topic it had
// spoken on. sync:live is a quiet hook (src/kernel/hooks.ts): a game's twenty
// frames a second don't fill the trace.
//
// Only members open a space's socket (src/server/front-door.ts), so only
// members' devices are heard, and each message says which member and
// device it came from: a device can't speak for another. The device is an
// id the space gives each connection, not one the device chose, so one
// can't take another's place by naming it. Messages are small
// (a device's at most 4 KB, the server's at most 64 KB) and a device may send
// at most 60 a second; more are dropped.

import type { Dispatch } from "../../src/shared/protocol";
import type { LiveToSpace, SyncToDevice } from "../../src/shared/sync";
import type { Host, Hosts } from "../../src/kernel/hosts";
import { record as trace } from "../../src/kernel/trace";

export const TOPIC = /^[a-z][a-z0-9-]{0,63}$/;
/** The largest message a device may send, and the space may, in characters of JSON. */
const FROM_DEVICE = 4_000;
const FROM_SPACE = 64_000;
/** How many messages a device may send in a second. */
const PER_SECOND = 60;
const MAX_TOPICS = 16;

export const LIVE_HOOK = {
  mode: "emit" as const,
  quiet: true,
  args: "{ topic, value, member?, device?, gone?, from? }",
  description:
    "A live message in a space (sync.live): on the space's server, from a member's device, with the member and the device it came from (gone: true when that device left); on a device, from the space's server plugins (from: \"space\"). Nothing is kept, and it isn't traced.",
};

export function checkTopic(topic: unknown): string {
  if (typeof topic !== "string" || !TOPIC.test(topic)) throw new Error("A live topic is lowercase letters, digits and dashes, up to 64, starting with a letter");
  return topic;
}

/** On a space's server: the devices that speak on each topic, and the messages between them and the space's plugins. */
export function liveSpace(root: { emit(dispatch: Dispatch, name: string, value: unknown): void }, hosts: Hosts) {
  const topics = new Map<Host, Set<string>>();
  const sent = new Map<Host, { second: number; count: number }>();
  /** Each connection's id, made here: what a device says in its hello is its own to choose, so it isn't used. */
  const ids = new WeakMap<Host, string>();
  const idOf = (host: Host) => ids.get(host) ?? ids.set(host, `d-${crypto.randomUUID()}`).get(host)!;
  let dropped = 0;
  return {
    /** A device said something. */
    heard(host: Host, message: LiveToSpace) {
      let topic: string;
      try {
        topic = checkTopic(message.topic);
      } catch {
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const rate = sent.get(host);
      if (rate && rate.second === now && rate.count >= PER_SECOND) {
        // Noted once in a while, not for each one, or a flood would fill the trace instead.
        if (dropped++ % 100 === 0) trace({ kind: "note", name: "sync:live", detail: `dropped messages from ${host.member ?? "a device"}: over ${PER_SECOND} a second` });
        return;
      }
      sent.set(host, rate && rate.second === now ? { second: now, count: rate.count + 1 } : { second: now, count: 1 });
      if (JSON.stringify(message.value ?? null).length > FROM_DEVICE) return;
      const mine = topics.get(host) ?? topics.set(host, new Set()).get(host)!;
      if (!mine.has(topic) && mine.size >= MAX_TOPICS) return;
      mine.add(topic);
      root.emit({ trace: `live-${topic}` }, "sync:live", { topic, value: message.value ?? null, ...(host.member ? { member: host.member } : {}), device: idOf(host) });
    },
    /** A server plugin speaks: to every device on the topic, or to one. Whether any device heard it. */
    say(topic: string, value: unknown, device?: string): number {
      checkTopic(topic);
      if (JSON.stringify(value ?? null).length > FROM_SPACE) throw new Error(`A live message from the space is at most ${FROM_SPACE} characters of JSON`);
      const message: SyncToDevice = { t: "sync", op: "live", topic, value: value ?? null };
      let reached = 0;
      for (const [host, mine] of topics) {
        if (!mine.has(topic) || (device !== undefined && idOf(host) !== device)) continue;
        hosts.send(host, message);
        reached++;
      }
      return reached;
    },
    /** A device left: the space's plugins hear it on each topic it spoke on. */
    left(host: Host) {
      const mine = topics.get(host);
      topics.delete(host);
      sent.delete(host);
      for (const topic of mine ?? []) root.emit({ trace: `live-${topic}` }, "sync:live", { topic, value: null, gone: true, ...(host.member ? { member: host.member } : {}), device: idOf(host) });
    },
    stop() {
      topics.clear();
      sent.clear();
    },
  };
}

export type LiveSpace = ReturnType<typeof liveSpace>;
