// View source: every plugin on the page, and for the one you pick, what it
// may do and its code. Plugins are plain files, so there is nothing hidden
// to show: this makes it easy to look.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/view-source.js">
//   <slot name="inspect"></slot>
//
// It lists the app's plugins (`plugins:read`, from the `plugins` service),
// and reads a plugin's code and what its permissions mean from the
// `authoring` service, which needs only `plugins:read` for that. It can't
// change anything.

export const manifest = {
  id: "view-source",
  name: "View source",
  description: "Shows the code of every plugin on the page, and what each one may do.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read"],
  // Its tab says which app it is showing.
  scope: "tab",
  // Where it draws on a page with no <slot name="inspect">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "inspect": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["view-source.html"],
};

export default function (ctx) {
  const views = ctx.ui.views("view-source.html");
  /** The plugin being shown, and what was read about it. */
  let picked = "";
  let shown = null;
  /** Counts reads, so the code box shows each read afresh. */
  let rev = 0;

  const draw = async () => {
    const plugins = (await ctx.call("plugins", "app")).map((p) => ({ ...p, picked: p.id === picked }));
    views.render("inspect", "source", { plugins, shown }, { order: 10 });
  };

  /** Counts picks and closes: a read that finishes after a newer one began is dropped. */
  let generation = 0;

  const show = async (id) => {
    picked = id;
    const mine = ++generation;
    const source = await ctx.call("authoring", "source", id);
    const check = await ctx.call("authoring", "check", source.code);
    const plugin = (await ctx.call("plugins", "app")).find((p) => p.id === id);
    if (mine !== generation) return;
    shown = {
      id,
      name: source.name,
      description: plugin?.description ?? "",
      enabled: plugin?.enabled ?? false,
      code: source.code,
      rev: ++rev,
      permissions: check.ok ? check.permissions : [],
    };
    await draw();
  };

  draw();
  ctx.on("plugins:changed", async ({ id, change }) => {
    // The plugin being shown may have changed (saved again from the editor): show it as it is now.
    if (id === picked && change !== "uninstall") await show(picked).catch(() => {});
    else await draw();
  });
  ctx.ui.onEvent(async (action) => {
    if (action.startsWith("show:")) await show(action.slice(5));
    if (action === "hide") {
      picked = "";
      shown = null;
      generation++;
      await draw();
    }
  });
}
