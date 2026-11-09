// The `maker` service: apps a person makes in the browser, by describing
// them to the app maker (std/maker/app-maker.agent.md) or by hand. A made
// app is a folder like any app in demos/: an app.html that lays out slots
// and links plugins, and the plugins with their templates. It is kept in
// the person's data folder, under made/apps/<name>/, and the service worker
// serves it at /apps/<name>/ (sw/routes/made.js).
//
//   save       writes one or more of an app's files at once, after the
//              person accepts one review card that shows every change.
//              app.html must follow the page rules (sw/made-page.js): no
//              script but the platform's, so the page is layout and the
//              code is in plugins, each in its worker.
//   history    every file keeps its earlier versions, with who saved each
//   restore    and why; restoring one is a save like any other, reviewed.
//   check      the checks `npm run check` makes (checks.js), and, when the
//              app is open (the preview on /new/ reloads it), what went
//              wrong as it ran: plugins that didn't start, errors, refused
//              permissions. The app maker reads these and fixes the files.
//
// What a made app runs is only its own files and the standard plugins it
// links. The model that wrote it isn't one of them, so it keeps working with
// the LLM plugin and the app maker turned off.
//
// A kernel module (docs/layers.md): a site that lists `maker` in kernel.json has it, as `ctx.call("maker", …)`.

import { diffLines, trim } from "../../src/kernel/diff";
import { capabilities, grants } from "../../src/kernel/gate";
import { readManifest } from "../../src/kernel/manifest";
import type { Param, ServiceProvider } from "../../src/kernel/remote";
import { recent } from "../../src/kernel/trace";
import { COMPONENTS, DROPPED_WITH_CONTENT, ELEMENTS, ELEMENT_ATTRIBUTES, GLOBAL_ATTRIBUTES } from "../../src/shared/html";
import { service, type ModuleKernel } from "../../src/kernel/modules";
import { checkFiles } from "./checks.js";
import { APP_NAME, FILE_NAME, appUrl, pageParts, pageProblems } from "../../sw/made-page.js";

/** Where made apps and their versions are kept in the data folder. `made` is one of the platform's folders (paths.ts), so no plugin can write there itself. */
const APPS = "made/apps";
const HISTORY = "made/history";
/** The names of the person's apps, as a folder can't be listed. */
const INDEX = "made/apps.json";
const MAX_FILE = 100_000;
const MAX_FILES = 30;
/** How many earlier versions of each file are kept. */
const VERSIONS = 50;
/** How long `check` waits for the app to open somewhere, and then for it to settle. */
const OPEN_MS = 10_000;
const SETTLE_MS = 2_500;

type Version = { version: number; at: string; by: string; note: string; text: string; removed?: boolean };
type Problem = { level: "error" | "warning"; file: string; line?: number; message: string };

