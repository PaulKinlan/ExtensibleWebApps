// Expenses: plain HTML drawn from data. The expenses live in a collection
// this plugin owns; the view is built with ctx.ui.html (which escapes every
// value) and drawn again whenever the collection changes. The host updates
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
  const html = ctx.ui.html;
  // The samples go in once; a flag in the plugin's own storage keeps deleted expenses deleted.
  if (!(await ctx.storage.get("seeded"))) {
    for (const e of SAMPLE) await ctx.call("data", "put", "expenses", e);
    await ctx.storage.set("seeded", true);
  }
  let error = "";

  const draw = async () => {
    const expenses = await ctx.call("data", "list", "expenses");
    ctx.ui.render(
      "main",
      "expenses",
      html`
        <ui-card>
          <h2>Expenses</h2>
          <table>
            <thead><tr><th>Item</th><th>Category</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              ${expenses.map((e) => html`<tr key="${e.id}"><td>${e.item}${e.repeats ? html` <small>monthly</small>` : ""}</td><td><ui-badge>${e.category}</ui-badge></td><td>${money(e.amount)}</td><td><button data-action="remove" data-value="${e.id}" aria-label="Remove ${e.item}">Remove</button></td></tr>`)}
            </tbody>
          </table>
        </ui-card>
        <ui-card>
          <h3>Add an expense</h3>
          <form data-action="add">
            <ui-grid min="12rem">
              <label>Item <input name="item" placeholder="Coffee" required></label>
              <label>Amount <input type="number" name="amount" step="0.01" min="0" required></label>
              <label>Category <select name="category">${CATEGORIES.map((c) => html`<option>${c}</option>`)}</select></label>
            </ui-grid>
            <label><input type="checkbox" name="repeats"> Repeats monthly</label>
            <ui-toolbar>${error ? html`<span role="alert">${error}</span>` : ""}<ui-spacer></ui-spacer><button type="submit">Add</button></ui-toolbar>
          </form>
        </ui-card>`,
    );
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
