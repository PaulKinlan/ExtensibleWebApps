// A blank plugin, to write from scratch. It draws a heading where you chose;
// replace it with anything a view can show (see /docs/ for the guide, and
// Customize's Layout for the ui-* elements you can use).
//
// Customize's "Make a plugin" fills in where it shows (the `here` place) and
// its name, from what you chose there.

export const manifest = {
  id: "my-plugin",
  name: "My plugin",
  description: "A plugin of my own.",
  version: "1.0.0",
  permissions: ["ui"],
  places: { here: { at: "main", put: "append" } },
};

export default function (ctx) {
  ctx.ui.render("here", "hello", ctx.ui.html`<h3>Hello from my plugin</h3>`);
}
