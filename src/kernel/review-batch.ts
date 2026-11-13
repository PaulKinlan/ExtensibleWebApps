// Grouped review actions (review.ts): fetched the first time two or more
// review requests from the same plugin and place wait at once, as when an
// import or an agent proposes several changes together. Draws a summary above
// the individual cards so the person can accept or decline all N at once, or
// still answer each card on its own.
//
// Every rendered banner revision gets a monotonically increasing token bound
// to an immutable snapshot of the exact request IDs shown in that banner, so a
// request arriving after the banner was drawn is never settled unseen and an
// earlier or replayed token can never target a later batch.

import type { View } from "../shared/protocol";
import type { Hosts } from "./hosts";
import type { Outcome, Pending } from "./review";
import { record } from "./trace";

type Snapshot = {
  readonly plugin: string;
  readonly place: string;
  readonly ids: readonly string[];
};

type Shown = {
  readonly key: string;
  readonly plugin: string;
  readonly place: string;
  sig: string;
  token: string;
};

function parseBatchAction(action: string): { verb: "accept" | "decline"; token: string } | undefined {
  const parts = action.split(":");
  if ((parts[0] === "accept-batch" || parts[0] === "decline-batch") && parts[1]) {
    return { verb: parts[0] === "accept-batch" ? "accept" : "decline", token: parts[1] };
  }
  if (parts[0] === "batch" && (parts[1] === "accept" || parts[1] === "decline") && parts[2]) {
    return { verb: parts[1], token: parts[2] };
  }
  return undefined;
}

export function reviewBatches(
  hosts: Hosts,
  pending: Map<string, Pending>,
  settle: (id: string, outcome: Outcome, trace?: string) => void,
  placeLabel: (place: string) => string,
) {
  const snapshots = new Map<string, Snapshot>();
  const shown = new Map<string, Shown>();
  let nextView = 0;
  let batchRev = 0;
  let settling = false;

  const groupKey = (plugin: string, place: string) => `${plugin}\n${place}`;

  function dropGroupSnapshots(plugin: string, place: string) {
    for (const [tok, snap] of snapshots) {
      if (snap.plugin === plugin && snap.place === place) snapshots.delete(tok);
    }
  }

  function banner(token: string, items: Pending[]): View {
    const first = items[0].request;
    const n = items.length;
    const label = placeLabel(first.place);
    const preview = items.slice(0, 3).map((p) => p.request.target).join(", ");
    const rest = n > 3 ? `, and ${n - 3} more` : "";
    return {
      type: "stack",
      children: [
        { type: "heading", text: `${first.name} wants ${n} changes in ${label}` },
        { type: "text", text: `${preview}${rest} — review each below, or answer all ${n} at once.`, tone: "muted" },
        {
          type: "stack",
          direction: "row",
          children: [
            { type: "button", label: `Accept all ${n} in ${label}`, action: `accept-batch:${token}`, primary: true },
            { type: "button", label: `Decline all ${n}`, action: `decline-batch:${token}` },
          ],
        },
      ],
    };
  }

  function sync() {
    if (settling) return;
    const grouped = new Map<string, [string, Pending][]>();
    for (const entry of pending) {
      const p = entry[1];
      const k = groupKey(p.request.plugin, p.request.place);
      let list = grouped.get(k);
      if (!list) grouped.set(k, (list = []));
      list.push(entry);
    }
    const active = new Set<string>();
    for (const [k, entries] of grouped) {
      if (entries.length < 2) continue;
      active.add(k);
      const { plugin, place } = entries[0][1].request;
      const ids = Object.freeze(entries.map(([id]) => id));
      const sig = ids.join(",");
      const prev = shown.get(k);
      if (prev && prev.sig === sig) continue;
      const token = String(++batchRev);
      snapshots.set(token, { plugin, place, ids });
      const key = prev ? prev.key : `review-batch:${++nextView}`;
      shown.set(k, { key, plugin, place, sig, token });
      hosts.render("review", "main", key, banner(token, entries.map(([, p]) => p)), -1);
    }
    for (const [k, prev] of [...shown]) {
      if (active.has(k)) continue;
      shown.delete(k);
      dropGroupSnapshots(prev.plugin, prev.place);
      hosts.render("review", "main", prev.key, null, -1);
    }
    for (const [tok, snap] of snapshots) {
      if (!snap.ids.some((id) => pending.has(id))) snapshots.delete(tok);
    }
  }

  function event(action: string, trace: string) {
    const parsed = parseBatchAction(action);
    if (!parsed) return;
    const snap = snapshots.get(parsed.token);
    if (!snap) return;
    const ids = snap.ids.filter((id) => pending.has(id));
    if (!ids.length) {
      snapshots.delete(parsed.token);
      return;
    }
    dropGroupSnapshots(snap.plugin, snap.place);
    const outcome: Outcome = parsed.verb === "accept" ? "allowed-once" : "rejected";
    record({ kind: "note", name: "review:batch", plugin: snap.plugin, trace, detail: `${outcome} (${ids.length} in ${placeLabel(snap.place)})` });
    settling = true;
    try {
      for (const id of ids) settle(id, outcome, trace);
    } finally {
      settling = false;
      sync();
    }
  }

  return { sync, event };
}
