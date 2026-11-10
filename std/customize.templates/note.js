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
  settings: {
    title: { type: "string", title: "Heading", default: "Remember" },
    words: { type: "string", title: "Words", default: "Write anything here, and it shows on the page." },
  },
};

/** Default words when you haven't changed them in Settings yet. */
const TITLE = "Remember";
const WORDS = "Write anything here, and it shows on the page.";

export default function (ctx) {
  ctx.ui.live("here", "note", async (ctx) => {
    const s = await ctx.settings.get();
    return ctx.ui.html`
      <ui-card tone="accent">
        <h3>${s.title || TITLE}</h3>
        <p>${s.words || WORDS}</p>
      </ui-card>`;
  });
}
