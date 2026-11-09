// Runs in the browser only; on the space's server its collection is still known, which is what the check needs.
export const manifest = {
  id: "jots",
  name: "Jots",
  permissions: ["ui"],
  collections: { "jot-notes": { title: "Jots", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
};

export default function (ctx) {
  ctx.ui.render("main", "jots", ctx.ui.html`<p>Jots</p>`);
}
