// Budget: a monthly budget, and how spending compares with it. The budget is
// a setting, so the plugins panel draws a field for it from the manifest; the
// plugin reads it with ctx.settings.get(). Its view is a template in
// budget.html, drawn live: it reads the expenses (`data:read:expenses`, which
// it doesn't own) and the budget, and draws again when either changes.

export const manifest = {
  id: "budget",
  name: "Budget",
  description: "Spending against a monthly budget.",
  version: "1.0.0",
  permissions: ["ui", "data:read:expenses"],
  order: 10,
  settings: {
    budget: { type: "number", title: "Monthly budget (£)", default: 2000 },
  },
};

const money = (n) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function (ctx) {
  const views = ctx.ui.views("budget.html");

  views.live("main", "month", async (ctx) => {
    const expenses = await ctx.call("data", "list", "expenses");
    const budget = Number((await ctx.settings.get()).budget ?? 2000);
    const spent = expenses.reduce((sum, e) => sum + e.amount, 0);
    const biggest = expenses.reduce((top, e) => (!top || e.amount > top.amount ? e : top), null);
    const over = spent > budget;
    return {
      verdict: over ? "Over budget" : "On budget",
      tone: over ? "danger" : "ok",
      spent: money(spent),
      count: expenses.length,
      leftLabel: over ? "Over by" : "Budget left",
      left: money(Math.abs(budget - spent)),
      budget: money(budget),
      biggest: biggest?.item ?? "None",
      biggestShare: biggest ? `${Math.round((biggest.amount / (spent || 1)) * 100)}% of spend` : "",
    };
  });
}
