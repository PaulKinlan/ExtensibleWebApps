// Stop notes that use a word you pick: a hook that can stop an action.
//
// Before a note is saved, the kernel runs `data:beforeWrite:learning`
// through each listener in turn. Returning { block: reason } stops the write,
// and the reason is shown to the person. Stopping something is more than
// listening, so it needs `hook:intercept:…`, as well as leave to read the notes.

export const manifest = {
  id: "word-blocker",
  name: "Word blocker",
  description: "Stops a note that mentions a word you pick.",
  version: "1.0.0",
  permissions: ["data:read:learning", "hook:intercept:data:beforeWrite:learning"],
};

const WORD = "banana";

export default function (ctx) {
  ctx.on("data:beforeWrite:learning", (change) => {
    const text = change.after?.text ?? "";
    if (text.toLowerCase().includes(WORD)) {
      ctx.log(`Blocked a note that says ${WORD}`);
      return { block: `Word blocker is on, and that note says ${WORD}` };
    }
  });
}
