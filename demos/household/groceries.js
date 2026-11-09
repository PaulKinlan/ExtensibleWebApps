// Groceries: owns the `groceries` collection, the house's shopping list.
// Each item says who added it and, once it's in someone's basket, who got
// it. In a space that's the member's id, which the space vouches for, shown
// as the name on their account (sync.members); see housemates.js.
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
  permissions: ["ui", "members", "hook:listen:members:changed", "bus:read:household-new", "hook:listen:bus:posted"],
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

// Fixed ids, so two phones that start a new household at once add the same two items, once.
const SAMPLE = [
  { id: "sample-milk", item: "Milk" },
  { id: "sample-bread", item: "Bread" },
];

/**
 * Who is using this device, and everyone's names: in a space, the space's members (sync.members), so a
 * stamp is a member's id and shows as the name on their account. On its own there's one person, "me".
 */
async function people(ctx) {
  const { space, you, members } = await ctx.call("sync", "members");
  if (!space) return { me: "me", name: () => "you" };
  const names = Object.fromEntries(members.map((m) => [m.id, m.name]));
  // Someone who has left the space, or a stamp from before names came from accounts, is "someone".
  return { me: you ?? "", name: (id) => (id === you ? "you" : names[id] ?? "someone") };
}

/**
 * Whether to add the sample items: only in a new household (housemates.js says, on the bus topic
 * `household-new`), with nothing in the collection yet. This plugin's own `seeded` flag, which stays on
 * the device, keeps it from adding them twice.
 */
async function seedOnce(ctx, collection, samples) {
  if (await ctx.storage.get("seeded")) return;
  const posts = await ctx.call("bus", "read", "household-new");
  if (!posts.length) return;
  let fresh = false;
  try {
    fresh = JSON.parse(posts[posts.length - 1].text)?.new === true;
  } catch {}
  await ctx.storage.set("seeded", true);
  if (fresh && !(await ctx.call("data", "list", collection)).length) for (const sample of samples) await ctx.call("data", "put", collection, sample);
}

export default async function (ctx) {
  const views = ctx.ui.views("groceries.html");
  await seedOnce(ctx, "groceries", SAMPLE);
  /** Bumped after each add, so the template's form is drawn fresh, with its field empty. */
  let added = 0;

  const view = views.live("groceries", "list", async (ctx) => {
    const items = await ctx.call("data", "list", "groceries");
    const { name } = await people(ctx);
    const by = (id) => (id ? name(id) : "");
    const shown = (i) => ({ id: i.id, item: i.item, got: !!i.got, added: by(i.addedBy), gotBy: by(i.gotBy) });
    // Oldest first, as a list is written; what's been got goes to the bottom.
    const oldest = (a, b) => a.createdAt.localeCompare(b.createdAt);
    const toGet = items.filter((i) => !i.got).sort(oldest).map(shown);
    const got = items.filter((i) => i.got).sort(oldest).map(shown);
    return { toGet, got, empty: !items.length, form: `add-${added}` };
  });

  // Names arrive when the page reaches the space; samples once housemates.js says the household is new.
  ctx.on("members:changed", () => view.refresh());
  ctx.on("bus:posted", ({ topic }) => topic === "household-new" && seedOnce(ctx, "groceries", SAMPLE));

  ctx.ui.onEvent(async (action, value) => {
    const { me } = await people(ctx);
    if (action === "add" && value.item?.trim()) {
      const saved = await ctx.call("data", "put", "groceries", { item: value.item.trim(), ...(me ? { addedBy: me } : {}) });
      // A refused add (a data:beforeWrite listener blocked it, say) keeps what was typed.
      if (!saved.ok) return;
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
