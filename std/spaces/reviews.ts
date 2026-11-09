// Reviews for a space's server. A write a server plugin makes to data it
// doesn't own is reviewed, as in a browser (review.ts), but the server has
// no screen: its "tabs" are members' devices, which sync with it. So the
// space sends each review to the devices that have it open, each device
// shows it as an ordinary review card, and the first member to answer
// decides. An "always allow" is kept by the space, with its grants, not on
// the device. A device that connects while a review waits asks for it.
//
// This is what lets an outside agent change a space's data over MCP
// (std/outside/module.ts) with the same card a plugin's change gets.

import type { SpaceReview, SyncToDevice } from "../../src/shared/sync";
import type { Host } from "../../src/kernel/hosts";
import type { Request, Reviews } from "../../src/kernel/review";
import type { syncDevice } from "./device";
import type { syncHub } from "./hub";
import { record } from "../../src/kernel/trace";

const asked = (id: string, r: Request): SyncToDevice => ({
  t: "sync",
  op: "review",
  action: "ask",
  id,
  review: { plugin: r.plugin, name: r.name, place: r.place, target: r.target, before: r.before, after: r.after, reason: r.reason, ...(r.kind ? { kind: r.kind } : {}), ...(r.once ? { once: true } : {}) },
});

/** On a space's server: its reviews go to members' devices, and their answers come back. Returns how to stop. */
export function relayReviews(reviews: Reviews, sync: ReturnType<typeof syncHub>, send: (host: Host, message: SyncToDevice) => void) {
  reviews.relay = (id, request) => sync.tell(asked(id, request));
  reviews.relayDone = (id) => sync.tell({ t: "sync", op: "review", action: "done", id });
  sync.reviews = (host, message) => {
    // Only a member answers: the server says who a device is, a device can't.
    if (!host.member) return;
    if (message.action === "waiting") for (const [id, request] of reviews.waiting()) send(host, asked(id, request));
    else if (message.action === "answer" && typeof message.id === "string") {
      record({ kind: "note", name: "review:answered", detail: `${message.outcome}, by ${host.member}` });
      reviews.answer(message.id, message.outcome, `review-by-${host.member}`);
    }
  };
  return () => {
    reviews.relay = undefined;
    reviews.relayDone = undefined;
  };
}

/** On a member's device in a space: shows the space's reviews here, and sends the answer back. Returns how to stop. */
export function deviceReviews(reviews: Reviews, device: ReturnType<typeof syncDevice>) {
  /** The space's reviews shown here, which the space has since settled. */
  const done = new Set<string>();
  /** The space's reviews on screen here now: asked again after a reconnect, one is shown once. */
  const showing = new Set<string>();
  const instance = (id: string) => `space-review:${id}`;
  const hear = (message: SyncToDevice) => {
    if (message.op !== "review") return;
    if (message.action === "done") {
      done.add(message.id);
      return reviews.cancelInstance(instance(message.id));
    }
    if (message.action !== "ask") return;
    const r: SpaceReview = message.review;
    const id = message.id;
    if (showing.has(id)) return;
    showing.add(id);
    done.delete(id);
    void reviews
      .ask(
        {
          plugin: r.plugin,
          instance: instance(id),
          name: `${r.name} (on the space's server)`,
          place: r.place,
          target: r.target,
          before: r.before,
          after: r.after,
          reason: r.reason,
          ...(r.kind ? { kind: r.kind } : {}),
          ...(r.once ? { once: true } : {}),
          elsewhere: true,
        },
        { trace: `space-review-${id}` },
      )
      .then((outcome) => {
        showing.delete(id);
        // Settled here because the space settled it (someone else answered), or nobody here did: nothing to send.
        if (done.has(id) || (outcome !== "allowed-once" && outcome !== "allowed-always" && outcome !== "rejected")) return;
        device.send({ t: "sync", op: "review", action: "answer", id, outcome } as never);
      });
  };
  const caughtUp = () => device.send({ t: "sync", op: "review", action: "waiting" } as never);
  device.heard.add(hear);
  device.caughtUp.add(caughtUp);
  return () => {
    device.heard.delete(hear);
    device.caughtUp.delete(caughtUp);
    // Its cards go with it: the next device asks for the space's waiting reviews and shows them again.
    for (const id of showing) {
      done.add(id);
      reviews.cancelInstance(instance(id));
    }
    showing.clear();
  };
}
