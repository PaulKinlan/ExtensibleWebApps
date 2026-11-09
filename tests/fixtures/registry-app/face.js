// Calls the clock service, which the registry's Clock package provides.
export const manifest = {
  id: "registry-app-face",
  name: "Face",
  version: "1.0.0",
  permissions: ["ui", "clock"],
  services: ["clock"],
};

export default async function (ctx) {
  const { time } = await ctx.call("clock", "now");
  ctx.ui.render("main", "face", ctx.ui.html`<p>${time}</p>`);
}
