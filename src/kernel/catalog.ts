// The plugins panel: a trusted plugin in the kernel worker that lists every
// plugin, turns them on and off, removes the ones kept with the data, and
// builds a settings form from each manifest's `settings`.
//
// Plugins come from two places. Built-in plugins ship with the app. Plugins
// installed at run time are kept in the data folder (`plugins/<id>.js`), so
// they travel with the data; one with the same id as a built-in replaces it.
// Which plugins are off, and every plugin's settings, are kept in
// `plugins.json` in the same folder.
//
// A plugin reads its own settings through the `settings` service (no
// capability needed: they are its own) and hears about changes as a
// `settings:changed` event.

import type { Dispatch, Manifest, View } from "../shared/protocol";
import type { Hosts } from "./hosts";
import { readManifest } from "./manifest";
import type { ChangeLog } from "./changes";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { placeLabel, type Reviews } from "./review";
import type { Store } from "./store";
import { record } from "./trace";

const FILE = "plugins.json";

/** A plugin's id, read the same way the kernel reads its manifest (without running it); "" if it has none. */
const idOf = (source: string) => {
  try {
    return readManifest(source).id;
  } catch {
    return "";
  }
};
const ORDER = 100;

type Values = Record<string, string | number | boolean>;
interface Saved {
  off: string[];
  settings: Record<string, Values>;
}

/** The saved state, or empty state for anything that isn't the right shape. */
function valid(value: unknown): Saved {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Saved>;
  const off = Array.isArray(v.off) ? v.off.filter((x): x is string => typeof x === "string") : [];
  const settings: Record<string, Values> = {};
  if (v.settings && typeof v.settings === "object" && !Array.isArray(v.settings)) {
    for (const [id, values] of Object.entries(v.settings)) if (values && typeof values === "object" && !Array.isArray(values)) settings[id] = values as Values;
  }
  return { off, settings };
}

