// The `files` service. Text files in the data folder, with every path checked first.
// Found by name: this file is src/kernel/services/files.ts, so it is `ctx.call("files", …)`.

import { checkPath, PathError } from "../paths";
import { record } from "../trace";
import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

export default ({ store, reviewed }: Kernel): ServiceProvider => {
  return {
    description: "Text files in the data folder. A path is checked first: no `..`, no hidden names, nothing in the platform's own folders.",
    methods: {
      read: { args: "(path)", returns: "text or null", needs: "files:<folder>", description: "Reads a file. `<folder>` is the path's first folder." },
      write: { args: "(path, text, reason)", returns: "{ ok, path, outcome } or { ok, unchanged }", needs: "files:<folder>", reviewed: true, description: "Writes a file, up to 5 MB. Fails if the person declines, nobody answers, or the file changed while the review was open." },
    },
    /** Each folder is its own capability: `files:exports` lets a plugin use `exports/...`. */
    capability: (_method, args) => `files:${typeof args[0] === "string" ? args[0].split("/")[0] : ""}`,
    call: async (plugin, method, args, dispatch) => {
      let path: string;
      try {
        path = checkPath(args[0]).join("/");
      } catch (error) {
        if (error instanceof PathError) record({ kind: "denied", name: "files:path", plugin, trace: dispatch.trace, detail: error.message });
        throw error;
      }
      if (method === "read") return (await store.readText(path)) ?? null;
      if (method !== "write") throw new Error(`files.${method} is not a method`);
      const text = args[1];
      if (typeof text !== "string") throw new Error("files.write takes (path, text, reason)");
      if (text.length > 5_000_000) throw new Error("The file is too large");
      const existing = await store.readText(path);
      if (existing === text) return { ok: true, unchanged: true };
      const outcome = await reviewed(plugin, `files:${path.split("/")[0]}`, path, existing ?? "", text, args[2], dispatch);
      // Written only if the file is still what the person reviewed (or still missing).
      await store.writeText(path, text, existing ?? null);
      return { ok: true, path, outcome };
    },
  };
};
