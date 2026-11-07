// The app's plugin: owns the `items` collection and draws them as a list
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
    items: {
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

export default async function (ctx) {
  const views = ctx.ui.views("main.html");

  views.live("main", "items", async (ctx) => {
    const items = await ctx.call("data", "list", "items");
    return { items: items.sort((a, b) => Number(a.done ?? false) - Number(b.done ?? false) || a.title.localeCompare(b.title)) };
  });

  // "done:<id>" comes from an item's checkbox, with true or false; "remove:<id>" from its button.
  ctx.ui.onEvent(async (action, value) => {
    const [verb, id] = action.split(":");
    if (verb === "done") {
      const item = await ctx.call("data", "get", "items", id);
      if (item) await ctx.call("data", "put", "items", { ...item, done: value === true });
    }
    if (verb === "remove") await ctx.call("data", "delete", "items", id);
  });
}
