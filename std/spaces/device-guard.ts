// On a device in a space: stops a write the person's role, or the
// collection's rules, don't allow (permissions.ts) before it is made here,
// and says who can make it. The space's server would refuse it anyway, and
// put the record back; stopping it here means nothing appears on the screen
// only to go again, and a form keeps what was typed and shows why.
//
// The space says what the member may do with its answer to hello, and the
// device keeps it (device.ts), so this holds offline too. A device that has
// never reached its space knows no role yet and stops nothing: the space
// decides when it hears the changes.
//
// Every collection has a `data:beforeWrite:<collection>` hook, which runs
// before a plugin's write or an undo (never for a change that came from the
// space). This listens to each the first time it runs: Cordis tells
// `internal/dispatch` listeners just before it gathers a hook's listeners, so
// one added then is in time for that very write.

import type { Hosts } from "../../src/kernel/hosts";
import type { Change } from "../../src/kernel/records";
import type { Dispatch } from "../../src/shared/protocol";
import type { syncDevice } from "./device";
import { allowed, type Rules } from "./rules";

const HOOK = "data:beforeWrite:";

export function deviceGuard(root: { on(name: string, listener: (...args: any[]) => unknown): () => void }, hosts: Hosts, device: ReturnType<typeof syncDevice>) {
  const stops = new Map<string, () => void>();
  /** When the person was last told, so one press that writes several records says it once. */
  let told = 0;

  async function guard(this: Dispatch | null, change: Change) {
    const { access, member } = await device.state();
    if (!access) return undefined;
    const doing = !change.before ? "add" : change.after ? "change" : "remove";
    const mine = !!member && access.authors[`${change.collection}/${change.id}`] === member;
    if (allowed(access.rules[change.collection] as Rules | undefined, doing, access.role, mine)) return undefined;
    const ask = access.owner ? `the space's owner, ${access.owner},` : "the space's owner";
    const why = access.role === "reader" ? `You can read this space but not change it. Ask ${ask} to make you an editor.` : doing === "add" ? `Only ${ask} can add to this.` : `Only whoever added this, or ${ask}, can ${doing} it.`;
    // Said on the page too, since not every view shows why a write failed: in the tab the person pressed in when the
    // write says which (an action's trace starts with its tab), in every tab otherwise. Once for a burst of writes.
    if (Date.now() - told > 5000) {
      told = Date.now();
      const tab = this?.trace?.split("-")[0];
      const host = tab ? hosts.list.find((h) => h.tab === tab) : undefined;
      for (const to of host ? [host] : hosts.list) hosts.send(to, { t: "notice", text: why, tone: "error" });
    }
    return { block: why };
  }

  const stop = root.on("internal/dispatch", (_mode: string, name: unknown) => {
    if (typeof name !== "string" || !name.startsWith(HOOK) || stops.has(name)) return;
    stops.set(name, root.on(name, guard));
  });
  return () => {
    stop();
    for (const off of stops.values()) off();
    stops.clear();
  };
}
