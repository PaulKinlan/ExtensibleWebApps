// Workers: every plugin worker running, by the tab that started it. Each
// plugin instance is a dedicated worker. A shared plugin has one, started by
// the spawner tab (the oldest open tab) and used by every tab; a tab-scoped
// plugin has one per tab whose app links it. Close the spawner tab and the
// shared workers move to the next tab: this panel shows them move.
//
// From the `reflect` service (`reflect:read`); a worker starting or stopping
// is a lifecycle event in the trace (`debug:read`), which redraws it.

export const manifest = {
  id: "debugger-workers",
  name: "Debugger: workers",
  description: "Every plugin worker running, grouped by the tab that started it.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "debug:read", "bus:read:debugger-focus", "hook:listen:bus:posted"],
  scope: "tab",
};

const CHANGES = /^(app:open|plugin:|spawner:|host:|tab:)/;

export default async function (ctx) {
  const views = ctx.ui.views("workers.html");
  const { tab: me } = await ctx.call("debug", "app");

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

  const view = views.live("workers", "workers", async () => {
    const [snapshot, focus] = await Promise.all([ctx.call("reflect", "snapshot"), focusOf()]);
    const names = new Map(snapshot.plugins.map((p) => [p.id, p.name]));
    const linked = focus ? new Set(snapshot.tabs.find((t) => t.tab === focus)?.app ?? []) : undefined;
    // A shared worker serves every tab; a tab-scoped one serves only its own, so only the focused tab's count.
    const workers = snapshot.workers.filter((w) => !linked || (w.tab ? w.tab === focus : linked.has(w.plugin)));
    const tabs = snapshot.tabs
      .map((t) => ({
        tab: t.tab,
        path: `${t.folder ?? "(no app)"}${t.path && t.path !== "/" ? ` → ${t.path}` : ""}`,
        spawner: t.spawner,
        mine: t.tab === me,
        workers: workers
          .filter((w) => w.runsIn === t.tab)
          .sort((a, b) => a.instance.localeCompare(b.instance))
          .map((w) => ({ instance: w.instance, name: names.get(w.plugin) ?? w.plugin, shared: w.scope !== "tab", hooks: w.hooks === 1 ? "1 hook" : `${w.hooks} hooks` })),
      }))
      .filter((t) => t.workers.length || !linked);
    return { tabs, count: workers.length, none: !workers.length };
  });

  let timer;
  ctx.on("debug:trace", (events) => {
    if (!events.some((e) => e.kind === "lifecycle" && CHANGES.test(e.name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => view.refresh(), 250);
  });
  ctx.on("bus:posted", ({ topic }) => topic === "debugger-focus" && view.refresh());
}
