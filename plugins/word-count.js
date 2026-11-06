// Word count: the post's words and reading time in the status bar.

export const manifest = {
  id: "word-count",
  name: "Word count",
  order: 10,
  description: "Shows the post's word count and reading time in the status bar.",
  version: "1.0.0",
  permissions: ["post:read", "ui"],
};

const WORDS_PER_MINUTE = 230;

function count(post) {
  return (post.text.slice(post.bodyStart).match(/[\p{L}\p{N}’']+/gu) ?? []).length;
}

export default function (editor) {
  const status = editor.ui.status("words", "");
  const update = (post) => {
    if (!post) return status.set("");
    const words = count(post);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    status.set(`${words.toLocaleString()} words · ${minutes} min read`, `Reading time at ${WORDS_PER_MINUTE} words a minute`);
  };
  editor.on("post:open", update);
  editor.on("post:change", update);
  editor.on("post:save", update);
  editor.on("post:close", () => status.set(""));
  if (editor.document.post) update(editor.document.post);
}
