// Private memo: a note only the person sees, after the invoice's header.
// The header isn't marked, so the place is open and the memo is drawn at
// once. The note is kept in the plugin's own storage, on this device.

export const manifest = {
  id: "memo",
  name: "Private memo",
  description: "A note to yourself about this invoice.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    note: { at: "body > header", put: "after" },
  },
  files: ["memo.html"],
};

export default async function (ctx) {
  const views = ctx.ui.views("memo.html");
  const draw = async () => views.render("note", "memo", { text: (await ctx.storage.get("text")) ?? "" });
  await draw();
  ctx.ui.onEvent(async (action, value) => {
    if (action !== "save") return;
    await ctx.storage.set("text", String(value.text ?? "").slice(0, 500));
    await draw();
  });
}
