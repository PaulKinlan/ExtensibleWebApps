// Hooks: every hook in the kernel, who defines it and who listens. A hook is
// the kernel's own, a plugin's (named `<plugin>:<key>`, from its manifest's
// `hooks`), or a collection's (`data:changed:<c>`, `data:beforeWrite:<c>`,
// owned by the plugin that owns the collection). For each: its mode (does it
// only tell, or can a listener change or stop the action?), its time limit,
// the capability listening needs, the plugins listening now, and how often it
// fired since the debugger opened. A plugin can listen to a hook before the
// plugin that defines it is installed: that listener is shown as waiting.
//
// The hooks come from the `reflect` service (`reflect:read`); firing counts
// from the trace (`debug:read`), where every dispatch is a `dispatch` event.
// Focused on one tab (target.js), it shows the hooks that tab's app's plugins
// define or listen to.

export const manifest = {
  id: "debugger-hooks",
  name: "Debugger: hooks",
  description: "Every hook: who defines it, its mode and limits, who listens, and how often it fired.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "debug:read", "bus:read:debugger-focus", "hook:listen:bus:posted"],
  scope: "tab",
};

const CHANGES = /^(app:open|plugin:|spawner:|host:|tab:)/;

/** What each mode means for a listener. */
const MEANS = {
  emit: "tells listeners; nothing comes back",
  parallel: "tells every listener at once",
  serial: "asks each in turn; any can stop it",
  bail: "asks each in turn; the first answer wins",
  waterfall: "each listener can change the value",
};

export default async function (ctx) {
  const views = ctx.ui.views("hooks.html");
  const { tab: me } = await ctx.call("debug", "app");
  /** Dispatches seen, by hook: { n, last }. */
  const fired = new Map();
  let startedAt = Date.now();
  let search = "";
  let kind = "all";
  let onlyHeard = false;

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
      if (e.kind !== "dispatch") continue;
      const f = fired.get(e.name) ?? { n: 0, last: 0 };
      fired.set(e.name, { n: f.n + 1, last: e.at });
      changed = true;
    }
    return changed;
  };

  const view = views.live("hooks", "hooks", async () => {
    const [hooks, plugins, tabs, focus] = await Promise.all([ctx.call("reflect", "hooks"), ctx.call("reflect", "plugins"), ctx.call("reflect", "tabs"), focusOf()]);
    const names = new Map(plugins.map((p) => [p.id, p.name]));
    const linked = focus ? new Set(tabs.find((t) => t.tab === focus)?.app ?? []) : undefined;
    const base = (instance) => instance.split("@")[0];
    const ours = (h) => !linked || (h.owner && linked.has(h.owner)) || h.listeners.some((l) => linked.has(base(l)));
    const shown = hooks.filter((h) => ours(h) && (kind === "all" || h.kind === kind) && (!onlyHeard || h.listeners.length) && (!search || h.name.includes(search)));
    return {
      search,
      kindIs: { [kind]: true },
      onlyHeard,
      count: shown.length,
      total: hooks.length,
      none: !shown.length,
      hooks: shown.map((h) => {
        const f = fired.get(h.name);
        return {
          name: h.name,
          kind: h.kind,
          tone: h.kind === "kernel" ? "" : h.kind === "plugin" ? "accent" : "ok",
          owner: h.owner ? names.get(h.owner) ?? h.owner : h.kind === "kernel" ? "the kernel" : "nobody yet",
          waiting: !h.defined,
          mode: h.mode ?? "?",
          means: MEANS[h.mode] ?? "not defined yet: its plugin isn't installed",
          limit: h.timeoutMs ? `${h.timeoutMs} ms each, fails ${h.onFailure ?? "open"}` : "",
          agent: h.agentTimeoutMs ? `${h.agentTimeoutMs / 1000} s for an agent` : "",
          listen: h.listen,
          args: h.args ?? "",
          description: h.description ?? "",
          listeners: [...new Set(h.listeners.map((l) => names.get(base(l)) ?? base(l)))].join(", "),
          heard: h.listeners.length,
          inKernel: h.inKernel,
          fired: f?.n ?? 0,
          last: f ? new Date(startedAt + f.last).toLocaleTimeString() : "",
        };
      }),
    };
  });

  let timer;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => view.refresh(), 400);
  };

  const recent = await ctx.call("debug", "recent");
  startedAt = recent.startedAt;
  hear(recent.events);
  ctx.on("debug:trace", (events) => {
    if (hear(events) || events.some((e) => e.kind === "lifecycle" && CHANGES.test(e.name))) soon();
  });
  ctx.on("bus:posted", ({ topic }) => topic === "debugger-focus" && view.refresh());

  ctx.ui.onEvent((action, value) => {
    if (action === "search") search = String(value ?? "").trim();
    else if (action === "kind") kind = String(value);
    else if (action === "only-heard") onlyHeard = value === true;
    else if (action === "reset-counts") fired.clear();
    else return;
    view.refresh();
  });
}
