// Plugins: every plugin in the app the debugger looks at, and for each one
// everything the kernel knows about it. Its manifest; the permissions it asked
// for, the capabilities the gate holds it to (editor permissions mapped, and
// implied ones such as data:read:x → hearing data:changed:x), and what it
// tried and was refused; the places the person said it may always change;
// which secrets it may use and whether they are set; the hooks it defines and
// the hooks it listens to; its routes and commands; its workers; and its code.
//
// What is installed comes from the `reflect` service (`reflect:read`).
// Refusals come from the trace (`debug:read`): each `denied` event names the
// plugin and the capability it lacked. Which app to look at comes from the bus
// topic `debugger-focus` (see target.js).

export const manifest = {
  id: "debugger-plugins",
  name: "Debugger: plugins",
  description: "Each plugin's manifest, requested and granted permissions, refusals, hooks, workers and code.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "debug:read", "bus:read:debugger-focus", "hook:listen:bus:posted"],
  scope: "tab",
};

/** Trace events that change what is installed or running. */
const CHANGES = /^(app:open|plugin:|spawner:|host:|tab:)/;

export default async function (ctx) {
  const views = ctx.ui.views("plugins.html");
  const { tab: me } = await ctx.call("debug", "app");
  /** Refused capabilities by plugin id: { capability: count }. */
  const refused = new Map();
  /** The plugins opened, and the one whose code is shown, with the code. */
  const open = new Set();
  let code = null;
  let rev = 0;

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

  const hear = (events) => {
    let changed = false;
    for (const e of events) {
      if (e.kind !== "denied" || !e.plugin) continue;
      const id = e.plugin.split("@")[0];
      const counts = refused.get(id) ?? {};
      counts[e.name] = (counts[e.name] ?? 0) + 1;
      refused.set(id, counts);
      changed = true;
    }
    return changed;
  };

  const json = (value) => JSON.stringify(value, null, 2);

  const view = views.live("plugins", "plugins", async () => {
    const [plugins, tabs, focus] = await Promise.all([ctx.call("reflect", "plugins"), ctx.call("reflect", "tabs"), focusOf()]);
    const linked = focus ? new Set(tabs.find((t) => t.tab === focus)?.app ?? []) : undefined;
    const shown = plugins
      .filter((p) => !linked || linked.has(p.id) || p.instances.some((i) => i.tab === focus))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      none: !shown.length,
      count: shown.length,
      plugins: shown.map((p) => {
        const requested = new Set(p.requested);
        const counts = refused.get(p.id) ?? {};
        const m = p.manifest;
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          open: open.has(p.id),
          off: !p.enabled,
          origin: p.origin,
          href: p.href ?? "",
          scope: p.scope,
          runs: p.runs,
          version: p.version ?? "",
          requested: p.requested.map((name) => ({ name, cls: p.granted.includes(name) ? "" : "mapped" })),
          // Granted but not asked for by name: an editor permission's mapping, or implied by another.
          implied: p.granted.filter((c) => !requested.has(c)),
          refused: Object.entries(counts).map(([name, n]) => ({ name, n })),
          refusals: Object.values(counts).reduce((a, b) => a + b, 0),
          problem: Object.keys(counts).length > 0,
          always: p.always,
          secrets: p.secrets.map((s) => ({ name: s.name, state: s.set ? "set" : "not set", cls: s.set ? "" : "bad" })),
          defines: p.defines,
          heard: p.heard.filter((h) => !h.startsWith("route:") && !h.startsWith("command:")),
          routes: p.routes,
          commands: p.commands,
          collections: Object.keys(m.collections ?? {}),
          places: Object.keys(m.places ?? {}),
          settings: Object.keys(m.settings ?? {}),
          instances: p.instances.map((i) => ({ instance: i.instance, where: i.tab ? `for tab ${i.tab}` : "shared by every tab", runsIn: i.runsIn, hooks: i.heard.length })),
          stopped: !p.instances.length,
          manifest: json(m),
          code: code?.id === p.id ? code.text : "",
          showing: code?.id === p.id,
          rev,
        };
      }),
    };
  });

  let timer;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => view.refresh(), 250);
  };

  const recent = await ctx.call("debug", "recent");
  hear(recent.events);
  ctx.on("debug:trace", (events) => {
    if (hear(events) || events.some((e) => e.kind === "lifecycle" && CHANGES.test(e.name))) soon();
  });
  ctx.on("bus:posted", ({ topic }) => topic === "debugger-focus" && view.refresh());

  ctx.ui.onEvent(async (action, value) => {
    const [verb, id] = [action.split(":")[0], action.slice(action.indexOf(":") + 1)];
    if (verb === "toggle") open.has(id) ? open.delete(id) : open.add(id);
    else if (verb === "code") code = code?.id === id ? null : { id, text: await ctx.call("reflect", "source", id) };
    else if (verb === "forget") refused.delete(id);
    else return;
    rev++;
    view.refresh();
  });
}
