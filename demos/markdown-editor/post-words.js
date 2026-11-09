// Post words (the editor's word count): the post's words and reading time in the status bar.
// It hears the post from the posts plugin's hooks.

export const manifest = {
  id: "post-words",
  name: "Word count",
  description: "Shows the post's word count and reading time in the status bar.",
  version: "2.0.0",
  order: 10,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:save", "hook:listen:posts:close"],
  services: ["document"],
};

const WORDS_PER_MINUTE = 230;

/** Words in the post's body, in any script. */
const count = (post) => (post.text.slice(post.bodyStart).match(/[\p{L}\p{N}’']+/gu) ?? []).length;

export default async function (ctx) {
  const show = (post) => {
    if (!post) return ctx.ui.render("status", "words", null);
    const words = count(post);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    ctx.ui.render("status", "words", { type: "text", text: `${words.toLocaleString()} words · ${minutes} min read`, title: `Reading time at ${WORDS_PER_MINUTE} words a minute` });
  };
  ctx.on("posts:open", show);
  ctx.on("posts:change", show);
  ctx.on("posts:save", show);
  ctx.on("posts:close", () => show(null));
  show(await ctx.call("document", "read"));
}
