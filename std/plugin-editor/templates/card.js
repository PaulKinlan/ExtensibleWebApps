// Show a card on the page: the smallest plugin that shows something.
//
// It asks for one permission, `ui`, which lets it draw into the page's
// slots. Change the words, or the slot name to any <slot name> the page has.
// Rename `id` too if you keep more than one copy.

export const manifest = {
  id: "my-card",
  name: "My card",
  description: "Draws a card on the page.",
  version: "1.0.0",
  permissions: ["ui"],
};

export default function (ctx) {
  ctx.log("Hello from my card");
  ctx.ui.render("playground", "card", ctx.ui.html`
    <ui-card tone="accent">
      <h3>Hello</h3>
      <p>This card is a plugin you wrote. Switch it off and it goes away.</p>
    </ui-card>`);
}
