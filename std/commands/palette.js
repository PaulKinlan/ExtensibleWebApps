// The command palette: everything the app's plugins can do, in one list to
// search, with the keyboard shortcuts that run each thing from anywhere on
// the page. Cmd K on a Mac, Ctrl K elsewhere (or the button) opens it.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/commands/palette.js">
//   <slot name="commands"></slot>
//
// The palette knows no commands of its own. Each plugin adds the things it
// does with ctx.commands.add, and they show up here:
//
//   ctx.commands.add({ id: 'finish', title: 'Mark what I\'m reading as done', keys: ['Alt+D'] }, async () => { … });
//
// It lists them with the `commands` service and runs the one picked, which
// needs the `commands` permission; the command runs with its own plugin's
// rights. It hears `commands:changed`, so a command added or removed (or a
// plugin switched off) shows at once. Commands that need arguments are left
// out: only something that can fill them in, such as an agent, runs those.
// The list, the search and the keys are the <ui-commands> element.

export const manifest = {
  id: "command-palette",
  name: "Command palette",
  description: "Search everything the app can do, and run it, or press its shortcut.",
  version: "1.0.0",
  permissions: ["ui", "commands"],
  // One per tab: the palette and the keys belong to the page they're on.
  scope: "tab",
  settings: {
    openKeys: { type: "string", title: "Shortcut that opens it", default: "Mod+K" },
    button: { type: "boolean", title: "Show a button to open it", default: true },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("palette.html");
  let commands = [];
  let settings = await ctx.settings.get();
  /** What happened to the last command run, shown briefly; `at` makes the element show it again. */
  let message = { text: "", at: 0 };

  const draw = () =>
    views.render("commands", "palette", {
      commands,
      openKeys: String(settings.openKeys || "Mod+K"),
      hidden: settings.button === false,
      message,
    });

  const refresh = async () => {
    const all = await ctx.call("commands", "list");
    // A command whose arguments are required can't be run from a list, so it isn't shown.
    commands = all
      .filter((c) => !c.args?.required?.length)
      .map((c) => ({ name: c.name, title: c.title, group: c.group ?? "", description: c.description ?? "", keys: JSON.stringify(c.keys ?? []) }));
    draw();
  };

  // The element sends "run" with the command's name, from a pick or its keys.
  ctx.ui.onEvent(async function (action, value) {
    if (action !== "run") return;
    // `this` keeps the trace of the key press, so the run is traced with it.
    const traced = this ?? ctx;
    try {
      const answer = await traced.call("commands", "run", String(value));
      // A command may answer with a sentence for the person.
      if (typeof answer === "string" && answer) message = { text: answer, at: Date.now() };
      else return;
    } catch (error) {
      message = { text: error instanceof Error ? error.message : String(error), at: Date.now() };
    }
    draw();
  });
  ctx.on("commands:changed", refresh);
  ctx.settings.onChange((values) => {
    settings = values;
    draw();
  });
  await refresh();
}