const base = (instance: string) => instance.split("@")[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = (name: Param["schema"] = {}): Param => ({ name: "app", schema: { type: "string", description: "The app's name, as in its address /apps/<name>/: lowercase letters, digits and dashes", ...name } });
const file: Param = { name: "file", schema: { type: "string", description: "A file of the app: app.html, a plugin such as library.js, or a template such as library.html" } };

function checkName(name: unknown): string {
  if (typeof name !== "string" || !APP_NAME.test(name)) throw new Error(`${String(name)} isn't an app name: use lowercase letters, digits and dashes, starting with a letter`);
  return name;
}
function checkFile(name: unknown): string {
  if (typeof name !== "string" || !FILE_NAME.test(name)) throw new Error(`${String(name)} isn't a file a made app can have: app.html, or lowercase names ending in .js, .html, .css or .agent.md`);
  return name;
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, store, remote } = kernel;
  kernel.hook("maker:changed", { mode: "emit", needs: "apps:read", args: "{ app, files, removed? }", description: "A made app's files were saved, restored or removed (maker.save, maker.restore, maker.remove)." });
  kernel.hook("maker:check", { mode: "emit", needs: "apps:read", args: "{ app }", description: "maker.check wants the app opened again, to see it run: a preview of it (std/maker/your-apps.js) reloads." });

  /**
   * One change at a time per app, and to the list of apps: what was checked after a review and what is
   * written run together, so two accepted saves (or a save and a removal) can't interleave.
   */
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).then(work, work);
    locks.set(key, run.catch(() => {}));
    return run;
  };

  const nameOf = (instance: string) => remote.installed.get(base(instance))?.manifest.name ?? base(instance);
  const read = async (name: string, f: string) => store.readText(`${APPS}/${name}/${f}`);
  const filesOf = async (name: string) => {
    const out = new Map<string, string>();
    for (const f of (await store.listFiles(`${APPS}/${name}`)).filter((f) => FILE_NAME.test(f)).sort()) out.set(f, (await read(name, f)) ?? "");
    return out;
  };
  const historyOf = async (name: string, f: string) => store.readJson<Version[]>(`${HISTORY}/${name}/${f}.json`, []);
  const remember = async (name: string, f: string, entry: Omit<Version, "version" | "at">) => {
    const versions = await historyOf(name, f);
    const version = (versions.at(-1)?.version ?? 0) + 1;
    versions.push({ version, at: new Date().toISOString(), ...entry });
    await store.writeJson(`${HISTORY}/${name}/${f}.json`, versions.slice(-VERSIONS));
    return version;
  };

  const indexed = (name: string, present: boolean) =>
    locked(INDEX, async () => {
      const names = (await store.readJson<string[]>(INDEX, [])).filter((n) => n !== name);
      await store.writeJson(INDEX, present ? [...names, name].sort() : names);
    });

  /** The kernel's rules for the checks: its manifest reader, gate, HTML allowlist and API reference. */
  const rules = (name: string) => {
    const reference = kernel.describe();
    const methods = new Map<string, string | undefined>();
    for (const s of reference.services) for (const m of s.methods) methods.set(`${s.name}.${m.name}`, m.needs);
    return {
      readManifest,
      capabilities,
      grants,
      ELEMENTS,
      COMPONENTS,
      GLOBAL_ATTRIBUTES,
      ELEMENT_ATTRIBUTES,
      DROPPED_WITH_CONTENT,
      methods,
      hooks: new Map(reference.hooks.map((h) => [h.name, h.listen])),
      services: new Set(reference.services.map((s) => s.name)),
      collectionOwner: (collection: string) => remote.collectionOwner?.(collection),
      takenBy: (id: string) => {
        const running = remote.installed.get(id);
        // Running from this app's own folder is fine: that's this plugin.
        if (!running || (running.href && new URL(running.href, "http://x").pathname.startsWith(`/apps/${name}/`))) return undefined;
        return running.href ? new URL(running.href).pathname : running.manifest.name;
      },
    };
  };

  /**
   * Brings the running copy of one of the app's plugins up to date with its saved code `text` ("" once
   * the file is removed). The same plugin is replaced in place, so every tab that has the app open
   * restarts it with the new code; one whose id changed, or that won't start any more, is stopped.
   */
  const replaceOld = async (name: string, f: string, text: string) => {
    for (const [id, running] of [...remote.installed]) {
      if (!running.href || new URL(running.href, "http://x").pathname !== `/apps/${name}/${f}` || running.source === text) continue;
      let same = false;
      try {
        same = text !== "" && readManifest(text).id === id;
      } catch {}
      const result = same ? await remote.install(text, { origin: running.origin, href: running.href, enabled: running.enabled }) : undefined;
      if (!result?.ok && remote.installed.get(id)?.source === running.source) remote.uninstall(id);
    }
  };

  /** One file's change, as the review card shows it: its name, then its code. */
  const shown = (f: string, text: string | undefined) => (text === undefined ? "" : `──── ${f} ────\n${text}\n`);
  /** Why a change can't be shown whole on one card (the card shows at most SHOWN lines, each cut at 1000 characters), or undefined if it can. */
  const tooBig = (before: string, after: string) => {
    const lines = trim(diffLines(before, after));
    if (lines.some((l) => l.text.endsWith(" …") && l.text.length > 1000)) return "A line is longer than 1000 characters, so the review card couldn't show it whole: break it up";
    if (lines.some((l) => /^… \d+ more lines? not shown$/.test(l.text))) return "That is more than one review card can show in full: save the app's files in a few smaller saves (app.html and one plugin first, then the rest)";
    return undefined;
  };

  async function save(instance: string, name: string, files: unknown, note: unknown, dispatch: { trace?: string }, how: "save" | "restore" = "save") {
    if (!Array.isArray(files) || !files.length) throw new Error("save() needs a list of files: [{ name, text }]");
    if (files.length > MAX_FILES) throw new Error(`An app can save at most ${MAX_FILES} files at once`);
    const wanted = new Map<string, string>();
    for (const f of files) {
      const fname = checkFile(f?.name);
      if (typeof f.text !== "string") throw new Error(`${fname}: its text must be a string`);
      if (f.text.length > MAX_FILE) return { ok: false, error: `${fname} is longer than ${MAX_FILE} characters` };
      wanted.set(fname, f.text);
    }
    // Refuse what could never run, before the person is asked.
    const refused: Problem[] = [];
    for (const [fname, text] of wanted) {
      if (fname === "app.html") for (const p of pageProblems(text)) refused.push({ level: "error", file: fname, line: p.line, message: p.message });
      if (fname.endsWith(".js")) {
        try {
          readManifest(text);
        } catch (error) {
          refused.push({ level: "error", file: fname, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (refused.length) return { ok: false, error: "Nothing was saved: fix these first", problems: refused };
    const current = await filesOf(name);
    const isNew = !current.has("app.html");
    if (isNew && !wanted.has("app.html")) return { ok: false, error: `There is no app called ${name} yet: save its app.html with its first files` };
    const changed = [...wanted].filter(([f, text]) => current.get(f) !== text);
    if (!changed.length) return { ok: true, url: appUrl(name), saved: [], note: "Nothing changed" };
    const title = pageParts(wanted.get("app.html") ?? current.get("app.html") ?? "").title || name;
    const target = isNew
      ? `your apps: makes ${title}, at ${appUrl(name)}, with ${changed.map(([f]) => f).join(", ")}`
      : `your app ${title}: ${how === "restore" ? "restores an earlier" : "changes"} ${changed.map(([f]) => f).join(", ")}`;
    const before = changed.map(([f]) => shown(f, current.get(f))).join("\n");
    const after = changed.map(([f, text]) => shown(f, text)).join("\n");
    const reason = String(note ?? "").slice(0, 300) || (isNew ? "A new app" : "A change to the app");
    const big = tooBig(before, after);
    if (big) return { ok: false, error: `Nothing was saved. ${big}` };
    try {
      // Every save is asked about: no "Always allow", since each one is new code.
      await kernel.reviewed(instance, `make:${name}`, target, before, after, reason, dispatch, { once: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const by = nameOf(instance);
    const versions: Record<string, number> = {};
    const stale = await locked(name, async () => {
      // Only what the person saw: if a file changed while the card was open, nothing is written.
      for (const [f] of changed) if ((await read(name, f)) !== current.get(f)) return f;
      for (const [f, text] of changed) {
        await store.writeText(`${APPS}/${name}/${f}`, text);
        versions[f] = await remember(name, f, { by, note: reason, text });
      }
      return undefined;
    });
    // A running copy with other code is replaced, so every open tab runs the new code under the same id.
    if (!stale) for (const [f, text] of changed) if (f.endsWith(".js")) await replaceOld(name, f, text);
    if (stale) return { ok: false, error: `${stale} changed while the review was open, so nothing was saved. Read it again and try once more.` };
    if (isNew) await indexed(name, true);
    root.emit(dispatch, "maker:changed", { app: name, files: changed.map(([f]) => f) });
    const { problems } = checkFiles(await filesOf(name), rules(name), name);
    return { ok: true, url: appUrl(name), saved: changed.map(([f]) => f), versions, problems };
  }

  /** What went wrong while the app ran, once it opened again, for the plugins in it: from the moment it was asked to open, as a plugin may fail before the app has finished opening. */
  async function ran(name: string, files: Map<string, string>, plugins: { file: string; id: string; name: string }[], dispatch: { trace?: string }) {
    const since = recent().at(-1)?.seq ?? 0;
    root.emit(dispatch, "maker:check", { app: name });
    if (!plugins.length) return { ran: false, problems: [] as Problem[] };
    const ids = new Set(plugins.map((p) => p.id));
    const opened = () => recent().find((e) => e.seq > since && e.name === "app:open" && plugins.some((p) => e.detail?.includes(p.id) || e.detail?.includes(`/apps/${name}/${p.file}`)));
    const end = Date.now() + OPEN_MS;
    while (!opened() && Date.now() < end) await sleep(200);
    const open = opened();
    if (!open) return { ran: false, problems: [] as Problem[] };
    await sleep(SETTLE_MS);
    const tab = (open.detail ?? "").split(":")[0];
    const problems: Problem[] = [];
    const fileOf = (id: string) => plugins.find((p) => p.id === id)?.file ?? id;
    // Links that failed to start are listed in app:open as `href (why)`.
    for (const p of plugins) {
      const failed = new RegExp(`/apps/${name}/${p.file.replace(/\./g, "\\.")} \\(([^)]*)\\)`).exec(open.detail ?? "");
      if (failed) problems.push({ level: "error", file: p.file, message: `It didn't start: ${failed[1]}` });
    }
    const seen = new Set<string>();
    const events = recent().filter((e) => e.seq > since);
    // A plugin that never got going (refused, or a service it needs is missing) isn't running this code.
    for (const p of plugins) {
      if (problems.some((x) => x.file === p.file)) continue;
      const running = remote.installed.get(p.id);
      if (running && running.source === files.get(p.file)) continue;
      const why = events.find((e) => e.name === "plugin:refused" && (e.plugin === p.id || e.detail?.includes(p.name) || e.detail?.includes(p.id)))?.detail;
      problems.push({ level: "error", file: p.file, message: `It didn't start${why ? `: ${why}` : ""}` });
      seen.add(`${p.id} didn't start`);
    }
    // Problems in the page itself (a template or element that didn't load), reported by the preview's tab.
    for (const e of events) {
      if (e.kind !== "error" || !e.name.startsWith("page:") || !e.detail?.startsWith(`tab ${tab}:`)) continue;
      const file = plugins.find((p) => e.detail!.includes(p.file) || e.detail!.includes(p.file.replace(/\.js$/, ".html")))?.file ?? "app.html";
      const message = `${e.name}: ${e.detail.slice(`tab ${tab}:`.length).trim()}`;
      if (seen.has(message)) continue;
      seen.add(message);
      problems.push({ level: "error", file, message });
    }
    for (const e of events) {
      if (!e.plugin || !ids.has(base(e.plugin))) continue;
      // Only the tab that opened it: a preview opened and closed again meanwhile leaves its own complaints.
      if (e.plugin.includes("@") && e.plugin.split("@")[1] !== tab) continue;
      if (e.kind !== "error" && e.kind !== "denied") continue;
      // A start that timed out, as a preview opened twice in a row, is no problem if the plugin then started.
      if (e.name === "plugin:start-timeout" && recent().some((r) => r.seq > e.seq && r.name === "plugin:ready" && base(r.plugin ?? "") === base(e.plugin!))) continue;
      const message = e.kind === "denied" ? `It was refused ${e.name} (${e.detail ?? "missing capability"}): add it to permissions if it needs it` : `${e.name}: ${e.detail ?? ""}`;
      const key = `${base(e.plugin)} ${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ level: "error", file: fileOf(base(e.plugin)), message });
    }
    return { ran: true, problems: problems.slice(0, 30) };
  }

  const fileList: Param = {
    name: "files",
    schema: {
      type: "array",
      description: "The files to write, each whole: app.html, plugins (.js) and their templates (.html)",
      items: { type: "object", properties: { name: { type: "string" }, text: { type: "string" } }, required: ["name", "text"] },
    },
  };
  const note: Param = { name: "note", schema: { type: "string", description: "What this change does, for the person's review card and the file's history" }, optional: true };

  return {
    description: "Apps a person makes in the browser, kept on their device and served at /apps/<name>/: their files, saved after a review, each file's earlier versions, and checks of an app as written and as it runs.",
    methods: {
      list: { args: "()", returns: "[{ name, title, url, files }]", needs: "apps:read", description: "The apps the person has made.", params: [] },
      read: { args: "(app, file)", returns: "the file's text", needs: "apps:read", description: "One file of a made app, as it is now.", params: [app(), file] },
      save: {
        args: "(app, files, note?)",
        returns: "{ ok, url, saved, versions, problems } or { ok: false, error, problems? }",
        needs: "apps:make",
        reviewed: true,
        description: "Writes files of a made app, or makes a new one (its first save must hold app.html), once the person accepts one review that shows every change. Returns the checks of the app as saved.",
        params: [app(), fileList, note],
      },
      remove: {
        args: "(app, file?)",
        returns: "{ ok } or { ok: false, error }",
        needs: "apps:make",
        reviewed: true,
        description: "Removes one file of a made app, or with no file the whole app, once the person accepts. Its history is kept.",
        params: [app(), { ...file, optional: true }],
      },
      history: { args: "(app, file)", returns: "[{ version, at, by, note, removed? }]", needs: "apps:read", description: "The versions of one file of a made app, oldest first.", params: [app(), file] },
      version: { args: "(app, file, version)", returns: "the file's text at that version", needs: "apps:read", description: "One earlier version of a file.", params: [app(), file, { name: "version", schema: { type: "integer" } }] },
      restore: {
        args: "(app, file, version)",
        returns: "{ ok, versions } or { ok: false, error }",
        needs: "apps:make",
        reviewed: true,
        description: "Puts an earlier version of a file back, once the person accepts. It becomes the newest version, so it can be undone the same way.",
        params: [app(), file, { name: "version", schema: { type: "integer" } }],
      },
      check: {
        args: "(app)",
        returns: "{ ok, ran, problems: [{ level, file, line?, message }], plugins }",
        needs: "apps:read",
        description: "Checks a made app's files as the kernel will read them, then, if it is open (its preview reloads), what went wrong as it ran. ran is false if it isn't open anywhere. ok is true when there are no errors.",
        params: [app()],
      },
    },
    capability: (method) => (["save", "remove", "restore"].includes(method) ? "apps:make" : "apps:read"),
    call: async (instance, method, args, dispatch) => {
      if (method === "list") {
        const out = [];
        for (const name of await store.readJson<string[]>(INDEX, [])) {
          if (!APP_NAME.test(name)) continue;
          const html = await read(name, "app.html");
          if (html === undefined) continue;
          out.push({ name, title: pageParts(html).title || name, url: appUrl(name), files: [...(await filesOf(name)).keys()] });
        }
        return out;
      }
      const name = checkName(args[0]);
      if (method === "read") {
        const text = await read(name, checkFile(args[1]));
        if (text === undefined) throw new Error(`${name} has no ${String(args[1])}`);
        return text;
      }
      if (method === "save") return save(instance, name, args[1], args[2], dispatch);
      if (method === "history") return (await historyOf(name, checkFile(args[1]))).map(({ text: _text, ...v }) => v);
      if (method === "version" || method === "restore") {
        const f = checkFile(args[1]);
        const v = (await historyOf(name, f)).find((x) => x.version === args[2]);
        if (!v) throw new Error(`${f} has no version ${String(args[2])}`);
        if (method === "version") return v.text;
        if (v.removed) throw new Error(`Version ${v.version} of ${f} is its removal: restore the one before it`);
        return save(instance, name, [{ name: f, text: v.text }], `Back to version ${v.version}${v.note ? ` (${v.note})` : ""}`, dispatch, "restore");
      }
      if (method === "remove") {
        const current = await filesOf(name);
        if (!current.size) return { ok: false, error: `There is no app called ${name}` };
        const which = args[1] === undefined ? [...current.keys()] : [checkFile(args[1])];
        if (!which.every((f) => current.has(f))) return { ok: false, error: `${name} has no ${which.join(", ")}` };
        const title = pageParts(current.get("app.html") ?? "").title || name;
        try {
          await kernel.reviewed(instance, `make:${name}`, args[1] === undefined ? `your apps: removes ${title}` : `your app ${title}: removes ${which[0]}`, which.map((f) => shown(f, current.get(f))).join("\n"), "", "Its files go; their history is kept, so it can be put back", dispatch, { once: true });
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const by = nameOf(instance);
        const stale = await locked(name, async () => {
          // Remove only what the person saw: the same files, unchanged, and for the whole app no new ones.
          const now = await filesOf(name);
          if (args[1] === undefined && [...now.keys()].join() !== [...current.keys()].join()) return "The app's files changed while the review was open, so nothing was removed";
          for (const f of which) if (now.get(f) !== current.get(f)) return `${f} changed while the review was open, so nothing was removed`;
          for (const f of which) {
            await store.removeFile(`${APPS}/${name}/${f}`);
            if (f.endsWith(".js")) await replaceOld(name, f, "");
            await remember(name, f, { by, note: "Removed", text: current.get(f) ?? "", removed: true });
          }
          return undefined;
        });
        if (stale) return { ok: false, error: stale };
        if (!current.has("app.html") || which.includes("app.html")) await indexed(name, false);
        root.emit(dispatch, "maker:changed", { app: name, files: which, removed: true });
        return { ok: true };
      }
      if (method === "check") {
        const files = await filesOf(name);
        if (!files.size) throw new Error(`There is no app called ${name}`);
        const { problems, plugins } = checkFiles(files, rules(name), name);
        const running = await ran(name, files, plugins, dispatch);
        const all = [...problems, ...running.problems];
        return { ok: !all.some((p) => p.level === "error"), ran: running.ran, url: appUrl(name), problems: all, plugins, ...(running.ran ? {} : { note: "It isn't open anywhere, so only the files were checked. Open it, or its preview, to see it run." }) };
      }
      throw new Error(`maker.${method} is not a method`);
    },
  };

};

export default service("maker", make);
