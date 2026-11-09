// Edit and save times: when the open note was last edited and last saved, in
// the status bar. It hears the note through the notes plugin's hooks.

export const manifest = {
  id: "edit-times",
  name: "Edit and save times",
  order: 30,
  description: "Shows when you last edited and last saved the note.",
  version: "2.0.0",
  permissions: ["ui", "hook:listen:notes:open", "hook:listen:notes:change", "hook:listen:notes:save", "hook:listen:notes:close"],
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

export default function (ctx) {
  let open = false;
  let edited = 0;
  let saved = 0;
  let text = "";

  const show = () => {
    const parts = [];
    if (edited) parts.push(`Edited ${ago(edited)}`);
    if (saved) parts.push(`Saved ${clock(saved)}`);
    if (!open || !parts.length) return ctx.ui.render("status", "times", null);
    const title = [edited && `Last edit ${new Date(edited).toLocaleString()}`, saved && `Last save ${new Date(saved).toLocaleString()}`].filter(Boolean).join("\n");
    ctx.ui.render("status", "times", { type: "text", text: parts.join(" · "), title });
  };

  ctx.on("notes:open", (note) => {
    open = true;
    text = note.text;
    edited = saved = 0;
    show();
  });
  ctx.on("notes:change", (note) => {
    if (note.text !== text) edited = Date.now();
    text = note.text;
    show();
  });
  ctx.on("notes:save", (note) => {
    saved = Date.now();
    text = note.text;
    show();
  });
  ctx.on("notes:close", () => {
    open = false;
    show();
  });
  setInterval(show, 30_000);
}
