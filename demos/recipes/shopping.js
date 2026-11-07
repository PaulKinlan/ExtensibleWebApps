// Shopping: owns a shopping list, and reads the recipes to fill it. Pick a
// recipe and "Add its ingredients" puts each line on the list; ticking an
// item (a checkbox whose data-action names the item) marks it bought.
//
// It writes only its own collection, so nothing here needs a review. It
// reads the recipes (`data:read:recipes`) for its menu. The list is a live
// view: it reads the shopping list and the recipes, so a change to either,
// from this plugin or the cookbook, draws it again.

export const manifest = {
  id: "shopping",
  name: "Shopping list",
  description: "A shopping list you can fill from a recipe.",
  version: "1.0.0",
  permissions: ["ui", "data:read:recipes"],
  order: 10,
  collections: {
    shopping: {
      title: "Shopping list",
      schema: {
        type: "object",
        required: ["item"],
        properties: {
          item: { type: "string", maxLength: 200 },
          done: { type: "boolean" },
          from: { type: "string", title: "For" },
        },
      },
    },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("shopping.html");

  views.live("side", "list", async (ctx) => {
    const items = (await ctx.call("data", "list", "shopping")).sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.createdAt.localeCompare(b.createdAt));
    const recipes = (await ctx.call("data", "list", "recipes")).sort((a, b) => a.title.localeCompare(b.title));
    return { items, recipes, ticked: items.some((i) => i.done) };
  });

  ctx.ui.onEvent(async (action, value) => {
    // "tick:<id>" with true or false from the checkbox.
    if (action.startsWith("tick:")) {
      const item = await ctx.call("data", "get", "shopping", action.slice(5));
      if (item) await ctx.call("data", "put", "shopping", { ...item, done: value === true });
    }
    if (action === "add" && value.item?.trim()) await ctx.call("data", "put", "shopping", { item: value.item.trim() });
    if (action === "from-recipe") {
      const recipe = await ctx.call("data", "get", "recipes", String(value.recipe));
      // Ingredients are { amount, unit, item }; recipes saved before that hold lines of text.
      const list = Array.isArray(recipe?.ingredients) ? recipe.ingredients : String(recipe?.ingredients ?? "").split("\n").filter((l) => l.trim()).map((item) => ({ item: item.trim() }));
      for (const { amount, unit, item } of list) {
        await ctx.call("data", "put", "shopping", { item: [amount, unit, item].filter((x) => x !== undefined && x !== "").join(" "), from: recipe.title });
      }
    }
    if (action === "clear") {
      for (const item of await ctx.call("data", "list", "shopping")) if (item.done) await ctx.call("data", "delete", "shopping", item.id);
    }
  });
}
