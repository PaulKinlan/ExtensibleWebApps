// A short list of links you keep beside this app. Add, change or take out
// lines in LINKS below: each is a title and an address.
//
// Customize's "Make a plugin" fills in where it shows (the `here` place) and
// its name, from what you chose there.

export const manifest = {
  id: "my-links",
  name: "My links",
  description: "A short list of links beside this app.",
  version: "1.0.0",
  permissions: ["ui"],
  places: { here: { at: "main", put: "append" } },
};

const LINKS = [
  { title: "The guide to this platform", url: "/docs/" },
  { title: "Plugins you can add", url: "/packages/" },
];

export default function (ctx) {
  ctx.ui.render("here", "links", ctx.ui.html`
    <ui-card>
      <h3>Links</h3>
      <ul>${LINKS.map((link) => ctx.ui.html`<li><a href="${link.url}">${link.title}</a></li>`)}</ul>
    </ui-card>`);
}
