// Quick meals: reads the recipes and lists the ones you can make in the time
// you have. The time is a setting (the plugins panel draws its field); the
// list is built in code with ctx.ui.html rather than a template, to show the
// other way to draw. ctx.ui.live redraws it when a recipe or the setting changes.

export const manifest = {
  id: "quick",
  name: "Quick meals",
  description: "Recipes you can make in the time you have.",
  version: "1.0.0",
  permissions: ["ui", "data:read:recipes"],
  order: 20,
  settings: {
    minutes: { type: "number", title: "Time you have (minutes)", default: 30 },
  },
};

export default async function (ctx) {
  const html = ctx.ui.html;

  ctx.ui.live("side", "quick", async (ctx) => {
    const limit = Number((await ctx.settings.get()).minutes ?? 30);
    const quick = (await ctx.call("data", "list", "recipes")).filter((r) => r.minutes && r.minutes <= limit).sort((a, b) => a.minutes - b.minutes);
    return html`
      <h3>Ready in ${limit} minutes</h3>
      ${quick.length
        ? html`<ul>${quick.map((r) => html`<li>${r.title} <ui-badge>${r.minutes} min</ui-badge></li>`)}</ul>`
        : html`<p><small>Nothing that quick yet.</small></p>`}`;
  });
}
