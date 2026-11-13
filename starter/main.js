// @ts-check
// The app's plugin: owns the `my-app-items` collection and draws its items as a list
// you can tick off, add to and remove from. The list is a live view: the
// function given to views.live reads the items, so any change to them, from
// this tab or another, draws it again.

export const manifest = {
  id: "my-app",
  name: "My app",
  description: "A list to start from.",
  version: "0.1.0",
  permissions: ["ui"],
  collections: {
    "my-app-items": {
      title: "Items",
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Item", maxLength: 200 },
          done: { type: "boolean", title: "Done" },
        },
      },
    },
  },
};

// Collections belong to the whole site, not one app, so the collection is
// named after the app: two apps made from this starter each keep their own.

/**
 * `.extensible/types.d.ts` is written by `npm run dev`, `check` and `test`;
 * the fallback keeps `// @ts-check` clean before any of them has run.
 * @typedef {typeof globalThis extends { __extensibleApi: infer A } ? A : {
 *   call(service: "data", method: "list", collection: string): Promise<Array<Record<string, any>>>;
 *   call(service: string, method: string, ...args: any[]): Promise<any>;
 *   ui: {
 *     views(file: string): {
 *       render(slot: string, id: string, data?: unknown): void;
 *       live(slot: string, id: string, compute: (ctx: PluginApi) => unknown): { refresh(): void; stop(): void };
 *     };
 *     onEvent(handler: (action: string, value: any) => unknown): () => void;
 *   };
 * }} PluginApi
 */

/** @param {PluginApi} ctx */
export default async function (ctx) {
  const views = ctx.ui.views("main.html");

  views.live("main", "items", async (ctx) => {
    const items = await ctx.call("data", "list", "my-app-items");
    return { items: items.sort((a, b) => Number(a.done ?? false) - Number(b.done ?? false) || String(a.title ?? "").localeCompare(String(b.title ?? ""))) };
  });

  // "done:<id>" comes from an item's checkbox, with true or false; "remove:<id>" from its button.
  ctx.ui.onEvent(async (action, value) => {
    const [verb, id] = action.split(":");
    if (verb === "done" && id) {
      const item = await ctx.call("data", "get", "my-app-items", id);
      if (item) await ctx.call("data", "put", "my-app-items", { ...item, done: value === true });
    }
    if (verb === "remove" && id) await ctx.call("data", "delete", "my-app-items", id);
  });
}
