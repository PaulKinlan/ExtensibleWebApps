// Switchboard: a switch for each plugin the app links, so the person can see
// what the page is made of and turn any part of it off and on again.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/switchboard.js">
//   <slot name="switchboard"></slot>
//
// It lists the plugins through the `plugins` service (`plugins:read`) and
// switches them with `plugins:manage`, which only reaches plugins in its own
// app. It hears `plugins:changed`, so a plugin switched anywhere else (the
// workbench, another tab, a chapter's own switch) shows here at once.
// Switching off the switchboard itself is allowed; ?reset brings it back.

export const manifest = {
  id: "switchboard",
  name: "Switchboard",
  description: "A switch for each plugin on the page.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:manage"],
  // Its tab says which app it's in.
  scope: "tab",
  // Where it draws on a page with no <slot name="switchboard">, such as a person adding it to any app from the
  // registry (packages/std.json); a page with the slot keeps it there.
  places: { "switchboard": { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app.
  files: ["switchboard.html"],
};

export default function (ctx) {
  const views = ctx.ui.views("switchboard.html");
  const draw = async () => {
    const plugins = await ctx.call("plugins", "app");
    views.render("switchboard", "switches", { plugins, on: plugins.filter((p) => p.enabled).length, all: plugins.length }, { order: 10 });
  };
  draw();
  ctx.on("plugins:changed", draw);
  // "switch:<id>" comes from each plugin's checkbox, with true or false.
  ctx.ui.onEvent(async (action, value) => {
    if (action.startsWith("switch:")) await ctx.call("plugins", "setEnabled", action.slice(7), value === true);
  });
}
