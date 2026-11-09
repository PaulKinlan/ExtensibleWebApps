// Post times (the editor's edit times): when the post was last edited and last saved, in the
// status bar.

export const manifest = {
  id: "post-times",
  name: "Edit and save times",
  description: "Shows when you last edited and last saved the post.",
  version: "2.0.0",
  order: 30,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:save", "hook:listen:posts:close"],
  services: ["document"],
};

function ago(time) {
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(time).toLocaleDateString();
}

const clock = (time) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default async function (ctx) {
  let path = null;
  let edited = 0;
  let saved = 0;
  let opened = 0;
  let text = "";

  const show = () => {
    if (!path) return ctx.ui.render("status", "times", null);
    if (!edited && !saved) return ctx.ui.render("status", "times", { type: "text", text: `Opened ${clock(opened)}`, title: "Not edited since you opened it" });
    const parts = [];
    if (edited) parts.push(`Edited ${ago(edited)}`);
    if (saved) parts.push(`Saved ${clock(saved)}`);
    const title = [edited && `Last edit ${new Date(edited).toLocaleString()}`, saved && `Last save ${new Date(saved).toLocaleString()}`].filter(Boolean).join("\n");
    ctx.ui.render("status", "times", { type: "text", text: parts.join(" · "), title });
  };

  ctx.on("posts:open", (post) => {
    path = post.path;
    text = post.text;
    edited = saved = 0;
    opened = Date.now();
    show();
  });
  ctx.on("posts:change", (post) => {
    if (post.text !== text) edited = Date.now();
    text = post.text;
    show();
  });
  ctx.on("posts:save", (post) => {
    saved = Date.now();
    text = post.text;
    show();
  });
  ctx.on("posts:close", () => {
    path = null;
    show();
  });
  const post = await ctx.call("document", "read");
  if (post) ({ path, text } = post);
  opened = Date.now();
  show();
  setInterval(show, 30_000);
}
