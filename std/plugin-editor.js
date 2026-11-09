// Plugin editor: write a plugin, or change a copy of one on the page, and
// see what it asks for and what it does.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/plugin-editor.js">
//   <slot name="editor"></slot>
//
// It starts from a template in plugin-editor.templates/, or from the code of
// a plugin the app links (the `authoring` service reads both, and needs
// `plugins:author`). Before anything runs, it shows the draft's manifest the
// way the kernel reads it, and says in plain words what each permission lets
// the plugin do. Once the draft runs, its logs, errors and refused
// permissions come from the kernel's trace (`debug:read`).
//
// Save and run keeps the draft as one of the person's own plugins for this
// app, and turns it on, after they accept a review card that shows its code
// and what it asks for. A copy of one of the page's plugins gets an id of
// its own, so it runs beside the original: switch the original off on the
// switchboard to try yours instead, and Remove yours to go back.

export const manifest = {
  id: "plugin-editor",
  name: "Plugin editor",
  description: "Write a plugin, or change a copy of one on the page, and see what it asks for before it runs.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:author", "debug:read"],
  // Its tab says which app it is editing.
  scope: "tab",
  // On an app with no slot for it (added from the registry), it draws at the end of the page's main part.
  places: { editor: { at: "main", put: "append" } },
  // Copied with it when a person adds it to an app: its view, and the starting templates in the folder beside it.
  files: ["plugin-editor.html", "plugin-editor.templates/card.js", "plugin-editor.templates/listen.js", "plugin-editor.templates/block.js", "plugin-editor.templates/button.js"],
};

/** The starting templates: files next to this one. */
const TEMPLATES = [
  { file: "card.js", label: "Template: show a card on the page" },
  { file: "listen.js", label: "Template: show the latest note as it's written" },
  { file: "block.js", label: "Template: stop notes that use a word you pick" },
  { file: "button.js", label: "Template: a button that stars every note" },
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
  /** What the last save or removal said. */
  let status = "";
  /** True while a save or removal waits for the person's answer: the buttons are off, so it is asked once. */
  let waiting = false;

  /** The person's own plugins here; the rest of the app's plugins can only be copied. */
  const mine = () => ctx.call("authoring", "mine");
  const isOwn = async () => check.ok && (await mine()).some((p) => p.id === check.manifest.id);

  const startingPoints = async () => {
    const own = await mine();
    const ids = new Set(own.map((p) => p.id));
    return [
      ...own.map((p) => ({ value: `own:${p.id}`, label: `Yours: ${p.name}` })),
      ...TEMPLATES.map((t) => ({ value: `template:${t.file}`, label: t.label })),
      ...(await ctx.call("plugins", "app"))
        .filter((p) => p.id !== manifest.id && !ids.has(p.id))
        .map((p) => ({ value: `plugin:${p.id}`, label: `Copy of ${p.name}` })),
    ];
  };

  const draw = async () => {
    views.render("editor", "editor", { rev, code, from, status, waiting, own: await isOwn(), starts: await startingPoints() }, { order: 10 });
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
      code = await ctx.call("authoring", "file", `plugin-editor.templates/${name}`);
      from = TEMPLATES.find((t) => t.file === name)?.label ?? name;
    } else if (kind === "plugin") {
      // The kernel gives the copy an id and name of its own, and points its templates at the original's.
      const copy = await ctx.call("authoring", "copy", name);
      code = copy.code;
      from = `Copy of ${copy.name.replace(/ \(copy\)$/, "")}`;
    } else if (kind === "own") {
      const source = await ctx.call("authoring", "source", name);
      code = source.code;
      from = `Yours: ${source.name}`;
    } else return;
    rev++;
    status = "";
    await recheck();
    await draw();
  };

  /** One trace event as a line: what kind, what, and what happened. */
  const line = (e) => ({ key: String(e.seq), kind: e.kind, text: [e.kind, e.name, e.detail ?? ""].filter(Boolean).join("  ") });
  const fromDraft = (e) => check.ok && !!e.plugin && e.plugin.split("@")[0] === check.manifest.id;

  ctx.on("debug:trace", (events) => {
    const heard = events.filter(fromDraft);
    if (!heard.length) return;
    trace = [...trace, ...heard.map(line)].slice(-LINES);
    views.render("editor", "trace", { trace }, { order: 30 });
  });
  ctx.on("plugins:changed", draw);

  ctx.ui.onEvent(async (action, value) => {
    if (waiting) return;
    if (action === "start" && typeof value === "string" && value) await start(value);
    if (action === "check" || action === "save") {
      code = String(value?.code ?? "");
      await recheck();
      status = "";
      if (action === "save" && check.ok) {
        status = "Waiting for your answer on the review card at the bottom of the screen.";
        waiting = true;
        await draw();
        const saved = await ctx.call("authoring", "save", code).finally(() => (waiting = false));
        status = saved.ok ? `Saved, and ${check.manifest.name} is on. It's listed on the switchboard with the rest.` : saved.error;
      }
      await draw();
    }
    if (action === "remove" && check.ok) {
      status = "Waiting for your answer on the review card at the bottom of the screen.";
      waiting = true;
      await draw();
      const removed = await ctx.call("authoring", "remove", check.manifest.id).finally(() => (waiting = false));
      status = removed.ok ? `${check.manifest.name} is removed. Its code is still here, if you want to save it again.` : removed.error;
      await draw();
    }
  });

  await draw();
}
