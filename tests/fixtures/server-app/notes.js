// Runs in the browser only (the default): the space's server never starts it.
export const manifest = { id: "server-app-notes", name: "Notes", permissions: ["ui"] };

export default function (ctx) {
  ctx.ui.render("main", "notes", ctx.ui.html`<p>Notes</p>`);
}
