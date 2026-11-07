// Chapter 3, hooks. Its words are in chapter-3-hooks.html. It has a switch
// for Quiet please, the plugin that stops notes written all in capitals.

export const manifest = {
  id: "chapter-3-hooks",
  name: "Chapter 3: Hooks",
  description: "Explains hooks, with Quiet please as the example and a switch for it.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:manage"],
  scope: "tab",
};

const EXAMPLE = "quiet-please";

export default function (ctx) {
  const views = ctx.ui.views("chapter-3-hooks.html");
  const draw = async () => {
    const example = (await ctx.call("plugins", "app")).find((p) => p.id === EXAMPLE);
    views.render("chapters", "chapter", { on: example?.enabled ?? false }, { order: 3 });
  };
  draw();
  ctx.on("plugins:changed", ({ id }) => id === EXAMPLE && draw());
  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") await ctx.call("plugins", "setEnabled", EXAMPLE, value === true);
  });
}
