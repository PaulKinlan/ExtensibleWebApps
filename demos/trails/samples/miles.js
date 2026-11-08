// Miles: a person's own plugin that shows every distance in the log in
// miles. The activities plugin marks each distance with data-km, so this
// transform finds them by that, replaces each one, and draws the same
// distance in miles. The log's data stays in kilometres; turn this off and
// the kilometres come back.

export const manifest = {
  id: "miles",
  name: "Miles",
  description: "Shows the log's distances in miles.",
  version: "1.0.0",
  permissions: ["ui", "ui:transform:activities"],
  places: {
    distance: { in: "activities", at: "[data-km]", put: "replace", each: true },
  },
};

export default async function (ctx) {
  const html = ctx.ui.html;
  const draw = async () => {
    const found = await ctx.call("page", "matches", "distance");
    found.forEach(({ data }, i) => {
      const miles = (Number(data.km) / 1.609344).toFixed(1);
      ctx.ui.render(`distance#${i}`, "miles", html`<dd class="distance">${miles}<small>mi</small></dd>`);
    });
  };
  ctx.ui.onEvent((action) => {
    if (action === "place:changed") draw();
  });
  await draw();
}
