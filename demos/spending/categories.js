// Categories: where the money goes. Another reader of the expenses. Its view
// is built in JavaScript with ctx.ui.html rather than a template file, which
// is still fine for views computed from code: a <meter> per category shows
// its share of the total. ctx.ui.html escapes every value.

export const manifest = {
  id: "categories",
  name: "By category",
  description: "Spending split by category.",
  version: "1.0.0",
  permissions: ["ui", "data:read:expenses", "hook:listen:data:changed:expenses"],
};

const money = (n) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

export default async function (ctx) {
  const html = ctx.ui.html;

  const draw = async () => {
    const expenses = await ctx.call("data", "list", "expenses");
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    const byCategory = new Map();
    for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
    const rows = [...byCategory].sort((a, b) => b[1] - a[1]);

    ctx.ui.render(
      "side",
      "categories",
      html`
        <h3>By category</h3>
        ${rows.length
          ? html`<dl>${rows.map(([category, amount]) => html`
              <dt>${category} <small>${money(amount)} · ${Math.round((amount / total) * 100)}%</small></dt>
              <dd><meter min="0" max="${total}" value="${amount}">${money(amount)}</meter></dd>`)}</dl>`
          : html`<p><small>No expenses yet.</small></p>`}`,
    );
  };

  ctx.on("data:changed:expenses", () => draw());
  draw();
}
