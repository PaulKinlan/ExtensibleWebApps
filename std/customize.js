// Customize: a button in the corner of every app that opens a panel where
// the person changes the app for themselves:
//
//   - adds their own plugins: from this site's plugin registry (/packages/),
//     the app's samples, files they pick, code they paste, or a URL on this
//     site. Each is kept on this device, never in the app's files.
//   - turns them on or off, or removes them. A new one starts off, and the
//     panel shows what it asks for and where it draws before it is turned on.
//     Turning one on turns on the ones of theirs it needs (World clock brings
//     Clock), and turning one off turns off the ones that need it.
//   - in a space, shares one with the space's members, or stops sharing it
//   - sees every plugin's places and how each went: drawn, waiting for a
//     review card, declined, locked by the app's author, or matching nothing
//   - lets one plugin into an area the author locked
//   - starts inspect mode, to point at a part and change it
//
// The host adds it to every app (src/host/main.ts), with a "customize" slot
// pinned to a corner. An app leaves it out with
// <meta name="customize" content="off">, and ?customize in the address
// brings it back.
//
// It is an ordinary sandboxed plugin, so it can't change anything on its
// own: every add, remove and share goes through the authoring service
// (src/kernel/authoring.ts), which shows the person a review card first.
// Turning one of their own plugins on or off needs no review.

export const manifest = {
  id: "customize",
  name: "Customize",
  description: "A Customize button that adds, turns on and off, removes and shares the person's own plugins for an app.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:author", "plugins:manage"],
  // Each tab's panel customizes the app open in that tab.
  scope: "tab",
};

/** What each place state says to the person. */
const STATES = {
  drawn: "In place",
  waiting: "Waiting for you to allow it",
  declined: "You declined it",
  locked: "Locked by the app's author",
  "no match": "Matches nothing in this page",
  "bad selector": "The selector can't be read",
};

