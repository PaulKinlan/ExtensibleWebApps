// Expenses: a table and a form, drawn from data. The expenses live in a
// collection this plugin owns; the view is a template in expenses.html,
// filled with the records and drawn again whenever the collection changes. The host updates
// the page in place, so typing, focus and scroll survive each redraw. A form
// with data-action sends all of its named fields, typed, and the plugin
// saves them.

export const manifest = {
  id: "expenses",
  name: "Expenses",
  description: "The expenses, in a table, with a form to add one.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 20,
  collections: {
    expenses: {
      title: "Expenses",
      schema: {
        type: "object",
        required: ["item", "amount", "category"],
        properties: {
          item: { type: "string", maxLength: 80 },
          amount: { type: "number", minimum: 0 },
          category: { type: "string", enum: ["Food", "Home", "Travel", "Fun"] },
          repeats: { type: "boolean", title: "Repeats monthly" },
        },
      },
    },
  },
};

const SAMPLE = [
  { item: "Groceries", category: "Food", amount: 182.4 },
  { item: "Rent", category: "Home", amount: 1250, repeats: true },
  { item: "Train pass", category: "Travel", amount: 96, repeats: true },
  { item: "Books", category: "Fun", amount: 34.99 },
];
const CATEGORIES = manifest.collections.expenses.schema.properties.category.enum;
const money = (n) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function (ctx) {
  const views = ctx.ui.views("expenses.html");
  // The samples go in once; a flag in the plugin's own storage keeps deleted expenses deleted.
  if (!(await ctx.storage.get("seeded"))) {
    for (const e of SAMPLE) await ctx.call("data", "put", "expenses", e);
    await ctx.storage.set("seeded", true);
  }
  let error = "";

  const draw = async () => {
    const expenses = await ctx.call("data", "list", "expenses");
    views.render("main", "list", {
      expenses: expenses.map((e) => ({ id: e.id, item: e.item, category: e.category, amount: money(e.amount), repeats: !!e.repeats })),
      categories: CATEGORIES,
      error,
    });
  };

  ctx.ui.onEvent(async (action, value) => {
    if (action === "add") {
      // value is { item, amount, category, repeats }, already typed by the host.
      const result = await ctx.call("data", "put", "expenses", value);
      error = result.ok ? "" : (result.errors ?? []).map((e) => e.message).join(". ") || result.error;
      if (!result.ok) draw();
    }
    if (action === "remove") await ctx.call("data", "delete", "expenses", value);
  });
  // Every write to the collection, from this plugin or any other, redraws the view.
  ctx.on("data:changed:expenses", () => draw());
  draw();
}
