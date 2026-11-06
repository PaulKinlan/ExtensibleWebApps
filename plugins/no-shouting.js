// Blocks saving a note written entirely in capitals. Shows a plugin in a
// worker intercepting a write through a serial hook.

export const manifest = {
  id: "no-shouting",
  name: "No shouting",
  description: "Stops a note from being saved when it is all capitals.",
  version: "1.0.0",
  permissions: ["hook:intercept:data:beforeWrite"],
};

export default function (ctx) {
  ctx.on("data:beforeWrite", (change) => {
    const letters = change.after.text.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 10 && letters === letters.toUpperCase()) return { block: "the note is all capitals" };
  });
}