export default function (ctx) {
  const views = ctx.ui.views("customize.html");
  const call = (method, ...args) => ctx.call("authoring", method, ...args).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  /** Whether the panel is open: it reads the page only while someone is looking. */
  let open = false;
  /** How the last action went. */
  let message = "";
  /** True while something is being added, so a second click doesn't add it twice. */
  let busy = false;

  /** A plugin's places and how each went, from the page. */
  const placesOf = (page, id, unlocked) =>
    page.places
      .filter((p) => p.plugin === id)
      .map((p) => ({
        key: `${p.plugin}/${p.name}`,
        plugin: p.plugin,
        name: p.name,
        where: `${p.put}${p.each ? " each" : ""} ${p.at}`,
        state: p.state,
        label: STATES[p.state] + (p.each && p.matches ? ` (${p.matches})` : ""),
        ok: p.state === "drawn",
        fragile: p.fragile,
        locked: p.state === "locked",
        unlocked: unlocked.includes(p.name),
      }));

  const row = (page, space) => (p) => {
    const live = page.running.find((r) => r.id === p.id);
    return {
      ...p,
      off: !p.on,
      asks: p.on ? "" : `Asks for: ${p.permissions.join(", ") || "nothing"}`,
      draws: p.on || !p.places.length ? "" : `Draws: ${p.places.join("; ")}`,
      places: p.on ? placesOf(page, p.id, live?.unlocked ?? []) : [],
      share: space ? (p.shared ? "Stop sharing" : "Share with the space") : "",
    };
  };

  const draw = async () => {
    if (!open) return views.render("customize", "panel", { open: false });
    const [mine, page, packages] = await Promise.all([call("mine"), call("page"), call("packages")]);
    if (!Array.isArray(mine) || !page?.places) return views.render("customize", "panel", { open, message: mine?.error ?? page?.error ?? "Couldn't read this app's plugins" });
    const toRow = row(page, page.space);
    const list = Array.isArray(packages) ? packages : [];
    views.render("customize", "panel", {
      open,
      message,
      space: page.space,
      inspect: page.inspect,
      mine: mine.filter((p) => !p.shared).map(toRow),
      shared: mine.filter((p) => p.shared).map(toRow),
      app: page.running.filter((p) => p.id && !p.user && p.id !== manifest.id).map((p) => ({ id: p.id, name: p.name ?? p.id, places: placesOf(page, p.id, p.unlocked) })),
      packages: list.map((p) => ({
        ...p,
        label: p.linked ? "In this app" : p.added ? "Added" : "Add",
        disabled: p.added || p.linked || busy,
        asks: `Asks for: ${p.permissions.join(", ") || "nothing"}`,
        also: p.adds.length > 1 ? `Adds ${p.adds.filter((a) => a.id !== p.id).map((a) => a.name).join(", ")} too, which it needs.` : "",
      })),
      registry: list.length > 0,
      samples: page.samples,
      busy,
    });
  };

  /** Runs one authoring call, says how it went, and draws the panel again. */
  const run = async (method, args, done) => {
    const result = await call(method, ...args);
    const failed = result && typeof result === "object" && result.ok === false;
    message = failed ? result.error : done;
    await draw();
    return !failed;
  };

  /** Adds plugins from this site one after another, stopping at the first the person declines. */
  const addAll = async (adds) => {
    if (busy) return;
    busy = true;
    await draw();
    try {
      for (const a of adds) if (!(await run("add", [a.href]))) return;
      message = `Added ${adds.map((a) => a.name).join(" and ")}. Turn ${adds.length > 1 ? "them" : "it"} on above.`;
    } finally {
      busy = false;
      await draw();
    }
  };

  ctx.ui.onEvent(async (action, value) => {
    if (action === "panel") {
      open = !!value;
      if (!open) message = "";
      return draw();
    }
    if (action === "turn") {
      const mine = await call("mine");
      const p = Array.isArray(mine) ? mine.find((m) => m.id === value) : undefined;
      if (!p) return;
      const result = await call("turn", p.id, !p.on);
      if (result?.ok === false) message = result.error;
      else {
        // Turning one on brings the plugins of yours it needs; turning one off takes the ones that need it.
        const also = (result?.also ?? []).map((a) => a.name);
        const why = p.on ? (also.length > 1 ? "which need it" : "which needs it") : "which it needs";
        message = `Turned ${p.name} ${p.on ? "off" : "on"}${also.length ? `, and ${also.join(" and ")}, ${why}` : ""}`;
      }
      await draw();
      return;
    }
    if (action === "remove") return run("remove", [value], "Removed");
    if (action === "share") {
      const mine = await call("mine");
      const p = Array.isArray(mine) ? mine.find((m) => m.id === value) : undefined;
      if (p) await run(p.shared ? "unshare" : "share", [p.id], p.shared ? "No longer shared" : "Shared with the space");
      return;
    }
    if (action === "unlock" || action === "lock") {
      const [plugin, place] = String(value).split("/");
      return run(action, [plugin, place], action === "unlock" ? `Unlocked for ${plugin}` : "");
    }
    if (action === "package") {
      const packages = await call("packages");
      const p = Array.isArray(packages) ? packages.find((x) => x.id === value) : undefined;
      if (p && p.adds.length) await addAll(p.adds);
      return;
    }
    if (action === "sample") {
      const page = await call("page");
      const sample = page?.samples?.find((s) => s.href === value);
      if (sample) await addAll([{ href: sample.href, name: sample.title }]);
      return;
    }
    if (action === "pick") return run("pick", [], "Added. Turn it on above.");
    if (action === "paste") {
      const code = String(value?.code ?? "").trim();
      if (code) await run("save", [code], "Added and turned on.");
      return;
    }
    if (action === "url") {
      const url = String(value?.url ?? "").trim();
      if (url) await addAll([{ href: url, name: url.split("/").pop() }]);
      return;
    }
    if (action === "inspect") return call("inspect");
  });

  // Plugins turned on, off, added or removed elsewhere (another tab, an agent, the space) show here too.
  ctx.on("plugins:changed", () => open && draw());

  return draw();
}
