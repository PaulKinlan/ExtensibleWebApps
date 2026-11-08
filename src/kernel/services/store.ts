// The `store` service. The notes. A plugin's change to one is reviewed first.
// Found by name: this file is src/kernel/services/store.ts, so it is `ctx.call("store", …)`.

import type { Kernel } from "./index";
import type { ServiceProvider } from "../remote";

const titleOf = (text: string) => text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60) || "Untitled";

export default ({ store, reviewed }: Kernel): ServiceProvider => {
  return {
    description: "The notes. They belong to the notes app, so a plugin's change to one is reviewed first.",
    methods: {
      list: { args: "()", returns: "[{ id, title, text, updated }]", needs: "data:read:notes", description: "Every note, most recently changed first." },
      put: { args: "({ id?, text }, reason)", returns: "{ ok, id, outcome }", needs: "data:write:notes", reviewed: true, description: "Creates or replaces a note. Fails if the person declines, nobody answers in five minutes, or the note changed while the review was open." },
    },
    capability: (method) => (method === "list" ? "data:read:notes" : "data:write:notes"),
    /** `put({ id?, text }, reason)`: notes belong to the notes app, so a plugin's write is reviewed first. */
    call: async (plugin, method, args, dispatch) => {
      if (method === "list") return store.list();
      if (method !== "put") throw new Error(`store.${method} is not a method`);
      const [input, reason] = args as [{ id?: unknown; text?: unknown }, unknown];
      if (!input || typeof input.text !== "string") throw new Error("store.put takes { id?, text }");
      const id = typeof input.id === "string" && /^[\w-]{1,64}$/.test(input.id) ? input.id : Math.random().toString(36).slice(2, 8);
      const before = store.get(id);
      const title = titleOf(input.text);
      const outcome = await reviewed(plugin, "notes", `the note “${before?.title ?? title}”`, before?.text ?? "", input.text, reason, dispatch);
      // Only if the note is still what the person reviewed.
      const result = await store.put({ id, title, text: input.text, updated: Date.now() }, dispatch, before?.text ?? null);
      if (!result.ok) throw new Error(`Not saved: ${result.reason}`);
      return { ok: true, id, outcome };
    },
  };
};
