// Space server: what runs in the kernel on a space's server, for a debugger
// opened in that space (/s/<space>/demos/debugger/app.html). The other
// panels read this device's kernel; a space has a second one, on its server,
// that runs the plugins with `runs: "server"` (public routes, scheduled
// jobs, email) and orders every member's changes. This panel shows that one:
// the plugins it runs, what each was granted, the hooks they listen to and
// the routes they answer, its workers, and which members' devices are
// connected now.
//
// It asks through the space's `sync` service, `sync.reflect(method)`, which
// sends the question over the page's own socket to the space (only members
// can open that socket) and needs `reflect:read` here, as the reflect
// service does (std/spaces/reflect.ts). It only reads. Outside a space it
// says how to get there.

export const manifest = {
  id: "debugger-space",
  name: "Debugger: space server",
  description: "In a space, shows what runs in the kernel on the space's server: its plugins, permissions, hooks, routes, workers and the members connected.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "members"],
  scope: "tab",
};

/** How often it asks the space again while open. */
const EVERY_MS = 15_000;

export default function (ctx) {
  const views = ctx.ui.views("space.html");
  /** The plugin whose code is shown, and its code. */
  let code = null;
  let rev = 0;

  const view = views.live("space", "space", async () => {
    const members = await ctx.call("sync", "members").catch(() => ({ space: null, members: [] }));
    if (!members.space) return { away: true };
    let snapshot;
    try {
      snapshot = await ctx.call("sync", "reflect", "snapshot");
    } catch (error) {
      return { inSpace: true, space: members.space, problem: error instanceof Error ? error.message : String(error) };
    }
    const names = new Map(members.members.map((m) => [m.id, m.name]));
    const plugins = snapshot.plugins
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        off: !p.enabled,
        running: p.instances.length > 0,
        stopped: !p.instances.length,
        server: p.runs === "server",
        granted: p.granted,
        routes: p.routes,
        heard: p.heard.filter((h) => !h.startsWith("route:") && !h.startsWith("command:") && !h.startsWith("schedule:")),
        secrets: p.secrets.map((s) => ({ name: s.name, state: s.set ? "set" : "not set" })),
        showing: code?.id === p.id,
        pressed: String(code?.id === p.id),
        code: code?.id === p.id ? code.text : "",
        rev,
      }));
    // A member's page reaches the space as a device signed in as them; the server's own runner for its
    // plugins' workers is connected too, as no member.
    const devices = snapshot.tabs.map((t) => ({
      tab: t.tab,
      who: t.member ? names.get(t.member) ?? t.member : t.workers ? "The server's plugin runner" : "Not signed in as a member",
      you: !!members.you && t.member === members.you,
      what: t.member ? "a device of theirs" : `${t.workers} workers`,
    }));
    return {
      inSpace: true,
      ok: true,
      space: members.space,
      mode: snapshot.kernel.mode,
      since: new Date(snapshot.kernel.startedAt).toLocaleString(),
      plugins,
      none: !plugins.length,
      count: plugins.length,
      hooks: snapshot.hooks.length,
      workers: snapshot.workers.length,
      devices,
      people: devices.length,
    };
  });

  // A plugin switched off is stopped with its worker, and its timer with it.
  setInterval(() => view.refresh(), EVERY_MS);
  // A change in who is in the space, or in the page's link to it, is worth asking again for.
  ctx.on("members:changed", () => view.refresh());

  ctx.ui.onEvent(async (action) => {
    if (action === "refresh") return view.refresh();
    if (action.startsWith("code:")) {
      const id = action.slice(5);
      code = code?.id === id ? null : { id, text: await ctx.call("sync", "reflect", "source", id).catch((e) => `// ${e instanceof Error ? e.message : e}`) };
      rev++;
      view.refresh();
    }
  });
}
