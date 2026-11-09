// Sync status for a page in a space (/s/<space>/…): a line saying whether it
// reaches the space and what it has still to send, and the drafts it kept
// when someone else changed a record first, each with "Use mine" (make it the
// record again, as a new change) and "Keep theirs" (let it go).
//
// Add it to any app with two lines in its app.html; it draws nothing when the
// app isn't open in a space:
//
//   <link rel="plugin" href="/std/sync.js">
//   <slot name="sync"></slot>
//
// The kernel keeps the drafts (std/spaces/device.ts) and the `sync`
// service hands them out; this plugin only draws them. Using a draft writes
// the record without a review, so the plugin does it only when the person
// presses the button.

export const manifest = {
  id: "sync-status",
  name: "Sync",
  description: "In a space: whether this page reaches it, and the versions of records it kept when someone else changed them first.",
  version: "1.0.0",
  permissions: ["ui", "sync"],
  services: ["sync"],
  // Where it draws on a page with no <slot name="sync">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "sync": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["sync.html"],
};

const when = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export default async function (ctx) {
  const views = ctx.ui.views("sync.html");
  /** What the last press couldn't do, shown until the next change. */
  let problem = "";

  const view = views.live("sync", "sync", async (ctx) => {
    const s = await ctx.call("sync", "state");
    if (!s.space) return { space: false };
    const waiting = s.pending ? `${s.pending} ${s.pending === 1 ? "change" : "changes"} to send` : "";
    const status = s.connected ? (waiting ? `Sending ${waiting} to ${s.space}…` : `In step with ${s.space}`) : `Can't reach ${s.space} now: working on this device${waiting ? `, ${waiting} when it's back` : ""}`;
    const drafts = s.drafts.map((d) => ({ ref: d.ref, text: d.label ? `“${d.label}” in ${d.title}` : `a record in ${d.title}`, why: d.why.replace(/^\w/, (c) => c.toLowerCase()), when: when(d.at) }));
    return { space: true, status, drafts, problem };
  });

  ctx.on("sync:changed", () => {
    problem = "";
    view.refresh();
  });

  ctx.ui.onEvent(async (action, ref) => {
    if (action !== "keep" && action !== "dismiss") return;
    const result = await ctx.call("sync", action, ref);
    problem = result.ok ? "" : `Couldn't use your version: ${result.error ?? "it's gone"}`;
    view.refresh();
  });
}
