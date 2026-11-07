// Budget: a monthly budget, and how spending compares with it. The budget is
// a setting, so the plugins panel draws a field for it from the manifest; the
// plugin reads it with ctx.settings.get() and hears changes with onChange.
// It reads the expenses (`data:read:expenses`) and hears when they change
// (`hook:listen:data:changed:expenses`), but doesn't own them.

export const manifest = {
  id: "budget",
  name: "Budget",
  description: "Spending against a monthly budget.",
  version: "1.0.0",
  permissions: ["ui", "data:read:expenses", "hook:listen:data:changed:expenses"],
  order: 10,
  settings: {
    budget: { type: "number", title: "Monthly budget (£)", default: 2000 },
  },
};

const money = (n) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function (ctx) {
  const html = ctx.ui.html;

  const draw = async () => {
    const expenses = await ctx.call("data", "list", "expenses");
    const budget = Number((await ctx.settings.get()).budget ?? 2000);
    const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
    const biggest = expenses.reduce((top, e) => (!top || e.amount > top.amount ? e : top), null);
    const over = spent > budget;
    ctx.ui.render(
      "main",
      "budget",
      html`
        <ui-toolbar><h2>This month</h2><ui-spacer></ui-spacer><ui-badge tone="${over ? "danger" : "ok"}">${over ? "Over budget" : "On budget"}</ui-badge></ui-toolbar>
        <ui-grid min="10rem">
          <ui-stat label="Spent" value="${money(spent)}" delta="${expenses.length} items"></ui-stat>
          <ui-stat label="${over ? "Over by" : "Budget left"}" value="${money(Math.abs(budget - spent))}" delta="of ${money(budget)}" tone="${over ? "danger" : "ok"}"></ui-stat>
          <ui-stat label="Biggest" value="${biggest?.item ?? "None"}" delta="${biggest ? `${Math.round((biggest.amount / (spent || 1)) * 100)}% of spend` : ""}"></ui-stat>
        </ui-grid>`,
    );
  };

  ctx.on("data:changed:expenses", () => draw());
  ctx.settings.onChange(() => draw());
  draw();
}
