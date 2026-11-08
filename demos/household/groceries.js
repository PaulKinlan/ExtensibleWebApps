// Groceries: owns the `groceries` collection, the house's shopping list.
// Each item says who added it and, once it's in someone's basket, who got
// it. Who "I" am comes from the bus topic `household-me`, which
// housemates.js posts to when the person says who is using this device.
//
// In a space every phone has a copy: an item added on one shows on the
// others, and one ticked off while offline is sent when the phone is back.
// If two people get the same thing while apart, the space keeps the first
// change it hears, and the other phone keeps its version as a draft, which
// std/sync.js shows ("Use mine" or "Keep theirs").

export const manifest = {
  id: "groceries",
  name: "Shopping list",
  description: "What the house needs, who added it, and who got it.",
  version: "1.0.0",
  permissions: ["ui", "bus:read:household-me", "hook:listen:bus:posted"],
  collections: {
    groceries: {
      title: "Shopping list",
      schema: {
        type: "object",
        required: ["item"],
        properties: {
          item: { type: "string", title: "Item", maxLength: 120 },
          got: { type: "boolean", title: "Got it" },
          addedBy: { type: "string", title: "Added by", maxLength: 40 },
          gotBy: { type: "string", title: "Got by", maxLength: 40 },
        },
      },
    },
  },
};

// Fixed ids, so phones that each start the list in a space add the same two items, once.
const SAMPLE = [
  { id: "sample-milk", item: "Milk" },
  { id: "sample-bread", item: "Bread" },
];

/** This device's person's name, from the latest post on the topic, or "" before they've said. */
async function myName(ctx) {
  const posts = await ctx.call("bus", "read", "household-me");
  try {
    return (posts.length && JSON.parse(posts[posts.length - 1].text)?.name) || "";
  } catch {
    return "";
  }
}

export default async function (ctx) {
  const views = ctx.ui.views("groceries.html");
  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "groceries")).length) for (const item of SAMPLE) await ctx.call("data", "put", "groceries", item);
    await ctx.storage.set("seeded", true);
  }
  /** Bumped after each add, so the template's form is drawn fresh, with its field empty. */
  let added = 0;

  const view = views.live("groceries", "list", async (ctx) => {
    const items = await ctx.call("data", "list", "groceries");
    const me = await myName(ctx);
    const by = (name) => (name && name === me ? "you" : name);
    const shown = (i) => ({ id: i.id, item: i.item, got: !!i.got, added: by(i.addedBy), gotBy: by(i.gotBy) });
    // Oldest first, as a list is written; what's been got goes to the bottom.
    const oldest = (a, b) => a.createdAt.localeCompare(b.createdAt);
    const toGet = items.filter((i) => !i.got).sort(oldest).map(shown);
    const got = items.filter((i) => i.got).sort(oldest).map(shown);
    return { toGet, got, empty: !items.length, form: `add-${added}` };
  });

  // The names change when the person says who they are.
  ctx.on("bus:posted", ({ topic }) => topic === "household-me" && view.refresh());

  ctx.ui.onEvent(async (action, value) => {
    const me = await myName(ctx);
    if (action === "add" && value.item?.trim()) {
      await ctx.call("data", "put", "groceries", { item: value.item.trim(), ...(me ? { addedBy: me } : {}) });
      added++;
      view.refresh();
    }
    // "got:<id>" with true or false from the item's checkbox.
    if (action.startsWith("got:")) {
      const item = await ctx.call("data", "get", "groceries", action.slice(4));
      if (!item) return;
      const { gotBy, ...rest } = item;
      await ctx.call("data", "put", "groceries", value === true ? { ...rest, got: true, ...(me ? { gotBy: me } : {}) } : { ...rest, got: false });
    }
    if (action === "clear") {
      for (const item of await ctx.call("data", "list", "groceries")) if (item.got) await ctx.call("data", "delete", "groceries", item.id);
    }
  });

  ctx.commands.add({ id: "clear-got", title: "Clear what's been got from the shopping list" }, async () => {
    let n = 0;
    for (const item of await ctx.call("data", "list", "groceries")) if (item.got && (await ctx.call("data", "delete", "groceries", item.id)).ok) n++;
    return `Cleared ${n} ${n === 1 ? "item" : "items"}`;
  });
}