export function catalog(remote: RemotePlugins, store: Store, hosts: Hosts, log: ChangeLog, reviews: Reviews) {
  let saved: Saved = { off: [], settings: {} };
  let loaded = false;
  /** Settles once the saved state has been read, so `isOff` can wait for it. */
  let markLoaded!: () => void;
  const savedRead = new Promise<void>((resolve) => (markLoaded = resolve));
  /** True while the plugins already in the app start up; those aren't changes worth logging. */
  let booting = true;
  const errors = new Map<string, string>();

  // Every write to the data folder goes through one queue, in order, so an
  // older write can't land after a newer one. Failures are traced, not lost.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (what: string, task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task);
    queue = run.catch((error) => record({ kind: "error", name: "plugins:write-failed", detail: `${what}: ${error instanceof Error ? error.message : error}` }));
    return run;
  };
  const persist = () => {
    const snapshot = JSON.parse(JSON.stringify(saved)) as Saved;
    return enqueue(FILE, () => store.writeJson(FILE, snapshot));
  };

  /**
   * A plugin's settings: its saved values over the manifest's defaults. Both
   * are checked against the current manifest, since a replacement plugin may
   * have changed a setting's type or choices; a value that no longer fits
   * falls back to the default, then to the type's empty value.
   */
  const settingsFor = (id: string): Values => {
    const manifest = remote.installed.get(id)?.manifest;
    const values: Values = {};
    for (const [key, s] of Object.entries(manifest?.settings ?? {})) {
      const empty = s.type === "boolean" ? false : s.type === "number" ? 0 : (s.enum?.[0] ?? "");
      const fits = (value: unknown) => {
        if (value === undefined) return undefined;
        const result = coerce(manifest!, key, value);
        return "value" in result && (s.type !== "boolean" || typeof value === "boolean") ? result.value : undefined;
      };
      values[key] = fits(saved.settings[id]?.[key]) ?? fits(s.default) ?? empty;
    }
    return values;
  };

  /** Checks a value against the manifest; returns the value to keep, or an error. */
  function coerce(manifest: Manifest, key: string, value: unknown): { value: string | number | boolean } | { error: string } {
    const spec = manifest.settings?.[key];
    if (!spec) return { error: `${manifest.id} has no setting ${key}` };
    if (spec.type === "boolean") return typeof value === "boolean" ? { value } : { error: `${key} must be on or off` };
    if (spec.type === "number") {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? { value: n } : { error: `${key} must be a number` };
    }
    const text = String(value ?? "");
    if (spec.enum && !spec.enum.includes(text)) return { error: `${key} must be one of ${spec.enum.join(", ")}` };
    return { value: text.slice(0, 2000) };
  }

  const view = (id: string): View | null => {
    const plugin = remote.installed.get(id);
    if (!plugin) return null;
    const { manifest, origin, enabled } = plugin;
    const values = settingsFor(id);
    const fields: View[] = Object.entries(manifest.settings ?? {}).map(([key, spec]) => ({
      type: "field",
      name: key,
      label: spec.title ?? key,
      description: spec.description,
      kind: spec.type === "boolean" ? "checkbox" : spec.type === "number" ? "number" : spec.enum ? "select" : "text",
      options: spec.enum,
      value: values[key],
      action: `set:${id}:${key}`,
    }));
    const error = errors.get(id);
    return {
      type: "stack",
      children: [
        {
          type: "stack",
          direction: "row",
          children: [
            { type: "text", text: manifest.name, title: manifest.description },
            { type: "text", text: origin === "built-in" ? "built in" : origin === "app" ? "from an open app" : "with the data", tone: "muted" },
            ...(enabled ? [] : [{ type: "text" as const, text: "off", tone: "muted" as const }]),
          ],
        },
        ...(enabled ? fields : []),
        ...reviews.grantsFor(id).map((place): View => ({
          type: "stack",
          direction: "row",
          children: [
            { type: "text", text: `Changes ${placeLabel(place)} without asking`, tone: "muted" },
            { type: "button", label: "Forget", action: `forget:${id}:${place}` },
          ],
        })),
        ...(error ? [{ type: "text" as const, text: error, tone: "error" as const }] : []),
        {
          type: "stack",
          direction: "row",
          children: [
            { type: "button", label: enabled ? "Turn off" : "Turn on", action: `toggle:${id}` },
            ...(origin === "data" ? [{ type: "button" as const, label: "Remove", action: `remove:${id}` }] : []),
          ],
        },
      ],
    };
  };

  const draw = (id: string) => hosts.render("plugins", "side", `plugins:${id}`, view(id), ORDER + 1);
  const drawAll = () => {
    hosts.render("plugins", "side", "plugins:heading", { type: "heading", text: "Plugins" }, ORDER);
    for (const id of remote.installed.keys()) draw(id);
  };

  reviews.onGrants = (id) => draw(id);

  /** Where each installed plugin came from, kept so it is still known once the plugin is gone. */
  const origins = new Map<string, string>();

  remote.onChange = (change, id) => {
    if (!booting || change !== "install") void log.append({ kind: change, plugin: id });
    if (change === "install") origins.set(id, remote.installed.get(id)?.origin ?? "data");
    if (change === "uninstall" || change === "disable") reviews.cancel(id);
    if (change === "uninstall") {
      hosts.render("plugins", "side", `plugins:${id}`, null, ORDER + 1);
      // A plugin kept with the data that leaves (removed, or stopped for lying about its manifest) leaves the data folder too.
      if (origins.get(id) === "data") void enqueue(`remove ${id}`, () => store.removePlugin(id)).catch(() => {});
      origins.delete(id);
      return;
    }
    if (loaded && (change === "enable" || change === "disable")) {
      saved.off = saved.off.filter((x) => x !== id);
      if (change === "disable") saved.off.push(id);
      void persist().catch(() => {});
    }
    draw(id);
  };

  /** Installs a plugin at run time and keeps it in the data folder. */
  const install = async (source: string) => {
    const result = await remote.install(source, { origin: "data" });
    // Saved only if it is still installed: one stopped for changing its manifest is not kept.
    if (result.ok && remote.installed.get(result.id)?.origin === "data") {
      try {
        await enqueue(`save ${result.id}`, () => store.savePlugin(result.id, source));
      } catch (error) {
        return { ...result, error: `Installed, but not kept with the data: ${error instanceof Error ? error.message : error}` };
      }
    }
    return result;
  };

  /** Removes a plugin kept with the data. Resolves once its file is gone. */
  const remove = async (id: string): Promise<boolean> => {
    if (remote.installed.get(id)?.origin !== "data") return false;
    remote.uninstall(id); // queues the file's removal (see onChange)
    delete saved.settings[id];
    saved.off = saved.off.filter((x) => x !== id);
    try {
      await persist();
      return true;
    } catch {
      return false;
    }
  };

  const set = (id: string, key: string, value: unknown, d: Dispatch) => {
    const plugin = remote.installed.get(id);
    if (!plugin) return;
    const result = coerce(plugin.manifest, key, value);
    if ("error" in result) {
      errors.set(id, result.error);
      record({ kind: "error", name: "settings:refused", plugin: id, trace: d.trace, detail: result.error });
    } else {
      errors.delete(id);
      saved.settings[id] = { ...saved.settings[id], [key]: result.value };
      void persist().catch(() => {});
      record({ kind: "note", name: "settings:changed", plugin: id, trace: d.trace, detail: `${key} = ${JSON.stringify(result.value)}` });
      void log.append({ kind: "settings", plugin: id, detail: `${key} = ${JSON.stringify(result.value)}`, trace: d.trace });
      const values = settingsFor(id);
      for (const instance of remote.instances(id)) remote.deliver(instance, { t: "event", action: "settings:changed", value: values, trace: d.trace });
    }
    draw(id);
  };

  const service: ServiceProvider = {
    description: "The plugin's own settings, from the form the plugins panel builds out of its manifest.",
    methods: {
      get: { args: "()", returns: "{ [key]: value }", description: "The plugin's settings: saved values over the manifest's defaults." },
    },
    capability: () => undefined,
    call: (instance, method) => {
      if (method === "get") return settingsFor(instance.split("@")[0]);
      throw new Error(`settings.${method} is not a method`);
    },
  };

  return {
    service,
    install,
    remove,
    /** Whether the person turned this plugin off. Waits for the saved state, so an app opened early still honours it. */
    async isOff(id: string): Promise<boolean> {
      await savedRead;
      return saved.off.includes(id);
    },
    /** Turns plugins back on, whether or not they are installed yet: an app's plugins are installed only once it opens. */
    async turnOn(ids: string[]): Promise<void> {
      await savedRead;
      const wasOff = ids.filter((id) => saved.off.includes(id));
      if (!wasOff.length) return;
      saved.off = saved.off.filter((id) => !ids.includes(id));
      for (const id of wasOff) if (remote.installed.has(id)) void remote.setEnabled(id, true);
      await persist().catch(() => {});
    },
    /** Installs the built-in plugins and the ones in the data folder, then draws the panel. */
    async load(builtIn: string[]) {
      saved = valid(await store.readJson<unknown>(FILE, null));
      // From here on, turning a plugin on or off is saved, even while others are still starting.
      loaded = true;
      markLoaded();
      const stored = await store.pluginSources();
      const off = new Set(saved.off);
      const storedIds = new Set(stored.map(idOf));
      drawAll();
      await Promise.all([
        // A plugin in the data folder replaces the built-in one with the same id.
        ...builtIn.filter((source) => !storedIds.has(idOf(source))).map((source) => remote.install(source, { origin: "built-in", enabled: !off.has(idOf(source)) })),
        ...stored.map((source) => remote.install(source, { origin: "data", enabled: !off.has(idOf(source)) })),
      ]);
      booting = false;
      record({ kind: "lifecycle", name: "plugins:loaded", detail: `${builtIn.length} built in, ${stored.length} with the data, ${off.size} off` });
    },
    event(action: string, value: unknown, trace: string) {
      const d = { trace };
      // `set:<id>:<key>`: ids have no colons, but setting keys may.
      const [verb, id] = action.split(":", 2);
      if (verb === "toggle") return void remote.setEnabled(id, !remote.installed.get(id)?.enabled);
      if (verb === "remove") return void remove(id);
      if (verb === "set") return set(id, action.slice(verb.length + id.length + 2), value, d);
      if (verb === "forget") return void reviews.forget(id, action.slice(verb.length + id.length + 2), trace);
    },
  };
}
