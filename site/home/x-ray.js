// X-ray: a switch in the page's header that outlines every part of the page
// and labels each with the plugin that drew it. Where one plugin ends and the
// next begins is something the host already knows: it marks each view it
// draws with data-plugin. This plugin draws only its switch, and the page's
// own CSS (in /index.html) does the rest when the switch is pressed, with
// body:has(…). So x-ray reaches no other plugin, and asks for nothing but ui.
//
// Each tab has its own switch, and it starts off.

export const manifest = {
  id: "x-ray",
  name: "X-ray",
  description: "Outlines every part of the page and labels it with the plugin that drew it.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

export default function (ctx) {
  const views = ctx.ui.views("x-ray.html");
  let on = false;
  const draw = () => views.render("page-tools", "switch", { on, pressed: String(on) }, { order: 1 });
  draw();
  ctx.ui.onEvent((action) => {
    if (action !== "x-ray") return;
    on = !on;
    draw();
  });
}
