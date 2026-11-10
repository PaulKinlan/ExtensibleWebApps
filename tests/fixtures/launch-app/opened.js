// Lists the files the app was opened with, when asked: nothing here touches
// the launch service until the button is pressed, so its kernel module starts
// long after the tab opened (tests/checks/launch-late.mjs).

export const manifest = {
  id: "opened",
  name: "Opened files",
  version: "1.0.0",
  permissions: ["ui", "launch"],
  files: ["opened.html"],
};

export default function (ctx) {
  const views = ctx.ui.views("opened.html");
  let asked = 0;
  let files = [];
  const draw = () => views.render("main", "opened", { asked, files, none: asked > 0 && !files.length });
  ctx.ui.onEvent(async (action) => {
    if (action !== "take") return;
    files = (await ctx.call("launch", "take")).map((file) => ({ name: file.name, type: file.type, text: file.text ?? "" }));
    asked++;
    draw();
  });
  draw();
}
