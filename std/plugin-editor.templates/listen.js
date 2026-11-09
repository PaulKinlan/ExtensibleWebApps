// Show the latest note: hear a hook, and show the note it was about.
//
// Reading the `learning` notes (`data:read:learning`) also lets a plugin
// hear `data:changed:learning`, which the kernel emits after every write.
// The plugin that owns the notes never knows this one is listening. On
// another page, change `learning` to a collection that page has.

export const manifest = {
  id: "latest-note",
  name: "Latest note",
  description: "Shows the latest note as it is written.",
  version: "1.0.0",
  permissions: ["ui", "data:read:learning"],
};

export default function (ctx) {
  const show = (text) =>
    ctx.ui.render("playground", "last", ctx.ui.html`<ui-card><p>Latest note: ${text}</p></ui-card>`);
  show("nothing yet");
  ctx.on("data:changed:learning", (change) => {
    ctx.log(`Heard a change to ${change.id}`);
    if (change.after) show(change.after.text);
  });
}
