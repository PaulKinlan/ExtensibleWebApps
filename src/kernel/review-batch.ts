// Grouped review actions (review.ts): fetched the first time two or more
// review requests from the same plugin and place wait at once, as when an
// import or an agent proposes several changes together. Draws a summary above
// the individual cards so the person can accept or decline all N at once, or
// still answer each card on its own.

import type { View } from "../shared/protocol";
import type { Hosts } from "./hosts";
import type { Outcome, Pending } from "./review";
import { record } from "./trace";

export function reviewBatches(
  hosts: Hosts,
  pending: Map<string, Pending>,
  settle: (id: string, outcome: Outcome, trace?: string) => void,
  placeLabel: (place: string) => string,
) {
  const groupIds = new Map<string, string>();
  const groupsById = new Map<string, { plugin: string; place: string }>();
  const shown = new Set<string>();
  let nextGroup = 0;
  let settling = false;

  const groupKey = (plugin: string, place: string) => `${plugin}\n${place}`;

  function idFor(plugin: string, place: string): string {
    const k = groupKey(plugin, place);
    let id = groupIds.get(k);
    if (!id) {
      id = String(++nextGroup);
      groupIds.set(k, id);
      groupsById.set(id, { plugin, place });
    }
    return id;
  }

  function banner(gid: string, items: Pending[]): View {
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
            { type: "button", label: `Accept all ${n} in ${label}`, action: `batch:accept:${gid}`, primary: true },
            { type: "button", label: `Decline all ${n}`, action: `batch:decline:${gid}` },
          ],
        },
      ],
    };
  }

  function sync() {
    if (settling) return;
    const grouped = new Map<string, Pending[]>();
    for (const p of pending.values()) {
      const k = groupKey(p.request.plugin, p.request.place);
      let list = grouped.get(k);
      if (!list) grouped.set(k, (list = []));
      list.push(p);
    }
    const active = new Set<string>();
    for (const items of grouped.values()) {
      if (items.length < 2) continue;
      const { plugin, place } = items[0].request;
      const gid = idFor(plugin, place);
      const key = `review-batch:${gid}`;
      active.add(key);
      shown.add(key);
      hosts.render("review", "main", key, banner(gid, items), -1);
    }
    for (const key of [...shown]) {
      if (active.has(key)) continue;
      shown.delete(key);
      hosts.render("review", "main", key, null, -1);
    }
  }

  function event(action: string, trace: string) {
    const [, verb, gid] = action.split(":");
    const group = gid ? groupsById.get(gid) : undefined;
    if (!group || (verb !== "accept" && verb !== "decline")) return;
    const outcome: Outcome = verb === "accept" ? "allowed-once" : "rejected";
    const ids = [...pending].filter(([, p]) => p.request.plugin === group.plugin && p.request.place === group.place).map(([id]) => id);
    if (!ids.length) return;
    record({ kind: "note", name: "review:batch", plugin: group.plugin, trace, detail: `${outcome} (${ids.length} in ${placeLabel(group.place)})` });
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
