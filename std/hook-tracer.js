// Hook tracer: what happened, step by step, after you did something on the
// page. Each action (a note written, a plugin switched) is one group: who
// started it, each hook it ran, and what every plugin listening said.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/hook-tracer.js">
//   <slot name="inspect"></slot>
//
// It reads the kernel's trace (`debug:read`), which already ties every event
// of an action together with one trace id: the hook dispatches, each answer
// from a plugin that can change or stop it, and the service call that began
// it. Plugins that only hear a hook (emit) don't answer, so it names them from
// the kernel's reference, which says which hooks each plugin listens to.
// It shows only the actions that touch this app's plugins.

export const manifest = {
  id: "hook-tracer",
  name: "Hook tracer",
  description: "Shows each hook an action runs, in order, and what every plugin listening said.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "debug:read"],
  // Its tab says which app's plugins to follow.
  scope: "tab",
  // Where it draws on a page with no <slot name="inspect">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "inspect": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["hook-tracer.html"],
};

/** How many actions it shows, newest first. */
const KEEP = 8;

/** The most events it keeps for one action. */
const EVENTS = 200;

/** The hook modes, in words. */
const MODES = {
  emit: "tells everyone listening; nobody can stop it",
  serial: "asks each listener in turn; any one can stop it",
  parallel: "asks every listener at once",
  bail: "asks each listener in turn, until one answers",
  waterfall: "passes it through each listener, which can change it",
};

export default function (ctx) {
  const views = ctx.ui.views("hook-tracer.html");
  /** Events by trace id, in the order they arrived. */
  const groups = new Map();
  /** The app's plugins by id, and the hooks each one hears. */
  let names = new Map();
  let hears = new Map();
  let paused = false;

  const base = (instance) => (instance ?? "").split("@")[0];
  const nameOf = (instance) => names.get(base(instance)) ?? base(instance);
  const ours = (e) => !!e.plugin && names.has(base(e.plugin));

  const learn = async () => {
    const plugins = await ctx.call("plugins", "app");
    names = new Map(plugins.map((p) => [p.id, p.name]));
    const reference = await ctx.call("kernel", "reference");
    hears = new Map(reference.plugins.filter((p) => names.has(p.id) && p.enabled).map((p) => [p.id, p.hooks]));
  };

  /** The app's plugins that hear a hook now. */
  const listenersOf = (hook) => [...hears].filter(([, heard]) => heard.includes(hook)).map(([id]) => names.get(id) ?? id);

  /** One action, as the view draws it. */
  const shape = ([trace, events]) => {
    // The call that started it began before its first hook ran. Calls are traced when they end, and
    // listeners can make calls of their own in the same action, so it's the one that began first.
    const first = events.find((e) => e.kind === "dispatch");
    const began = (e) => e.at - (e.ms ?? 0);
    const call = events.filter((e) => e.kind === "call" && ours(e) && began(e) <= first.at).sort((a, b) => began(a) - began(b))[0];
    // An answer belongs to the latest dispatch of its hook before it: one action can run a hook twice.
    const dispatchOf = (answer) => events.findLast((e) => e.kind === "dispatch" && e.name === answer.name && e.seq < answer.seq);
    const steps = events
      .filter((e) => e.kind === "dispatch")
      .map((d, i) => {
        const answers = events
          .filter((e) => e.kind === "remote" && ours(e) && dispatchOf(e) === d)
          .map((e, j) => ({ key: `${e.seq}`, who: nameOf(e.plugin), said: said(e.detail), ms: e.ms ?? 0, tone: /"block"/.test(e.detail ?? "") ? "stopped" : /^failed/.test(e.detail ?? "") ? "failed" : "" }));
        const listeners = d.listeners ?? [];
        return { key: `${d.seq}`, n: i + 1, hook: d.name, mode: d.detail ?? "", means: MODES[d.detail] ?? "", answers, listeners: listeners.join(", "), quiet: !answers.length && !listeners.length };
      });
    const started = call ? `${nameOf(call.plugin)} called ${call.name}` : "The kernel started it";
    return { key: trace, started, steps };
  };

  /** What a plugin's answer means, in words. */
  const said = (detail = "") => {
    if (detail === "passed") return "let it through";
    if (detail.startsWith("failed")) return detail;
    const block = /"block":"([^"]*)"/.exec(detail);
    return block ? `stopped it: ${block[1]}` : `answered ${detail}`;
  };

  const draw = () => {
    const actions = [...groups].filter(([, events]) => events.some((e) => e.kind === "dispatch") && events.some(ours)).slice(-KEEP).reverse().map(shape);
    views.render("inspect", "tracer", { actions, paused, none: !actions.length }, { order: 20 });
  };

  const hear = (events) => {
    if (paused) return;
    let changed = false;
    for (const e of events) {
      if (!e.trace) continue;
      if (!groups.has(e.trace)) groups.set(e.trace, []);
      const group = groups.get(e.trace);
      // Who heard an emit is noted when it ran, so switching a plugin later doesn't rewrite what happened.
      group.push(e.kind === "dispatch" && e.detail === "emit" ? { ...e, listeners: listenersOf(e.name) } : e);
      // A long action keeps only its newest events.
      if (group.length > EVENTS) group.splice(0, group.length - EVENTS);
      changed = true;
    }
    // Only the newest actions are kept: the oldest go first.
    while (groups.size > KEEP * 4) groups.delete(groups.keys().next().value);
    if (changed) draw();
  };

  learn().then(draw);
  ctx.on("debug:trace", hear);
  ctx.on("plugins:changed", () => learn().then(draw));
  ctx.ui.onEvent((action) => {
    if (action === "clear") groups.clear();
    if (action === "pause") paused = !paused;
    draw();
  });
}
