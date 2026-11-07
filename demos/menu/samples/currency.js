// Prices in my currency: replaces every price on the menu with one in the
// currency the person picks. One place matches every price (`each: true`);
// page.matches gives the plugin each one's data-eur, and it draws a view in
// each with `prices#<index>`. While its view is there the original price is
// hidden; turn the plugin off and the page is as the author wrote it.

export const manifest = {
  id: "currency",
  name: "Prices in my currency",
  description: "Shows the menu's prices in pounds, dollars or yen.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    prices: { at: "[data-part=price]", put: "replace", each: true },
  },
  settings: {
    currency: { type: "string", title: "Currency", enum: ["GBP", "USD", "JPY"], default: "GBP" },
  },
  files: ["currency.html"],
};

// Rates are fixed for the demo: a plugin with the network permission could fetch today's.
const RATES = { GBP: 0.85, USD: 1.08, JPY: 165 };

export default async function (ctx) {
  const views = ctx.ui.views("currency.html");
  const prices = await ctx.call("page", "matches", "prices");

  const draw = async () => {
    const { currency = "GBP" } = await ctx.settings.get();
    const format = new Intl.NumberFormat("en", { style: "currency", currency });
    prices.forEach((price, i) => {
      const eur = Number(price.data.eur);
      views.render(`prices#${i}`, "price", { converted: format.format(eur * RATES[currency]), original: price.text });
    });
  };
  await draw();
  ctx.settings.onChange(draw);
}
