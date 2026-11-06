// The change log: every install, removal, on/off switch, settings change,
// grant and reviewed write, appended in order and kept with the data
// (`changes.json`, the most recent 500 entries). It answers "what changed,
// who changed it, and did the person agree?".

import type { Store } from "./store";
import { record } from "./trace";

const FILE = "changes.json";
const KEEP = 500;

export interface ChangeEntry {
  at: string; // ISO time
  kind: "install" | "uninstall" | "enable" | "disable" | "settings" | "grant" | "revoke" | "write";
  plugin: string;
  detail?: string;
  /** For reviewed writes: what the person decided. */
  outcome?: "allowed-once" | "allowed-always" | "granted" | "rejected" | "cancelled";
  trace?: string;
}

export function changeLog(store: Store) {
  let entries: ChangeEntry[] = [];
  const loaded = store.readJson<unknown>(FILE, []).then((saved) => {
    if (Array.isArray(saved)) entries = [...saved.filter((e) => e && typeof e === "object"), ...entries].slice(-KEEP) as ChangeEntry[];
  });
  return {
    async append(entry: Omit<ChangeEntry, "at">) {
      const full: ChangeEntry = { at: new Date().toISOString(), ...entry };
      await loaded;
      entries.push(full);
      if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
      record({ kind: "note", name: `change:${entry.kind}`, plugin: entry.plugin, trace: entry.trace, detail: [entry.detail, entry.outcome].filter(Boolean).join(" · ") });
      await store.writeJson(FILE, entries).catch((error) => record({ kind: "error", name: "changes:write-failed", detail: String(error) }));
    },
    async list(): Promise<ChangeEntry[]> {
      await loaded;
      return [...entries];
    },
  };
}

export type ChangeLog = ReturnType<typeof changeLog>;
