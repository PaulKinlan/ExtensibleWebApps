// Customize: a button in the corner of every app that opens a panel where
// the person changes the app for themselves. It has three tabs:
//
//   - Plugins: what is on this page (the app's own, the person's, the
//     space's), each with a switch, where it draws and a Move button; then
//     everything they can add, searchable, in three kinds: services (which
//     give the app something new other plugins use, such as a language
//     model), plugins that show on the page, and ones that work behind the
//     scenes. Signed in, it says what the person adds follows them to their
//     other devices, and marks what came from their account (std/follow).
//     A plugin that has just been added says so where it is listed,
//     with Turn on right there. The app's samples (each says what it adds),
//     and adding a plugin from files, pasted code or a URL, come last. A link
//     to the app that ends #add=<id> (the registry page's "Add to an app")
//     opens the panel and asks to add that plugin.
//   - Make: makes a new plugin of the person's own, in three steps: pick a
//     starter (std/customize.templates/), point at where it should show on
//     the page, then name it, change the code if they like, and save. Other
//     plugins can offer more ways to make one in the `customize.make` slot
//     (an agent that writes it from a description, say).
//   - Layout: where plugins can go on this page (its slots and the parts its
//     author named, and whether each is open, needs review or is locked), the
//     ui-* elements a view can use, and Arrange, which lets the person move
//     any plugin's view around the page (src/host/arrange.ts). Moves are kept
//     for this person and app (src/kernel/moves.ts).
//
// The host adds it to every app (src/host/main.ts), with a "customize" slot
// pinned to a corner. An app leaves it out with
// <meta name="customize" content="off">, and ?customize in the address
// brings it back.
//
// It is an ordinary sandboxed plugin, so it can't change anything on its
// own: every add, remove, save and share goes through the authoring service
// (src/kernel/authoring.ts), which shows the person a review card first.
// Turning plugins on or off, and moving them, needs no review.

export const manifest = {
  id: "customize",
  name: "Customize",
  description: "A Customize button that adds, makes, arranges, turns on and off, removes and shares plugins for an app.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:author", "plugins:manage"],
  // Each tab's panel customizes the app open in that tab.
  scope: "tab",
  // The button is the kernel's until someone goes to it: no app pays for this file's panel before then.
  standIn: { slot: "customize", key: "panel", html: '<ui-panel label="Customize" toggle="panel" reopen="0"><p>Opening…</p></ui-panel>' },
};

/** What each place state says to the person. */
const STATES = {
  drawn: "showing",
  waiting: "waiting for you to allow it",
  declined: "you declined it",
  locked: "the app's author locked that part of the page",
  "no match": "can't find its spot on this page",
  "bad selector": "its spot can't be read",
  slot: "showing in the page's own slot",
};

/** How a place's `put` reads. */
/** What the account line says of the person's API keys (follow.status: keys). */
const KEYS = {
  off: "API keys stay on each device.",
  locked: "Your API keys are in your account, encrypted, and this device hasn't unlocked them yet.",
  on: "Your API keys follow you too, encrypted so this site can't read them.",
};
const PUTS = { before: "above", after: "below", prepend: "at the top of", append: "at the bottom of", replace: "instead of", hide: "hides" };

/** The kinds of package, as the /packages/ page groups them too. */
const KINDS = [
  { kind: "service", title: "Services", about: "Give the app something new that other plugins use, such as a language model or the time in other places. A service draws nothing itself." },
  { kind: "ui", title: "On the page", about: "Buttons, panels and views you can add to this page." },
  { kind: "background", title: "Behind the scenes", about: "Work for you without showing anything, such as checking or tidying what other plugins do." },
];

/** The starters for Make, files beside this one. */
const STARTERS = [
  { file: "note.js", title: "A note", about: "A card with your own words." },
  { file: "links.js", title: "A list of links", about: "Links you keep beside this app." },
  { file: "tally.js", title: "A tally", about: "A button that counts, and remembers." },
  { file: "blank.js", title: "Blank", about: "A heading to replace with your own code." },
];

/** A package's kind: from the registry when it says, else worked out the same way it does. */
const kindOf = (p) => p.kind ?? (p.provides?.length || p.permissions?.some((x) => x.startsWith("provide:")) ? "service" : p.permissions?.includes("ui") ? "ui" : "background");

