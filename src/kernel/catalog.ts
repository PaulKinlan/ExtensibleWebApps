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
import type { RemotePlugins, ServiceProvider } from "./remote";
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

export function catalog(remote: RemotePlugins, store: Store, hosts: Hosts) {
  let saved: Saved = { off: [], settings: {} };
  let loaded = false;
  const errors = new Map<string, string>();

  const persist = () => store.writeJson(FILE, saved);

  /** A plugin's settings: its saved values over the manifest's defaults. */
  const settingsFor = (id: string): Values => {
    const spec = remote.installed.get(id)?.manifest.settings ?? {};
    const values: Values = {};
    for (const [key, s] of Object.entries(spec)) {
      const value = saved.settings[id]?.[key] ?? s.default ?? (s.type === "boolean" ? false : s.type === "number" ? 0 : (s.enum?.[0] ?? ""));
      values[key] = value as string | number | boolean;
    }
    return values;
  };

  /** Checks a value against the manifest; returns the value to keep, or an error. */
  const coerce = (manifest: Manifest, key: string, value: unknown): { value: string | number | boolean } | { error: string } => {
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
  };

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
            { type: "text", text: origin === "built-in" ? "built in" : "with the data", tone: "muted" },
            ...(enabled ? [] : [{ type: "text" as const, text: "off", tone: "muted" as const }]),
          ],
        },
        ...(enabled ? fields : []),
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

  const draw = (id: string) => hosts.render("plugins", "app.side", `plugins:${id}`, view(id), ORDER + 1);
  const drawAll = () => {
    hosts.render("plugins", "app.side", "plugins:heading", { type: "heading", text: "Plugins" }, ORDER);
    for (const id of remote.installed.keys()) draw(id);
  };

  remote.onChange = (change, id) => {
    if (change === "uninstall") {
      hosts.render("plugins", "app.side", `plugins:${id}`, null, ORDER + 1);
      // A plugin that leaves (removed, or stopped for lying about its manifest) leaves the data folder too.
      void store.removePlugin(id);
      return;
    }
    if (loaded && (change === "enable" || change === "disable")) {
      saved.off = saved.off.filter((x) => x !== id);
      if (change === "disable") saved.off.push(id);
      void persist();
    }
    draw(id);
  };

  /** Installs a plugin at run time and keeps it in the data folder. */
  const install = async (source: string) => {
    const result = await remote.install(source, { origin: "data" });
    // Saved only if it is still installed: one stopped for changing its manifest is not kept.
    if (result.ok && remote.installed.get(result.id)?.origin === "data") await store.savePlugin(result.id, source);
    return result;
  };

  const remove = (id: string) => {
    if (remote.installed.get(id)?.origin !== "data") return false;
    remote.uninstall(id);
    delete saved.settings[id];
    saved.off = saved.off.filter((x) => x !== id);
    void persist();
    return true;
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
      void persist();
      record({ kind: "note", name: "settings:changed", plugin: id, trace: d.trace, detail: `${key} = ${JSON.stringify(result.value)}` });
      const values = settingsFor(id);
      for (const instance of remote.instances(id)) remote.deliver(instance, { t: "event", action: "settings:changed", value: values, trace: d.trace });
    }
    draw(id);
  };

  const service: ServiceProvider = {
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
    /** Installs the built-in plugins and the ones in the data folder, then draws the panel. */
    async load(builtIn: string[]) {
      saved = await store.readJson<Saved>(FILE, { off: [], settings: {} });
      saved.off ??= [];
      saved.settings ??= {};
      const stored = await store.pluginSources();
      const off = new Set(saved.off);
      const storedIds = new Set(stored.map(idOf));
      drawAll();
      await Promise.all([
        // A plugin in the data folder replaces the built-in one with the same id.
        ...builtIn.filter((source) => !storedIds.has(idOf(source))).map((source) => remote.install(source, { origin: "built-in", enabled: !off.has(idOf(source)) })),
        ...stored.map((source) => remote.install(source, { origin: "data", enabled: !off.has(idOf(source)) })),
      ]);
      loaded = true;
      record({ kind: "lifecycle", name: "plugins:loaded", detail: `${builtIn.length} built in, ${stored.length} with the data, ${off.size} off` });
    },
    event(action: string, value: unknown, trace: string) {
      const d = { trace };
      const [verb, id, key] = action.split(":");
      if (verb === "toggle") return void remote.setEnabled(id, !remote.installed.get(id)?.enabled);
      if (verb === "remove") return void remove(id);
      if (verb === "set" && key) return set(id, key, value, d);
    },
  };
}
