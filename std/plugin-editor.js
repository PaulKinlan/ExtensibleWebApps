// Plugin editor: write a plugin, or change a copy of one on the page, and
// see what it asks for and what it does.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/plugin-editor.js">
//   <slot name="editor"></slot>
//
// It starts from a template in plugin-editor/templates/, or from the code of
// a plugin the app links (the `authoring` service reads both, and needs
// `plugins:author`). Before anything runs, it shows the draft's manifest the
// way the kernel reads it, and says in plain words what each permission lets
// the plugin do. Once the draft runs, its logs, errors and refused
// permissions come from the kernel's trace (`debug:read`).

export const manifest = {
  id: "plugin-editor",
  name: "Plugin editor",
  description: "Write a plugin, or change a copy of one on the page, and see what it asks for before it runs.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:author", "debug:read"],
  // Its tab says which app it is editing.
  scope: "tab",
};

/** The starting templates: files next to this one. */
const TEMPLATES = [
  { file: "card.js", label: "Template: a card on the page" },
  { file: "listen.js", label: "Template: react to new notes" },
  { file: "block.js", label: "Template: block certain notes" },
  { file: "button.js", label: "Template: a button that changes notes" },
];

/** How many of the draft's trace lines it shows. */
const LINES = 50;

export default async function (ctx) {
  const views = ctx.ui.views("plugin-editor.html");
  let rev = 0;
  let code = "";
  let from = "Pick a starting point";
  let check = { ok: false, error: "Pick a starting point, or write a plugin here." };
  /** The draft's own trace lines, oldest first. */
  let trace = [];

  const startingPoints = async () => [
    ...TEMPLATES.map((t) => ({ value: `template:${t.file}`, label: t.label })),
    ...(await ctx.call("plugins", "app"))
      .filter((p) => p.id !== manifest.id)
      .map((p) => ({ value: `plugin:${p.id}`, label: `Copy of ${p.name}` })),
  ];

  const draw = async () => {
    views.render("editor", "editor", { rev, code, from, starts: await startingPoints() }, { order: 10 });
    views.render("editor", "asks", { check }, { order: 20 });
    views.render("editor", "trace", { trace }, { order: 30 });
  };

  const recheck = async () => {
    check = await ctx.call("authoring", "check", code);
    trace = [];
  };

  /** Loads a starting point into the editor, replacing what is there. */
  const start = async (value) => {
    const [kind, name] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
    if (kind === "template") {
      code = await ctx.call("authoring", "file", `plugin-editor/templates/${name}`);
      from = TEMPLATES.find((t) => t.file === name)?.label ?? name;
    } else if (kind === "plugin") {
      const source = await ctx.call("authoring", "source", name);
      code = source.code;
      from = `Copy of ${source.name}`;
    } else return;
    rev++;
    await recheck();
    await draw();
  };

  /** One trace event as a line: what kind, what, and what happened. */
  const line = (e) => ({ key: String(e.seq), kind: e.kind, text: [e.kind, e.name, e.detail ?? ""].filter(Boolean).join("  ") });
  const mine = (e) => check.ok && !!e.plugin && e.plugin.split("@")[0] === check.manifest.id;

  ctx.on("debug:trace", (events) => {
    const heard = events.filter(mine);
    if (!heard.length) return;
    trace = [...trace, ...heard.map(line)].slice(-LINES);
    views.render("editor", "trace", { trace }, { order: 30 });
  });
  ctx.on("plugins:changed", draw);

  ctx.ui.onEvent(async (action, value) => {
    if (action === "start" && typeof value === "string" && value) await start(value);
    if (action === "check") {
      code = String(value?.code ?? "");
      await recheck();
      await draw();
    }
  });

  await draw();
}
