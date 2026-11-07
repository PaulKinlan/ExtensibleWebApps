// Spending: plain HTML drawn from data. The expenses live in a collection;
// the view is built with ctx.ui.html (which escapes every value) and drawn
// again whenever the collection changes. The host updates the page in place,
// so typing, focus and scroll survive each redraw. A form with data-action
// sends all of its named fields, typed, and the plugin saves them.

export const manifest = {
  id: "spending",
  name: "Spending",
  description: "A monthly spending dashboard in plain HTML, backed by a collection.",
  version: "1.0.0",
  permissions: ["ui"],
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
  settings: {
    budget: { type: "number", title: "Monthly budget (£)", default: 2000 },
  },
};

const SAMPLE = [
  { item: "Groceries", category: "Food", amount: 182.4 },
  { item: "Rent", category: "Home", amount: 1250, repeats: true },
  { item: "Train pass", category: "Travel", amount: 96, repeats: true },
  { item: "Books", category: "Fun", amount: 34.99 },
];
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
    const budget = Number((await ctx.settings.get()).budget ?? 2000);
    const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
    const biggest = expenses.reduce((top, e) => (!top || e.amount > top.amount ? e : top), null);
    const over = spent > budget;
    ctx.ui.render(
      "app.main",
      "spending",
      html`
        <ui-toolbar><h2>Spending</h2><ui-spacer></ui-spacer><ui-badge tone="${over ? "danger" : "ok"}">${over ? "Over budget" : "On budget"}</ui-badge></ui-toolbar>
        <ui-grid min="10rem">
          <ui-stat label="Spent" value="${money(spent)}" delta="${expenses.length} items"></ui-stat>
          <ui-stat label="${over ? "Over by" : "Budget left"}" value="${money(Math.abs(budget - spent))}" tone="${over ? "danger" : "ok"}"></ui-stat>
          <ui-stat label="Biggest" value="${biggest?.item ?? "None"}" delta="${biggest ? `${Math.round((biggest.amount / (spent || 1)) * 100)}% of spend` : ""}"></ui-stat>
        </ui-grid>
        <ui-card>
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
              <label>Category <select name="category">${manifest.collections.expenses.schema.properties.category.enum.map((c) => html`<option>${c}</option>`)}</select></label>
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
  // The budget is a setting: the plugins panel draws a field for it from the manifest.
  ctx.settings.onChange(() => draw());
  draw();
}
