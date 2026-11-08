// Undo and Redo buttons for the whole app: they take back the most recent
// change to the app's data, whichever plugin made it (a row deleted from a
// table, a form saved, a list imported) and put it back again.
//
// Add it to any app with two lines in its app.html:
//
//   <link rel="plugin" href="/std/undo.js">
//   <slot name="history"></slot>
//
// The kernel keeps the list of changes (src/kernel/services/history.ts); this
// plugin only draws the buttons and says what each would do. It needs the
// `history` permission, which lets it undo changes to data it doesn't own
// without a review, so it acts only when the person presses a button.

export const manifest = {
  id: "undo",
  name: "Undo",
  description: "Undo and Redo buttons that take back the app's most recent change to its data, and put it back again.",
  version: "1.0.0",
  permissions: ["ui", "history"],
};

export default async function (ctx) {
  const views = ctx.ui.views("undo.html");
  /** What the last press couldn't do, shown until the next change. */
  let problem = "";

  const buttons = views.live("history", "buttons", async (ctx) => {
    const { undo, redo } = await ctx.call("history", "state");
    return {
      noUndo: !undo,
      noRedo: !redo,
      undoTitle: undo ? `Undo: ${undo.text}` : "Nothing to undo",
      redoTitle: redo ? `Redo: ${redo.text}` : "Nothing to redo",
      problem,
    };
  });

  // Many writes at once (an import, a sample list) redraw the buttons once, just after the last.
  let soon;
  ctx.on("history:changed", () => {
    problem = "";
    clearTimeout(soon);
    soon = setTimeout(() => buttons.refresh(), 50);
  });

  ctx.ui.onEvent(async (action) => {
    if (action !== "undo" && action !== "redo") return;
    const result = await ctx.call("history", action);
    if (!result.ok) problem = result.step ? `Couldn't ${action} ${result.step.text}: ${result.error}` : result.error;
    buttons.refresh();
  });
}
