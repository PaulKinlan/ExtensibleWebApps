// Cookbook: owns the recipes. A recipe's ingredients are a list, each with
// an amount, a unit and an item ({ amount: 200, unit: "g", item: "flour" }),
// so ui-form draws a row per ingredient with Add and Remove buttons, and
// scaling is multiplying the amount.
//
// Opening a recipe shows it with a servings field; changing it sends
// "serves" with the new number (a number input sends a number), and the
// plugin draws the quantities scaled.

export const manifest = {
  id: "cookbook",
  name: "Cookbook",
  description: "Recipes, and the open recipe scaled to how many you're feeding.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 10,
  collections: {
    recipes: {
      title: "Recipes",
      schema: {
        type: "object",
        required: ["title", "serves"],
        properties: {
          title: { type: "string", title: "Recipe", maxLength: 120 },
          serves: { type: "integer", minimum: 1, maximum: 100, default: 4 },
          minutes: { type: "integer", title: "Minutes", minimum: 1 },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              title: "Ingredient",
              required: ["item"],
              properties: {
                amount: { type: "number", minimum: 0 },
                unit: { type: "string", maxLength: 20 },
                item: { type: "string", maxLength: 80 },
              },
            },
          },
          method: { type: "string", "x-multiline": true },
        },
      },
    },
  },
};

/** "200 g flour" as { amount: 200, unit: "g", item: "flour" }. Recipes saved before ingredients were a list are read this way. */
export function ingredient(line) {
  const match = /^(\d+\/\d+|\d+(?:[.,]\d+)?)\s*(?:(g|kg|ml|l|tsp|tbsp|cup|cups|pinch)\s+)?(.*)$/i.exec(line.trim());
  if (!match) return { item: line.trim() };
  const [n, d] = match[1].split("/").map((x) => Number(x.replace(",", ".")));
  return { amount: d ? n / d : n, ...(match[2] && { unit: match[2] }), item: match[3] };
}
const lines = (text) => text.split("\n").filter((l) => l.trim()).map(ingredient);

const SAMPLE = [
  { title: "Pancakes", serves: 4, minutes: 20, ingredients: lines("200 g flour\n2 eggs\n300 ml milk\n1 pinch salt"), method: "Whisk everything into a smooth batter. Fry ladlefuls in a hot buttered pan, a minute a side." },
  { title: "Tomato soup", serves: 2, minutes: 35, ingredients: lines("6 tomatoes\n1 onion\n500 ml stock\n1 tbsp olive oil"), method: "Soften the onion in the oil, add the tomatoes and stock, simmer 20 minutes, blend." },
  { title: "Lentil curry", serves: 4, minutes: 45, ingredients: lines("250 g red lentils\n400 ml coconut milk\n1 onion\n2 tbsp curry paste"), method: "Fry the onion and paste, add lentils, coconut milk and 400 ml water, simmer until soft." },
];

/** An ingredient as text, its amount scaled: 200 g flour × 1.5 is "300 g flour"; one with no amount stays as it is. */
export function scale({ amount, unit, item }, factor) {
  if (amount === undefined) return item;
  const scaled = amount * factor;
  const shown = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(scaled < 10 ? 1 : 0).replace(/\.0$/, "");
  return [shown, unit, item].filter(Boolean).join(" ");
}

export default async function (ctx) {
  const views = ctx.ui.views("cookbook.html");
  if (!(await ctx.storage.get("seeded"))) {
    for (const recipe of SAMPLE) await ctx.call("data", "put", "recipes", recipe);
    await ctx.storage.set("seeded", true);
  }
  // Recipes saved when ingredients were lines of text become lists.
  for (const recipe of await ctx.call("data", "list", "recipes")) {
    if (typeof recipe.ingredients === "string") await ctx.call("data", "put", "recipes", { ...recipe, ingredients: lines(recipe.ingredients) });
  }

  let open = null; // the id of the recipe being read
  let editing = false;
  let serves = null; // how many the open recipe is scaled for

  const draw = async () => {
    const recipe = open && (await ctx.call("data", "get", "recipes", open));
    if (open && !recipe) open = null;
    const people = serves ?? recipe?.serves;
    views.render("main", "cookbook", {
      open,
      editing,
      recipe: recipe && {
        ...recipe,
        people,
        lines: (recipe.ingredients ?? []).map((i) => scale(i, people / recipe.serves)),
        steps: (recipe.method ?? "").split(/\n+/).filter((s) => s.trim()),
      },
    });
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "open") [open, serves, editing] = [value, null, false];
    if (action === "close" || action === "saved") [open, serves, editing] = [action === "saved" ? open : null, null, false];
    if (action === "edit") editing = true;
    if (action === "serves") serves = Math.max(1, Math.min(100, Number(value) || 1));
    draw();
  });
  ctx.on("data:changed:recipes", (change) => {
    if (change.id === open) draw();
  });
  draw();
}
