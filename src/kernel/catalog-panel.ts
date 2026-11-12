// The workbench's plugins panel: one view for each installed plugin, with its settings, what it may change
// without asking, and its switch. Only the workbench shows it, so the kernel fetches this the first time a
// workbench is open (catalog.ts), and an app's kernel never does.

import type { Dispatch, Manifest, View } from "../shared/protocol";
import type { ChangeLog } from "./changes";
import type { Installed, RemotePlugins } from "./remote";
import { placeLabel, type Reviews } from "./review";
import { record } from "./trace";

type Values = Record<string, string | number | boolean>;
/** What the catalog lends the panel to change a setting: its saved settings, and how it checks and keeps them. */
interface Catalog {
  remote: RemotePlugins;
  coerce(manifest: Manifest, key: string, value: unknown): { value: string | number | boolean } | { error: string };
  errors: Map<string, string>;
  settings: Record<string, Values>;
  persist(): Promise<void>;
  log: ChangeLog;
  settingsFor(id: string): Values;
  remove(id: string): Promise<boolean>;
  reviews: Reviews;
}

/** What was pressed or changed in the panel. Answers the plugin whose view must be drawn again, if one must. */
export function panelEvent(catalog: Catalog, action: string, value: unknown, trace: string): string | undefined {
  // `set:<id>:<key>`: ids have no colons, but setting keys may.
  const [verb, id] = action.split(":", 2);
  const rest = action.slice(verb.length + id.length + 2);
  if (verb === "toggle") void catalog.remote.setEnabled(id, !catalog.remote.installed.get(id)?.enabled);
  if (verb === "remove") void catalog.remove(id);
  if (verb === "forget") void catalog.reviews.forget(id, rest, trace);
  if (verb !== "set") return;
  setSetting(catalog, id, rest, value, { trace });
  return id;
}

/** Keeps a setting the person changed in the panel, and tells the plugin; one the manifest doesn't allow is shown as an error there. */
function setSetting({ remote, coerce, errors, settings, persist, log, settingsFor }: Catalog, id: string, key: string, value: unknown, d: Dispatch): void {
  const plugin = remote.installed.get(id);
  if (!plugin) return;
  const result = coerce(plugin.manifest, key, value);
  if ("error" in result) {
    errors.set(id, result.error);
    record({ kind: "error", name: "settings:refused", plugin: id, trace: d.trace, detail: result.error });
    return;
  }
  errors.delete(id);
  settings[id] = { ...settings[id], [key]: result.value };
  void persist().catch(() => {});
  record({ kind: "note", name: "settings:changed", plugin: id, trace: d.trace, detail: `${key} = ${JSON.stringify(result.value)}` });
  void log.append({ kind: "settings", plugin: id, detail: `${key} = ${JSON.stringify(result.value)}`, trace: d.trace });
  const values = settingsFor(id);
  for (const instance of remote.instances(id)) remote.deliver(instance, { t: "event", action: "settings:changed", value: values, trace: d.trace });
}

export function panelView(plugin: Installed, values: Record<string, string | number | boolean>, grants: string[], error?: string): View {
  const { manifest, origin, enabled } = plugin;
  const id = manifest.id;
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
      ...grants.map((place): View => ({
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
  }
