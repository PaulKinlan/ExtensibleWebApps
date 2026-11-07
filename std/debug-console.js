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
/** The most text the log draws: a view must stay well under the kernel's limit on HTML. Older lines are left out first. */
const DRAWN = 100_000;
/** The longest a single line is drawn. */
const LINE = 1500;

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
  /** The tab this instance serves, and the plugins its app links; the kernel says, in debug.recent() and debug.app(). */
  let tab;
  let app;
  /** The `seq` of the newest event held, so an event in both the snapshot and a batch is kept once. */
  let lastSeq = 0;
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
    const text = [time, e.kind.padEnd(9), e.name, e.plugin ? `[${e.plugin}]` : "", e.ms !== undefined ? `${e.ms} ms` : "", e.detail ?? "", e.trace ? `#${e.trace}` : ""]
      .filter(Boolean)
      .join("  ");
    return text.length > LINE ? `${text.slice(0, LINE)}…` : text;
  };

  /** The newest lines that fit in DRAWN characters, oldest first, and how many were left out. */
  const fit = (list) => {
    const lines = [];
    let size = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const text = line(list[i]);
      // Measured as escaped HTML: `&` becomes `&amp;`, and so on.
      const cost = text.length + 4 * (text.match(/[&<>"']/g)?.length ?? 0) + 20;
      if (size + cost > DRAWN) return { lines, left: i + 1 };
      size += cost;
      lines.unshift({ text, problem: isProblem(list[i]) });
    }
    return { lines, left: 0 };
  };

  const problemCount = () => events.filter((e) => isProblem(e) && ours(e)).length;

  const draw = () => {
    const mine = events.filter(ours);
    const problems = mine.filter(isProblem);
    const { lines, left } = fit(show === "problems" ? problems : mine);
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
          <pre data-copy-source="log">${left ? `… ${left} earlier line${left === 1 ? "" : "s"} not shown\n` : ""}${lines.length ? lines.map((l) => (l.problem ? html`<strong>${l.text}</strong>\n` : `${l.text}\n`)) : show === "problems" ? "No problems so far." : "Nothing traced yet."}</pre>
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

  /** Asks again which plugins the app links: a tab's console can start before its app is open. */
  const refreshApp = async () => {
    ({ app } = await ctx.call("debug", "app"));
    draw();
  };

  ctx.on("debug:trace", (batch) => {
    const fresh = batch.filter((e) => e.seq > lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh[fresh.length - 1].seq;
    const before = problemCount();
    events = events.concat(fresh).slice(-KEEP);
    if (tab && fresh.some((e) => e.name === "app:open" && e.detail?.startsWith(`${tab}:`))) void refreshApp();
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
  // Batches heard while waiting are newer than some of the snapshot, and may overlap it: keep each event once, in order.
  const snapshotLast = recent.events.at(-1)?.seq ?? 0;
  events = recent.events.concat(events.filter((e) => e.seq > snapshotLast)).slice(-KEEP);
  lastSeq = Math.max(lastSeq, snapshotLast);
  draw();
}
