// Chapter 7, what a plugin may do. Its words are in
// chapter-7-permissions.html. Its manifest asks only for `ui`, and its
// "Try it" buttons ask the kernel for things that need more: reading your
// notes, and switching a plugin off. The gate refuses both, and the chapter
// shows what it said.

export const manifest = {
  id: "chapter-7-permissions",
  name: "Chapter 7: What a plugin may do",
  description: "Explains permissions and the gate, and lets you watch the gate refuse this chapter.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

/** What each button asks for, and the permission it would need. */
const TRIES = {
  read: { asked: 'ctx.call("data", "list", "learning")', needs: "data:read:learning", run: (ctx) => ctx.call("data", "list", "learning") },
  switch: { asked: 'ctx.call("plugins", "setEnabled", "note-stats", false)', needs: "plugins:manage", run: (ctx) => ctx.call("plugins", "setEnabled", "note-stats", false) },
};

export default function (ctx) {
  const views = ctx.ui.views("chapter-7-permissions.html");
  /** The last try: what was asked, and what the kernel answered. */
  let tried = null;
  const draw = () => views.render("permissions", "chapter", { tried, permissions: manifest.permissions.join(", ") }, { order: 1 });
  draw();
  ctx.ui.onEvent(async (action) => {
    const attempt = TRIES[action];
    if (!attempt) return;
    try {
      await attempt.run(ctx);
      tried = { asked: attempt.asked, needs: attempt.needs, answer: "It was allowed. That shouldn't happen: tell us.", refused: false };
    } catch (error) {
      tried = { asked: attempt.asked, needs: attempt.needs, answer: error instanceof Error ? error.message : String(error), refused: true };
    }
    draw();
  });
}
