// Add a tip: adds a line at the end of the invoice's items. The author
// marked the items data-extend="review", so before anything appears the
// person sees a card saying what this plugin wants to change, and allows or
// declines it.

export const manifest = {
  id: "tip",
  name: "Add a tip",
  description: "Adds a 10% tip line to the items.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    line: { at: "#lines", put: "append" },
  },
};

export default function (ctx) {
  ctx.ui.render("line", "tip", ctx.ui.html`<p><strong>Tip (10%)</strong> €9.60, added by you</p>`);
}
