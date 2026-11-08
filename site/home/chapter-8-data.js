// Chapter 8, your data. Its words are in chapter-8-data.html. The notes
// belong to Learning notes, so when this chapter adds one, the kernel checks
// it against the collection's schema, then asks you on a review card before
// it is written. The "Try it" buttons do both, for real.

export const manifest = {
  id: "chapter-8-data",
  name: "Chapter 8: Your data",
  description: "Explains collections, schemas and review, and asks you to accept a note it wants to add.",
  version: "1.0.0",
  permissions: ["ui", "data:write:learning"],
  scope: "tab",
};

const NOTE = "Chapter 8 added this note, after I said yes on a review card.";

export default function (ctx) {
  const views = ctx.ui.views("chapter-8-data.html");
  /** What the last try did, and whether one is waiting for the person. */
  let result = null;
  let waiting = false;
  const draw = () => views.render("data", "chapter", { result, waiting }, { order: 1 });
  draw();

  const put = async (record, reason) => {
    waiting = true;
    result = null;
    draw();
    try {
      const answer = await ctx.call("data", "put", "learning", record, reason);
      result = answer.ok
        ? { ok: true, text: "You accepted it, so it was written. It's in your notes now, and Note stats heard about it." }
        : { ok: false, text: answer.errors?.length ? `The schema refused it before you were asked: ${answer.errors.map((e) => e.message ?? e).join("; ")}` : answer.error ?? "It wasn't written." };
    } catch (error) {
      result = { ok: false, text: `It wasn't written: ${error instanceof Error ? error.message : String(error)}` };
    }
    waiting = false;
    draw();
  };

  ctx.ui.onEvent(async (action) => {
    if (waiting) return;
    if (action === "add") await put({ text: NOTE }, "Chapter 8 is showing you a review card");
    if (action === "invalid") await put({ text: 42 }, "Chapter 8 is trying a note that isn't text");
  });
}
