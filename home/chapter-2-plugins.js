// Chapter 2, everything is a plugin. Its words are in
// chapter-2-plugins.html. It shows Note stats' manifest, and a switch for
// it that says whether it's on: it hears `plugins:changed` when that
// changes, from here or from the switchboard.

export const manifest = {
  id: "chapter-2-plugins",
  name: "Chapter 2: Everything is a plugin",
  description: "Explains what a plugin is, with Note stats as the example and a switch for it.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:manage"],
  scope: "tab",
};

const EXAMPLE = "note-stats";

export default function (ctx) {
  const views = ctx.ui.views("chapter-2-plugins.html");
  const draw = async () => {
    const example = (await ctx.call("plugins", "app")).find((p) => p.id === EXAMPLE);
    views.render("chapters", "chapter", { on: example?.enabled ?? false }, { order: 2 });
  };
  draw();
  // Its plugin was switched, or this tab's app finished opening (before that, the list is empty).
  ctx.on("plugins:changed", ({ change, id }) => (id === EXAMPLE || change === "open") && draw());
  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") await ctx.call("plugins", "setEnabled", EXAMPLE, value === true);
  });
}
