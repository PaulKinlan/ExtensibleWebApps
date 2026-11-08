// Chapter 1, a tiny core. Its words are in chapter-1-core.html; this file
// draws them, and does the one thing the chapter offers: turning every
// plugin on the page off, this one included, so you see what the kernel
// alone leaves behind.
//
// Switching plugins needs `plugins:manage`. The kernel only lets a plugin
// switch the plugins in its own app, so it has to be tab-scoped: its tab
// says which app it's in.

export const manifest = {
  id: "chapter-1-core",
  name: "Chapter 1: A tiny core",
  description: "Explains the kernel, and can turn every plugin on this page off.",
  version: "1.0.0",
  permissions: ["ui", "plugins:read", "plugins:manage"],
  scope: "tab",
};

export default function (ctx) {
  ctx.ui.views("chapter-1-core.html").render("chapters", "chapter", {}, { order: 1 });

  ctx.ui.onEvent(async (action) => {
    if (action !== "all-off") return;
    const plugins = await ctx.call("plugins", "app");
    // Everyone else first, then this chapter: once it's off, it can't switch anything.
    const me = manifest.id;
    for (const p of plugins) if (p.enabled && p.id !== me) await ctx.call("plugins", "setEnabled", p.id, false);
    await ctx.call("plugins", "setEnabled", me, false);
  });
}
