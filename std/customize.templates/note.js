// A note on the page, in your own words: the smallest plugin that shows
// something. Change the words between the quotes below.
//
// Customize's "Make a plugin" fills in where it shows (the `here` place) and
// its name, from what you chose there.

export const manifest = {
  id: "my-note",
  name: "My note",
  description: "A note on the page, in my own words.",
  version: "1.0.0",
  permissions: ["ui"],
  places: { here: { at: "main", put: "append" } },
};

/** What the note says. */
const TITLE = "Remember";
const WORDS = "Write anything here, and it shows on the page.";

export default function (ctx) {
  ctx.ui.render("here", "note", ctx.ui.html`
    <ui-card tone="accent">
      <h3>${TITLE}</h3>
      <p>${WORDS}</p>
    </ui-card>`);
}
