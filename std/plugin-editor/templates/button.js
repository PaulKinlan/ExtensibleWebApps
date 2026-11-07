// A button that changes notes: writing data that isn't yours.
//
// The notes belong to another plugin, so writing them needs
// `data:write:learning`, and every write is shown to the person to allow or
// refuse first. The `reason` you pass is what they read.

export const manifest = {
  id: "my-button",
  name: "My button",
  description: "Adds a star to the start of every note, if you allow it.",
  version: "1.0.0",
  permissions: ["ui", "data:read:learning", "data:write:learning"],
};

export default function (ctx) {
  ctx.ui.render("playground", "button", ctx.ui.html`
    <ui-toolbar><button data-action="star">Star every note</button></ui-toolbar>`);
  ctx.ui.onEvent(async (action) => {
    if (action !== "star") return;
    for (const note of await ctx.call("data", "list", "learning")) {
      if (note.text.startsWith("★")) continue;
      const result = await ctx.call("data", "put", "learning", { id: note.id, text: `★ ${note.text}` }, "Star this note");
      ctx.log(result.ok ? `Starred ${note.id}` : `Not starred: ${JSON.stringify(result.errors ?? result.outcome)}`);
    }
  });
}
