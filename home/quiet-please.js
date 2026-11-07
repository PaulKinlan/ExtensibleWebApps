// Quiet please: stops a learning note written all in capitals.
//
// It shows a hook that can change what happens. Before any note is saved,
// the kernel runs `data:beforeWrite:learning` through every listener, one at
// a time (a "serial" hook). Returning { block: reason } stops the write, and
// learning-notes.js shows the reason. Listening to a hook that can stop an
// action needs `hook:intercept:…`, and since the notes aren't this plugin's,
// it needs to be allowed to read them too.

export const manifest = {
  id: "quiet-please",
  name: "Quiet please",
  description: "Stops a note written all in capitals, by listening on the hook that runs before each write.",
  version: "1.0.0",
  permissions: ["data:read:learning", "hook:intercept:data:beforeWrite:learning"],
};

export default function (ctx) {
  ctx.on("data:beforeWrite:learning", (change) => {
    const letters = (change.after?.text ?? "").replace(/[^\p{L}]/gu, "");
    // Shouting needs letters that have a case: Chinese or Arabic, say, have none, and are never blocked.
    if (letters.length >= 5 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return { block: "Quiet please is on, and that note is all capitals" };
  });
}
