// Edit and save times: when the post was last edited and last saved.

export const manifest = {
  id: "edit-times",
  name: "Edit and save times",
  order: 30,
  description: "Shows when you last edited and last saved the post.",
  version: "1.0.0",
  permissions: ["post:read", "ui"],
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

export default function (editor) {
  const status = editor.ui.status("times", "");
  let path = null;
  let edited = 0;
  let saved = 0;
  let text = "";

  const show = () => {
    if (!path) return status.set("");
    const parts = [];
    if (edited) parts.push(`Edited ${ago(edited)}`);
    if (saved) parts.push(`Saved ${clock(saved)}`);
    status.set(parts.join(" · "), [edited && `Last edit ${new Date(edited).toLocaleString()}`, saved && `Last save ${new Date(saved).toLocaleString()}`].filter(Boolean).join("\n"));
  };

  editor.on("post:open", (post) => {
    path = post.path;
    text = post.text;
    edited = saved = 0;
    show();
  });
  editor.on("post:change", (post) => {
    if (post.text !== text) edited = Date.now();
    text = post.text;
    show();
  });
  editor.on("post:save", (post) => {
    saved = Date.now();
    text = post.text;
    show();
  });
  editor.on("post:close", () => {
    path = null;
    show();
  });
  if (editor.document.post) {
    path = editor.document.post.path;
    text = editor.document.post.text;
  }
  setInterval(show, 30_000);
}
