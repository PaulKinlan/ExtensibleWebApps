// Your apps: where a person makes an app by describing it, and keeps the
// apps they made. It sends what they write to the app maker
// (app-maker.agent.md) and shows what it is doing; lists the apps they made,
// each a working app at /apps/<name>/; shows the one picked running, in a
// preview (<ui-preview>); and lists each of its files with its earlier
// versions, any of which can be put back, after a review.
//
// Add it to a page beside the app maker and a model (std/llm/):
//
//   <link rel="agent" href="/std/maker/app-maker.agent.md">
//   <link rel="plugin" href="/std/maker/your-apps.js">
//   <slot name="make"></slot> <slot name="apps"></slot>
//
// Without a model it still lists, previews and restores the apps already
// made: they are plain files, and none of them needs the model to run.

export const manifest = {
  id: "your-apps",
  name: "Your apps",
  description: "Describe an app to make it, or a change to one you made; see each app running, and go back to an earlier version of any file.",
  version: "1.0.0",
  permissions: ["ui", "apps:read", "apps:make", "bus:send:app-maker", "hook:listen:agent:toolResult"],
  services: ["maker", "bus"],
  // Each tab has its own preview and conversation.
  scope: "tab",
};

/** What the app maker's tools are called, in words for the steps list. */
const STEPS = { maker_list: "Looked at your apps", maker_read: "Read a file", maker_save: "Saved files", maker_check: "Checked the app", maker_history: "Looked at a file's history", bus_ask: "Asked you something" };

export default function (ctx) {
  const views = ctx.ui.views("your-apps.html");
  let apps = [];
  /** The app being shown, its files with their versions, and the file whose history is open. */
  let picked = "";
  let files = [];
  let open = "";
  let revision = 0;
  /** What the app maker is doing: the request, its steps, its answer. */
  let working = false;
  let request = "";
  let steps = [];
  let answer = null;
  let target = "";

  const draw = () => {
    const app = apps.find((a) => a.name === picked);
    views.render("make", "make", {
      working,
      request,
      steps,
      answer,
      targets: [{ name: "", title: "A new app", picked: !target }, ...apps.map((a) => ({ name: a.name, title: `Change ${a.title}`, picked: a.name === target }))],
    });
    views.render("apps", "apps", {
      none: !apps.length,
      apps: apps.map((a) => ({ ...a, picked: a.name === picked })),
      app: app ? { ...app, revision } : null,
      files: files.map((f) => ({ ...f, open: f.name === open, versions: f.versions.map((v) => ({ ...v, when: new Date(v.at).toLocaleString(), current: v.version === f.latest })) })),
    });
  };

  const load = async () => {
    apps = await ctx.call("maker", "list").catch(() => []);
    if (picked && !apps.some((a) => a.name === picked)) picked = "";
    if (!picked && apps.length) picked = apps[0].name;
    await loadFiles();
    draw();
  };
  const loadFiles = async () => {
    const app = apps.find((a) => a.name === picked);
    files = [];
    for (const name of app?.files ?? []) {
      const versions = (await ctx.call("maker", "history", picked, name).catch(() => [])).slice().reverse();
      files.push({ name, versions, latest: versions[0]?.version ?? 0, count: versions.length });
    }
  };

  const make = async (text, app) => {
    const message = String(text ?? "").trim().slice(0, 4000);
    if (!message || working) return;
    request = message;
    target = app ?? "";
    steps = [];
    answer = null;
    working = true;
    draw();
    try {
      const said = target ? `Change my app "${target}" (/apps/${target}/): ${message}` : `Make me an app: ${message}`;
      const reply = await ctx.call("bus", "send", "app-maker", { text: said }, { reply: true });
      const stopped = reply.stopReason !== "completed";
      answer = { text: reply.text || (stopped ? `It stopped (${reply.stopReason}).` : "Done."), tone: stopped ? "warn" : "ok" };
    } catch (error) {
      answer = { text: error instanceof Error ? error.message : String(error), tone: "danger" };
    }
    working = false;
    await load();
  };

  // Opens the preview again. A save and the check after it come close together: they open it once.
  let soon;
  const reload = () => {
    clearTimeout(soon);
    soon = setTimeout(() => {
      revision++;
      draw();
    }, 300);
  };

  ctx.on("agent:toolResult", ({ agent, tool, ok }) => {
    if (agent !== "app-maker" || !working) return;
    steps = [...steps, { n: steps.length + 1, text: STEPS[tool] ?? tool, ok }];
    draw();
  });
  // A save shows at once: the list, the file versions, and the preview opened again.
  ctx.on("maker:changed", async ({ app }) => {
    if (!picked || app === picked || !apps.some((a) => a.name === app)) picked = app;
    await load();
    reload();
  });
  // The app maker checks the app as it runs: open it (again) in the preview.
  ctx.on("maker:check", async ({ app }) => {
    if (picked !== app) {
      picked = app;
      await load();
    }
    reload();
  });

  ctx.ui.onEvent(async (action, value) => {
    if (action === "make") return make(value?.text, value?.app);
    if (action === "pick") {
      picked = String(value);
      open = "";
      await loadFiles();
      return draw();
    }
    if (action === "reload") return reload();
    if (action === "history") {
      open = open === value ? "" : String(value);
      return draw();
    }
    const restore = /^restore:(.+):(\d+)$/.exec(action);
    if (restore) {
      const result = await ctx.call("maker", "restore", picked, restore[1], Number(restore[2])).catch((error) => ({ ok: false, error: error.message }));
      if (!result.ok) answer = { text: `Not restored: ${result.error}`, tone: "warn" };
      await load();
    }
  });

  void load();
}
