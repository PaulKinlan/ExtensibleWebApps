// A tally: a button that counts, and remembers the count on this device.
// Rename LABEL to say what you're counting (glasses of water, pages read).
//
// It keeps the count in its own storage (ctx.storage), which needs no
// permission: only this plugin can read or change it.
//
// Customize's "Make a plugin" fills in where it shows (the `here` place) and
// its name, from what you chose there.

export const manifest = {
  id: "my-tally",
  name: "My tally",
  description: "A button that counts, and remembers the count.",
  version: "1.0.0",
  permissions: ["ui"],
  places: { here: { at: "main", put: "append" } },
};

const LABEL = "Times today";

export default async function (ctx) {
  let count = (await ctx.storage.get("count")) ?? 0;
  const draw = () =>
    ctx.ui.render("here", "tally", ctx.ui.html`
      <ui-card>
        <ui-stat label="${LABEL}" value="${count}"></ui-stat>
        <ui-toolbar>
          <button type="button" data-action="add">Add one</button>
          <button type="button" class="secondary" data-action="reset">Start again</button>
        </ui-toolbar>
      </ui-card>`);
  ctx.ui.onEvent(async (action) => {
    if (action === "add") count++;
    if (action === "reset") count = 0;
    await ctx.storage.set("count", count);
    draw();
  });
  draw();
}
