// Debug console: a bug in the corner of the page. Open it to see what went
// wrong (errors, refused permissions, failed calls) or everything the kernel
// traced, and copy it as text to paste into a bug report.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/debug-console.js">
//   <slot name="debug"></slot>
//
// It reads the kernel's trace, which names every plugin and what it did, so
// it needs `debug:read`. Errors from the page itself (a file that didn't
// load, an uncaught exception) are in the trace too: the host reports them.
// The kernel is shared by every open tab, so by default the console shows
// only this app's plugins, this tab's page and the kernel's own events.
// The bug and its panel are the <ui-debug> element; this plugin decides what
// goes in the panel.

export const manifest = {
  id: "debug-console",
  name: "Debug console",
  description: "A bug button that shows errors and the trace, ready to copy into a bug report.",
  version: "1.0.0",
  permissions: ["ui", "debug:read"],
  // One per tab, so opening the panel in one tab doesn't open it in another.
  scope: "tab",
  settings: {
    corner: { type: "string", title: "Where the bug sits", enum: ["bottom-left", "bottom-right", "top-left", "top-right", "inline"], default: "bottom-left" },
  },
};

/** How many events it keeps; the kernel keeps the last 500 too. */
const KEEP = 1000;

/** An error, a refused permission, or a call or hook that failed. */
const isProblem = (e) => e.kind === "error" || e.kind === "denied" || /^failed/.test(e.detail ?? "");

export default async function (ctx) {
  const html = ctx.ui.html;
  let corner = "bottom-left";
  let startedAt = Date.now();
  /** Every event heard, oldest first. */
  let events = [];
  let open = false;
  let show = "problems";
  /** The tab this instance serves, and the plugins its app links; the kernel says, in debug.recent(). */
  let tab;
  let app;
  /** Only this app's plugins, this tab's page and the kernel itself; off, the whole kernel's trace. */
  let onlyThisApp = true;

  /** Whether an event belongs to this app. The kernel is shared by every tab, so its trace holds other apps too. */
  const ours = (e) => {
    if (!onlyThisApp || !app) return true;
    if (e.plugin) return app.includes(e.plugin.split("@")[0]);
    // Page reports say which tab they came from; other events without a plugin are the kernel's own.
    return !e.name.startsWith("page:") || e.detail?.startsWith(`tab ${tab}:`);
  };

  /** One line per event: time, kind, name, plugin, how long it took, what happened and its trace id. */
  const line = (e) => {
    const time = new Date(startedAt + e.at).toISOString().slice(11, 23);
    return [time, e.kind.padEnd(9), e.name, e.plugin ? `[${e.plugin}]` : "", e.ms !== undefined ? `${e.ms} ms` : "", e.detail ?? "", e.trace ? `#${e.trace}` : ""]
      .filter(Boolean)
      .join("  ");
  };

  const problemCount = () => events.filter((e) => isProblem(e) && ours(e)).length;

  const draw = () => {
    const mine = events.filter(ours);
    const problems = mine.filter(isProblem);
    const shown = show === "problems" ? problems : mine;
    // While the panel is closed only the bug and its count are drawn: the log is drawn while someone is looking.
    const panel = open
      ? html`
          <ui-toolbar>
            <button data-action="show" data-value="problems" aria-pressed="${String(show === "problems")}">Problems (${problems.length})</button>
            <button data-action="show" data-value="all" aria-pressed="${String(show === "all")}">Everything (${mine.length})</button>
            ${app ? html`<label><input type="checkbox" data-action="only-this-app" ${onlyThisApp ? "checked" : ""}> Only this app</label>` : ""}
            <ui-spacer></ui-spacer>
            <button data-copy="log" data-primary>Copy</button>
            <button data-action="clear">Clear</button>
          </ui-toolbar>
          <pre data-copy-source="log">${shown.length ? shown.map((e) => (isProblem(e) ? html`<strong>${line(e)}</strong>\n` : `${line(e)}\n`)) : show === "problems" ? "No problems so far." : "Nothing traced yet."}</pre>
        `
      : "";
    ctx.ui.render("debug", "console", html`<ui-debug corner="${corner}" problems="${problems.length}" label="Debug console" toggle="toggle">${panel}</ui-debug>`);
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "toggle") open = value === true;
    else if (action === "show") show = value === "all" ? "all" : "problems";
    else if (action === "only-this-app") onlyThisApp = value === true;
    else if (action === "clear") events = [];
    else return;
    draw();
  });

  ctx.on("debug:trace", (batch) => {
    const before = problemCount();
    events = events.concat(batch).slice(-KEEP);
    // Closed, only a change in the count is worth a redraw.
    if (open || problemCount() !== before) draw();
  });

  ctx.settings.onChange((values) => {
    corner = String(values.corner ?? corner);
    draw();
  });

  // What happened before this plugin started: the app's other plugins loading, and anything that failed.
  const [recent, settings] = await Promise.all([ctx.call("debug", "recent"), ctx.settings.get()]);
  ({ startedAt, tab, app } = recent);
  corner = String(settings.corner ?? corner);
  const heard = events;
  events = recent.events.filter((e) => !heard.some((h) => h.at === e.at && h.name === e.name)).concat(heard).slice(-KEEP);
  draw();
}
