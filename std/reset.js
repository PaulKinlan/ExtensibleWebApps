// Reset: turns every plugin in the app back on. On a page that invites the
// person to switch things off and change them, this is the way back.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/reset.js">
//   <slot name="switchboard"></slot>
//
// It only offers itself when something is off. It is a plugin like any
// other, so it can be switched off too; then the page's address with ?reset
// does the same job, since the host handles that before any plugin runs.
// It leaves the person's data alone.

export const manifest = {
  id: "reset",
  name: "Reset",
  description: "Turns every plugin on the page back on.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:manage"],
  scope: "tab",
};

export default function (ctx) {
  const views = ctx.ui.views("reset.html");
  const draw = async () => {
    const off = (await ctx.call("plugins", "app")).filter((p) => !p.enabled);
    // Nothing to undo, nothing to show.
    if (off.length) views.render("switchboard", "reset", { off: off.map((p) => p.name) }, { order: 20 });
    else ctx.ui.render("switchboard", "reset", null);
  };
  draw();
  ctx.on("plugins:changed", draw);
  ctx.ui.onEvent(async (action) => {
    if (action !== "reset") return;
    for (const p of await ctx.call("plugins", "app")) if (!p.enabled) await ctx.call("plugins", "setEnabled", p.id, true);
  });
}