/** Parts of a page every app has, in words. */
const TAGS = { main: "the page's main part", header: "the page's header", footer: "the page's footer", aside: "the side panel", nav: "the page's links", h1: "the page's heading", body: "the page" };

/** A selector in words, where it says what it is plainly enough ([data-part=price] is "the price"); else the selector itself. */
const partOf = (at, each) => {
  const s = String(at).trim();
  if (TAGS[s]) return TAGS[s];
  const named = /^\[data-part=["']?([\w-]+)["']?\]$/.exec(s) ?? /^#([a-z][\w-]*)$/i.exec(s);
  if (named) return `${each ? "each" : "the"} ${named[1].replace(/[-_]+/g, " ")}`;
  return each ? `each ${s}` : s;
};

/** Words a person reads for where a place draws: "Shows below the page's heading", "Shows instead of each price", "Hides the newsletter". */
const whereOf = (p) => (p.put === "hide" ? `Hides ${partOf(p.at, p.each)}` : `Shows ${PUTS[p.put] ?? p.put} ${partOf(p.at, p.each)}`);

/** The same, from the way a person's own plugin lists its places ("replace each [data-part=price]"). */
const whereOfText = (text) => {
  const m = /^(\w+)( each)? (.+)$/.exec(String(text));
  return m ? whereOf({ put: m[1], each: !!m[2], at: m[3] }) : String(text);
};

/** An id from a name: lowercase words joined by dashes. */
const slug = (name) =>
  `${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^([^a-z])/, "my-$1")
    .slice(0, 48)
    .replace(/-+$/, "") || "my-plugin"}`;

/** The draft with its name, id and spot set, where the starter's manifest has the fields to set. */
function finish(code, name, spot) {
  let out = code;
  const quote = (s) => JSON.stringify(String(s));
  if (name?.trim()) {
    // Callbacks, so a $ in a name or selector goes in as written.
    out = out.replace(/(\bid\s*:\s*)(["'])(?:\\.|(?!\2).)*\2/, (_m, key) => `${key}${quote(slug(name))}`);
    out = out.replace(/(\bname\s*:\s*)(["'])(?:\\.|(?!\2).)*\2/, (_m, key) => `${key}${quote(name.trim().replace(/["\\]/g, ""))}`);
  }
  if (spot) out = out.replace(/(\bhere\s*:\s*\{\s*at\s*:\s*)(["'])(?:\\.|(?!\2).)*\2(\s*,\s*put\s*:\s*)(["'])(?:\\.|(?!\4).)*\4/, (_m, at, _q, put) => `${at}${quote(spot.at)}${put}${quote(spot.put)}`);
  return out;
}

export default function (ctx) {
  const views = ctx.ui.views("customize.html");
  const call = (method, ...args) => ctx.call("authoring", method, ...args).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const outside = (method, ...args) => ctx.call("outside", method, ...args).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  /** Whether the panel is open: it reads the page only while someone is looking. */
  let open = false;
  /** Which tab shows. */
  let tab = "plugins";
  /** What the search box holds. */
  let query = "";
  /** How the last action went, and a button that follows from it (Turn it on, Undo). */
  let message = "";
  let follow = null;
  /** True while something is being added, so a second click doesn't add it twice. */
  let busy = false;
  /** Each new value opens the panel again, after something on the page closed it. */
  let reopen = 0;
  /** The plugin being made in Make: the starter, the spot, the name and the code. */
  const make = { starter: "", spot: null, name: "", code: "", rev: 0, check: null, status: "", saved: false };
  /** Live MCP pairing for this tab: `outside` is only asked once the person opens a link here. */
  let liveMcpUsed = false;
  let liveMcp = { open: false, url: "", clients: [], error: "" };

  const matches = (p) => !query || `${p.name} ${p.description ?? ""} ${p.id}`.toLowerCase().includes(query.toLowerCase());

  /** A plugin's places on this page, as Customize says them. */
  const placesOf = (page, id, running) =>
    page.places
      .filter((p) => p.plugin === id)
      .map((p) => ({
        key: `${p.plugin}/${p.name}`,
        where: whereOf(p),
        state: p.state,
        label: STATES[p.state] + (p.each && p.matches ? ` (${p.matches})` : ""),
        ok: p.state === "drawn" || p.state === "slot",
        fragile: p.fragile,
        locked: p.state === "locked",
        unlocked: running?.unlocked?.includes(p.name),
        // A place that adds a view at one spot can be moved; one that hides, replaces or draws in every match is its plugin's to say.
        movable: page.arrange && !p.each && !p.in && ["before", "after", "prepend", "append"].includes(p.put),
        moved: running?.moved?.includes(p.name),
      }));

  /** Everything on this page, in one list: the person's, the space's, then the app's own. */
  const onPage = (mine, page, app) => {
    const running = (id) => page.running.find((r) => r.id === id);
    const own = mine.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      who: p.shared ? "The space's" : `${p.agent ? "Your agent" : "Yours"}${p.everywhere ? ", in every app" : ""}`,
      user: true,
      on: p.on,
      off: !p.on,
      offClass: p.on ? "" : "off",
      error: p.error,
      places: p.on ? placesOf(page, p.id, running(p.id)) : [],
      // Off, it neither shows nor runs: say so in the row, with what turning it on does.
      offHint: p.on || p.error ? "" : `Off: it isn't running.${p.places.length ? ` Turn it on and it ${p.places.map(whereOfText).map((w) => w[0].toLowerCase() + w.slice(1)).join("; ")}.` : " Turn it on to use it."}`,
      // (For one used in every app, a copy for this app is what the space gets.)
      share: page.space ? (p.shared ? "Stop sharing" : "Share with the space") : "",
      // One of the person's own can follow them to every app they open, or go back to this app alone.
      reach: p.shared ? "" : p.everywhere ? "Only this app" : "Use in every app",
      reachTitle: p.everywhere ? "Keep it for this app alone, and take it out of your other apps" : "Add it to every app you open on this device, with the same on or off",
      shared: p.shared,
    }));
    const theirs = app
      .filter((p) => p.id !== manifest.id && !mine.some((m) => m.id === p.id))
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        description: p.description ?? "",
        who: "The app's",
        app: true,
        on: !!p.enabled,
        off: !p.enabled,
        offClass: p.enabled ? "" : "off",
        places: p.enabled ? placesOf(page, p.id, running(p.id)) : [],
        offHint: p.enabled ? "" : "Off: it isn't running. Turn it on to bring it back.",
      }));
    return [...own, ...theirs].filter(matches);
  };

  /** What Make shows, from the draft. */
  const makeView = (editorLinked, makerLinked = lastMakerLinked) => ({
    ...make,
    starters: STARTERS.map((s) => ({ ...s, pressed: String(s.file === make.starter) })),
    started: !!make.starter,
    spotLabel: make.spot?.label ?? "At the bottom of the page's main part. Choose a spot to put it somewhere else.",
    chosenSpot: !!make.spot,
    ok: make.check?.ok,
    problem: make.check && !make.check.ok ? make.check.error : "",
    permissions: make.check?.ok ? make.check.permissions : [],
    editorLinked,
    makerLinked,
    liveMcp: {
      ...liveMcp,
      clientsText: liveMcp.clients?.length ? `Connected right now: ${liveMcp.clients.join(", ")}` : "",
    },
  });
  /** What the page said last, for drawing Make while the panel is closed. */
  let lastArrange = false;
  let lastEditorLinked = false;
  let lastMakerLinked = false;

  const drawNow = async () => {
    // Closed, only Make stays drawn (hidden), so a draft being typed is still there when the panel opens again.
    if (!open) return views.render("customize", "panel", { open: false, reopen, notMake: true, arrange: lastArrange, make: makeView(lastEditorLinked) });
    const [mine, page] = await Promise.all([call("mine"), call("page")]);
    if (liveMcpUsed) {
      const live = await outside("liveStatus");
      if (live && typeof live === "object" && !live.error) liveMcp = { open: !!live.open, url: live.url ?? "", clients: live.clients ?? [], error: "" };
    }
    // Signed out, the `follow` module isn't asked, so it is never fetched: the page says whether someone is signed in on this device.
    const account = page?.account ? await ctx.call("follow", "status").catch(() => null) : null;
    if (!Array.isArray(mine) || !page?.places) return views.render("customize", "panel", { open, reopen, notMake: true, make: makeView(false), message: mine?.error ?? page?.error ?? "Couldn't read this app's plugins" });
    lastArrange = !!page.arrange;
    lastEditorLinked = page.running.some((r) => r.id === "plugin-editor");
    lastMakerLinked = page.running.some((r) => r.id === "plugin-maker");
    const tabs = { plugins: tab === "plugins", make: tab === "make", layout: tab === "layout" };
    const pressed = Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, String(v)]));
    const base = {
      open,
      reopen,
      tabs,
      pressed,
      notMake: tab !== "make",
      message,
      follow,
      // Signed in: what the person adds follows them to their other devices (std/follow).
      account: account?.on ? { name: account.name ?? "you", keys: KEYS[account.keys] ?? KEYS.off, keysLocked: account.keys === "locked", error: account.error ?? "", skipped: account.skipped?.length ? `Too big to follow you, so only on this device: ${account.skipped.join(", ")}.` : "" } : null,
      space: page.space,
      inspect: page.inspect,
      arrange: page.arrange,
      busy,
      // Make is drawn on every tab, hidden on the others, so a draft in it survives a look at another tab.
      make: makeView(lastEditorLinked),
    };
    if (tab === "plugins") {
      const [packages, app] = await Promise.all([call("packages"), ctx.call("plugins", "app").catch(() => [])]);
      let list = Array.isArray(packages) ? packages : [];
      // A plugin that needs the browser's own language model (std/llm/chrome.js) is offered only where the browser has one.
      const needsModel = (p) => p.permissions?.includes("device-model");
      if (list.some(needsModel) && ((await ctx.call("device-model", "state").catch(() => null))?.state ?? "unavailable") === "unavailable") list = list.filter((p) => !needsModel(p) || p.added);
      // And one that needs the model a space holds a key for (std/llm/space.js) only in a space that has one.
      const needsSpace = (p) => p.permissions?.includes("space-model");
      if (list.some(needsSpace) && !(page.space && (await ctx.call("sync", "model").catch(() => null))?.set)) list = list.filter((p) => !needsSpace(p) || p.added);
      const ownById = new Map(mine.map((p) => [p.id, p]));
      const rows = list.filter(matches).map((p) => {
        const own = ownById.get(p.id);
        return {
          ...p,
          state: own ? (own.on ? "Added, on" : "Added, off") : p.linked ? "In this app" : "",
          stateClass: own ? (own.on ? "on" : "off") : "",
          add: !p.linked && !own,
          turnOn: !!own && !own.on,
          disabled: busy,
          // What its permissions let it do, in the kernel's own words (authoring.ts explain), as the review card says them.
          can: p.can ?? [],
          asksNothing: !p.can?.length,
          also: p.adds.length > 1 ? `Adds ${p.adds.filter((a) => a.id !== p.id).map((a) => a.name).join(", ")} too, which it needs.` : "",
        };
      });
      const groups = KINDS.map((k) => ({ ...k, packages: rows.filter((p) => kindOf(p) === k.kind) })).filter((g) => g.packages.length);
      const fromAccount = new Set(account?.on ? account.from : []);
      const here = onPage(mine, page, Array.isArray(app) ? app : []).map((p) => ({ ...p, fromAccount: !!p.user && fromAccount.has(p.id) }));
      return views.render("customize", "panel", {
        ...base,
        query,
        here,
        none: !here.length && !!query,
        empty: !here.length && !query,
        groups,
        registry: list.length > 0,
        nothingFound: !!query && !groups.length && !here.length,
        // The app's samples say what each adds before it is pressed: what it is, where it shows and what it can do.
        samples: page.samples
          .filter((s) => matches({ name: `${s.title} ${s.name ?? ""}`, description: s.description, id: s.id ?? s.href }))
          .map((s) => {
            const own = s.id ? ownById.get(s.id) : undefined;
            return {
              ...s,
              where: (s.places ?? []).map(whereOfText).join("; "),
              can: s.can ?? [],
              asksNothing: !!s.can && !s.can.length,
              state: own ? (own.on ? "Added, on" : "Added, off") : "",
              stateClass: own ? (own.on ? "on" : "off") : "",
              add: !own,
              turnOn: !!own && !own.on,
              disabled: busy,
            };
          }),
      });
    }
    if (tab === "make") return views.render("customize", "panel", base);
    const layout = await call("layout");
    return views.render("customize", "panel", { ...base, layout: layout?.slots ? { ...layout, noSlots: !layout.slots.length, noParts: !layout.parts.length } : { slots: [], parts: [], elements: [], noSlots: true, noParts: true } });
  };

  /**
   * Draws the panel, once at a time: a change heard while drawing (plugins:changed, an action) draws once
   * more after, rather than reading everything twice at the same moment.
   */
  let drawing = null;
  let again = false;
  const draw = () => {
    if (drawing) {
      again = true;
      return drawing;
    }
    drawing = (async () => {
      try {
        do {
          again = false;
          await drawNow();
        } while (again);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  /** Runs one authoring call, says how it went, and draws the panel again. */
  const run = async (method, args, done, then = null) => {
    const result = await call(method, ...args);
    const failed = result && typeof result === "object" && result.ok === false;
    message = failed ? result.error : done;
    follow = failed ? null : then;
    await draw();
    return !failed;
  };

  /** Adds plugins from this site one after another, stopping at the first the person declines; offers to turn the last on. */
  const addAll = async (adds) => {
    if (busy) return;
    busy = true;
    message = "Waiting for your answer on the review card…";
    follow = null;
    await draw();
    try {
      const ids = [];
      for (const a of adds) {
        const result = await call("add", a.href);
        if (result?.ok === false) {
          message = result.error === "Not added" ? `${a.name} wasn't added.` : result.error;
          follow = null;
          return;
        }
        if (result?.id) ids.push(result.id);
      }
      // The person has just seen its code and accepted it: that's the moment they want it, so it goes on now.
      await turnOn(ids, adds.map((a) => a.name));
    } finally {
      busy = false;
      await draw();
    }
  };

  /**
   * Turns on plugins the person has just added (after the review they accepted), and says so with a way back.
   * The last is what they asked for; turning it on brings the ones it needs too.
   */
  const turnOn = async (ids, names) => {
    const before = await call("mine");
    for (const id of ids) {
      const result = await call("turn", id, true);
      if (result?.ok === false) {
        message = `Added ${names.join(" and ")}, but couldn't turn it on: ${result.error}`;
        follow = null;
        return;
      }
    }
    undo = Array.isArray(before) ? new Map(before.map((m) => [m.id, !!m.on])) : null;
    for (const id of ids) undo?.set(id, false);
    message = `Added ${names.join(" and ")}, and turned ${ids.length > 1 ? "them" : "it"} on.`;
    follow = undo && ids.length ? { label: "Turn off", action: "undo-turn", value: ids[ids.length - 1] } : null;
  };

  /** Turns one of the person's plugins on or off, or the app's own (plugins.setEnabled). */
  const turn = async (id) => {
    const mine = await call("mine");
    const p = Array.isArray(mine) ? mine.find((m) => m.id === id) : undefined;
    if (!p) {
      const app = await ctx.call("plugins", "app").catch(() => []);
      const theirs = app.find((a) => a.id === id);
      if (!theirs) return;
      await ctx.call("plugins", "setEnabled", id, !theirs.enabled);
      message = `Turned ${theirs.name ?? id} ${theirs.enabled ? "off" : "on"}.`;
      follow = null;
      return draw();
    }
    const before = new Map(mine.map((m) => [m.id, !!m.on]));
    const result = await call("turn", p.id, !p.on);
    if (result?.ok === false) message = result.error;
    else {
      // Turning one on brings the plugins of yours it needs; turning one off takes the ones that need it.
      const also = (result?.also ?? []).map((a) => a.name);
      const why = p.on ? (also.length > 1 ? "which need it" : "which needs it") : "which it needs";
      message = `Turned ${p.name} ${p.on ? "off" : "on"}${also.length ? `, and ${also.join(" and ")}, ${why}` : ""}.`;
    }
    undo = result?.ok === false ? null : before;
    follow = undo ? { label: "Undo", action: "undo-turn", value: p.id } : null;
    await draw();
  };

  /** What the person's plugins were before the last turn, so Undo puts every one it changed back, not just the one clicked. */
  let undo = null;
  const undoTurn = async () => {
    const before = undo;
    undo = null;
    follow = null;
    const mine = await call("mine");
    if (!before || !Array.isArray(mine)) return draw();
    const changed = mine.filter((m) => before.has(m.id) && before.get(m.id) !== !!m.on);
    // Off first, then on: turning one on brings what it needs, so the ones that were on end up on.
    for (const m of changed.filter((m) => !before.get(m.id))) await call("turn", m.id, false);
    for (const m of changed.filter((m) => before.get(m.id))) await call("turn", m.id, true);
    // Turning one off may have stopped others that need it (a provider that replaced another): bring back any that were on.
    const now = await call("mine");
    if (Array.isArray(now)) for (const m of now.filter((m) => before.get(m.id) && !m.on)) await call("turn", m.id, true);
    const said = (list, how) => (list.length ? `Turned ${list.map((m) => m.name).join(" and ")} ${how}.` : "");
    message = changed.length ? [said(changed.filter((m) => m.on), "off"), said(changed.filter((m) => !m.on), "back on")].filter(Boolean).join(" ") : "Nothing to put back.";
    await draw();
  };

  /**
   * A link brought the person here to add one plugin from the registry (/packages/ "Add to an app" opens the
   * app at #add=<id>, and the page passes the id on): the panel opens and its review card comes up, as if
   * they had pressed its Add. Only what the registry lists can be asked for this way, and nothing is added
   * until they accept the review.
   */
  const addAsked = async (id) => {
    open = true;
    tab = "plugins";
    query = "";
    reopen++;
    follow = null;
    const [packages, mine] = await Promise.all([call("packages"), call("mine")]);
    const p = Array.isArray(packages) ? packages.find((x) => x.id === id) : undefined;
    const own = Array.isArray(mine) ? mine.find((m) => m.id === id) : undefined;
    if (!p) message = `This site's plugin registry has no plugin called “${id.slice(0, 64)}”.`;
    else if (own) {
      message = `${p.name} is already added here${own.on ? ", and on" : ". It's off"}.`;
      follow = own.on ? null : { label: "Turn on", action: "turn", value: id };
    } else if (p.linked) message = `${p.name} is already part of this app.`;
    else return addAll(p.adds);
    return draw();
  };

  /** Loads a starter into Make. */
  const start = async (file) => {
    const code = await call("file", `customize.templates/${file}`);
    if (typeof code !== "string") {
      make.status = code?.error ?? "Couldn't read that starter";
      return draw();
    }
    make.starter = file;
    make.name = make.name || STARTERS.find((s) => s.file === file)?.title.replace(/^A /, "My ") || "My plugin";
    // The editor shows the starter with the spot and name already in it.
    make.code = finish(code, make.name, make.spot);
    make.rev++;
    make.status = "";
    make.check = await call("check", finish(make.code, make.name, make.spot));
    await draw();
  };

  ctx.ui.onEvent(async (action, value) => {
    if (action === "panel") {
      open = !!value;
      if (!open) {
        message = "";
        follow = null;
      }
      return draw();
    }
    if (action === "tab") {
      tab = ["plugins", "make", "layout"].includes(value) ? value : "plugins";
      message = "";
      follow = null;
      return draw();
    }
    if (action === "search") {
      query = String(value ?? "").trim();
      return draw();
    }
    if (action === "add") return addAsked(String(value ?? ""));
    if (action === "sync-now") {
      const now = await ctx.call("follow", "now").catch((e) => ({ error: String(e?.message ?? e) }));
      message = now?.error ? now.error : "Up to date with your account.";
      follow = null;
      return draw();
    }
    if (action === "turn") return turn(String(value));
    if (action === "undo-turn") return undoTurn();
    if (action === "remove") {
      const mine = await call("mine");
      const name = (Array.isArray(mine) ? mine.find((m) => m.id === value)?.name : undefined) ?? value;
      message = "Waiting for your answer on the review card…";
      follow = null;
      await draw();
      const result = await call("remove", value);
      message = result?.ok === false ? (result.error === "Not removed" ? `${name} is still here.` : result.error) : `Removed ${name}. Your data from it is kept.`;
      return draw();
    }
    if (action === "reach") {
      const mine = await call("mine");
      const p = Array.isArray(mine) ? mine.find((m) => m.id === value) : undefined;
      if (!p) return;
      message = "Waiting for your answer on the review card…";
      follow = null;
      await draw();
      const result = await call("everywhere", p.id, !p.everywhere);
      message = result?.ok === false ? (result.error === "Still for this app only" ? `${p.name} is still only in this app.` : result.error) : p.everywhere ? `${p.name} is now only in this app.` : `${p.name} is now in every app you open on this device.`;
      return draw();
    }
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
    if (action === "move") {
      const [plugin, place] = String(value).split("/");
      return call("arrange", plugin, place);
    }
    if (action === "unmove") {
      const [plugin, place] = String(value).split("/");
      return run("move", [plugin, place, null], "Put back where its plugin puts it.");
    }
    if (action === "arrange") return call("arrange");
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
    if (action === "pick") {
      // The file chooser opens only while the click still counts, so ask for it before anything else.
      const result = await call("pick");
      if (result?.ok === false) {
        message = result.error;
        follow = null;
        return draw();
      }
      const mine = await call("mine");
      const ids = result?.ids ?? [];
      const names = ids.map((id) => (Array.isArray(mine) ? mine.find((m) => m.id === id)?.name : undefined) ?? id);
      if (ids.length) await turnOn(ids, names);
      return draw();
    }
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

    // Make a plugin.
    if (action === "starter") return start(String(value));
    if (action === "spot") {
      // The draft as typed comes with it (the button is in the draft's form): keep it, and show it again as it was.
      if (typeof value?.code === "string" && value.code !== make.code) {
        make.code = value.code;
        make.rev++;
      }
      if (typeof value?.name === "string") make.name = value.name;
      // The panel closed so the person can see the page; it opens again once they choose (or cancel).
      const spot = await call("choose", "Point at where your plugin should show, and click");
      if (spot && spot.at) make.spot = spot;
      reopen++;
      if (make.code) make.check = await call("check", finish(make.code, make.name, make.spot));
      return draw();
    }
    if (action === "make-check" || action === "make-save") {
      make.code = String(value?.code ?? make.code);
      make.name = String(value?.name ?? make.name);
      const code = finish(make.code, make.name, make.spot);
      make.check = await call("check", code);
      make.status = "";
      make.saved = false;
      if (action === "make-save" && make.check?.ok) {
        make.status = "Waiting for your answer on the review card…";
        await draw();
        const saved = await call("save", code);
        make.saved = !!saved?.ok;
        make.status = saved?.ok ? `Saved, and ${make.check.manifest.name} is on. It's under Plugins, where you can turn it off, move it or remove it.` : saved?.error === "Not saved" ? "Not saved. Change it and save again when you're ready." : saved?.error ?? "Not saved";
        if (saved?.ok) {
          make.code = code;
          make.rev++;
        }
      }
      return draw();
    }
    if (action === "maker") {
      // The plugin maker (std/plugin-maker.js) draws in this tab's slot once it is on the page.
      const packages = await call("packages");
      const maker = Array.isArray(packages) ? packages.find((x) => x.id === "plugin-maker") : undefined;
      if (maker?.adds.length) await addAll(maker.adds);
      // Here already and turned off (the person's, or the app's own): the button turns it back on.
      else if (maker) return turn(maker.id);
      else message = "The plugin maker isn't in this site's registry.";
      return draw();
    }
    if (action === "editor") {
      const packages = await call("packages");
      const editor = Array.isArray(packages) ? packages.find((x) => x.id === "plugin-editor") : undefined;
      if (editor?.adds.length) await addAll(editor.adds);
      else message = "The plugin editor isn't in this site's registry.";
      return draw();
    }
    if (action === "live-mcp-open" || action === "live-mcp-rotate") {
      liveMcpUsed = true;
      const result = await outside("openLive", { rotate: action === "live-mcp-rotate" });
      liveMcp = result?.ok
        ? { open: true, url: result.url ?? "", clients: result.clients ?? [], error: "" }
        : { open: false, url: "", clients: [], error: result?.error ?? "Couldn't open a live MCP link" };
      return draw();
    }
    if (action === "live-mcp-close") {
      if (liveMcpUsed) await outside("closeLive");
      liveMcp = { open: false, url: "", clients: [], error: "" };
      return draw();
    }
    if (action === "remove-component") {
      const tag = String(value ?? "");
      if (!tag) return;
      message = "Waiting for your answer on the review card…";
      follow = null;
      await draw();
      const result = await call("removeComponent", tag);
      message = result?.ok === false ? (result.error === "Not removed" ? `<${tag}> is still here.` : result.error) : `Removed <${tag}>.`;
      return draw();
    }
  });

  // Plugins turned on, off, added or removed elsewhere (another tab, an agent, the space) show here too.
  ctx.on("plugins:changed", () => open && draw());

  return draw();
}
