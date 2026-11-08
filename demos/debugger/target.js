// Target: which app the debugger looks at. It lists every tab open on this
// site (each one a page talking to the same kernel), with the app it shows
// and how many plugins and workers it has, and lets the person focus on one.
//
// The other panels follow the choice. It is posted on the bus topic
// `debugger-focus` as { in, focus }: `in` is this debugger's own tab, so two
// debuggers open at once each keep their own focus, and `focus` is the tab
// looked at, or "" for everything. Posts stay in this kernel, on this device.
//
// What is open comes from the `reflect` service (`reflect:read`); a tab
// opening or closing shows in the trace (`debug:read`), so the list follows.

export const manifest = {
  id: "debugger-target",
  name: "Debugger: target",
  description: "Lists every open tab and its app, and picks the one the debugger looks at.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "debug:read", "bus:post:debugger-focus", "bus:read:debugger-focus", "hook:listen:bus:posted"],
  scope: "tab",
};

/** Trace events that change what is open: tabs, apps, plugins and workers coming and going. */
const CHANGES = /^(app:open|plugin:|spawner:|host:|tab:)/;

export default async function (ctx) {
  const views = ctx.ui.views("target.html");
  const { tab: me } = await ctx.call("debug", "app");

  /** The tab this debugger looks at, from the latest post for this tab; "" is everything. */
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

  const view = views.live("target", "target", async () => {
    const [snapshot, focus] = await Promise.all([ctx.call("reflect", "snapshot"), focusOf()]);
    const name = (id) => snapshot.plugins.find((p) => p.id === id)?.name ?? id;
    const tabs = snapshot.tabs.map((t) => ({
      tab: t.tab,
      path: `${t.folder ?? "(no app)"}${t.path && t.path !== "/" ? ` → ${t.path}` : ""}`,
      mine: t.tab === me,
      picked: t.tab === focus,
      spawner: t.spawner,
      plugins: (t.app ?? []).map(name).join(", ") || "No app: links no plugins",
      count: (t.app ?? []).length,
      workers: t.workers,
    }));
    const kernel = { mode: snapshot.kernel.mode, plugins: snapshot.plugins.length, workers: snapshot.workers.length, hooks: snapshot.hooks.length, tabs: tabs.length };
    return { tabs, kernel, everything: !focus, focus: tabs.find((t) => t.picked)?.path ?? "" };
  });

  let timer;
  /** Many changes come at once when an app opens: draw once they settle. */
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => view.refresh(), 250);
  };
  ctx.on("debug:trace", (events) => events.some((e) => e.kind === "lifecycle" && CHANGES.test(e.name)) && soon());
  ctx.on("bus:posted", ({ topic }) => topic === "debugger-focus" && view.refresh());

  ctx.ui.onEvent(async (action, value) => {
    if (action === "focus") await ctx.call("bus", "post", "debugger-focus", JSON.stringify({ in: me, focus: String(value ?? "") }));
    else if (action === "refresh") view.refresh();
  });
}
