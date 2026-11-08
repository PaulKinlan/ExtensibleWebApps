// Events: everything the kernel traces, as it happens. Each hook that fires,
// each answer a plugin gives to a hook that waits for one, each service call
// and how long it took, each refused permission, each worker started or
// stopped, and each error. Filter by kind or text, pause, or follow one
// action: every event of an action shares a trace id, across workers.
//
// It hears the trace with the `debug:trace` hook (`debug:read`). Focused on a
// tab (target.js), it keeps that app's plugins' events, that tab's page
// errors, and the kernel's own events.

export const manifest = {
  id: "debugger-events",
  name: "Debugger: events",
  description: "Hooks, calls, refusals, workers and errors as they happen, filtered and paused at will.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "debug:read", "bus:read:debugger-focus", "hook:listen:bus:posted"],
  scope: "tab",
};

/** How many events it keeps, and the most it draws. */
const KEEP = 2000;
const DRAWN = 150;
const KINDS = ["dispatch", "remote", "call", "denied", "lifecycle", "bridge", "error", "note"];
/** What each kind of event is, for the filter's labels. */
const LABELS = { dispatch: "hooks fired", remote: "plugin answers", call: "service calls", denied: "refused", lifecycle: "lifecycle", bridge: "bridge", error: "errors", note: "notes" };

export default async function (ctx) {
  const views = ctx.ui.views("events.html");
  const { tab: me } = await ctx.call("debug", "app");
  let events = [];
  let lastSeq = 0;
  let startedAt = Date.now();
  let paused = false;
  let search = "";
  let follow = "";
  const kinds = new Set(KINDS.filter((k) => k !== "bridge"));
  /** The focused tab and the plugins its app links; undefined is everything. */
  let focus = "";
  let linked;

  const focusOf = async () => {
    const posts = await ctx.call("bus", "read", "debugger-focus");
    for (const post of [...posts].reverse()) {
      try {
        const value = JSON.parse(post.text);
        if (value.in === me) return String(value.focus ?? "");
      } catch {}
    }
    return "";
  };

  const learnFocus = async () => {
    focus = await focusOf();
    linked = focus ? new Set((await ctx.call("reflect", "tabs")).find((t) => t.tab === focus)?.app ?? []) : undefined;
  };

  const ours = (e) => {
    if (!linked) return true;
    if (e.plugin) return linked.has(e.plugin.split("@")[0]);
    return !e.name.startsWith("page:") || e.detail?.startsWith(`tab ${focus}:`);
  };

  const shown = () =>
    events.filter((e) => kinds.has(e.kind) && ours(e) && (!follow || e.trace === follow) && (!search || `${e.name} ${e.plugin ?? ""} ${e.detail ?? ""}`.includes(search)));

  const draw = () => {
    const list = shown();
    const rows = list.slice(-DRAWN).reverse().map((e) => ({
      seq: e.seq,
      time: new Date(startedAt + e.at).toISOString().slice(11, 23),
      kind: e.kind,
      problem: e.kind === "error" || e.kind === "denied" || /^failed/.test(e.detail ?? ""),
      name: e.name,
      plugin: e.plugin ?? "",
      ms: e.ms !== undefined ? `${e.ms} ms` : "",
      detail: (e.detail ?? "").slice(0, 400),
      trace: e.trace ?? "",
    }));
    views.render("events", "events", {
      rows,
      none: !rows.length,
      count: list.length,
      left: Math.max(0, list.length - DRAWN),
      paused,
      pressed: String(paused),
      search,
      follow,
      kinds: KINDS.map((k) => ({ kind: k, label: LABELS[k], on: kinds.has(k), n: events.filter((e) => e.kind === k && ours(e)).length })),
    });
  };

  let timer;
  const soon = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      draw();
    }, 150);
  };

  const take = (batch) => {
    const fresh = batch.filter((e) => e.seq > lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh[fresh.length - 1].seq;
    events = events.concat(fresh).slice(-KEEP);
    if (fresh.some((e) => e.name === "app:open")) void learnFocus().then(soon);
  };

  ctx.on("debug:trace", (batch) => {
    if (paused) return;
    take(batch);
    soon();
  });
  ctx.on("bus:posted", ({ topic }) => topic === "debugger-focus" && learnFocus().then(draw));

  ctx.ui.onEvent((action, value) => {
    if (action === "pause") paused = !paused;
    else if (action === "clear") events = [];
    else if (action === "search") search = String(value ?? "").trim();
    else if (action.startsWith("kind:")) value === true ? kinds.add(action.slice(5)) : kinds.delete(action.slice(5));
    else if (action === "follow") follow = String(value ?? "");
    else return;
    draw();
  });

  const recent = await ctx.call("debug", "recent");
  startedAt = recent.startedAt;
  take(recent.events);
  await learnFocus();
  draw();
}
