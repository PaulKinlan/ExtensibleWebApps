// Autosave: saves the post a few seconds after you stop typing, or on a
// timer. Off until you add it in Customize (the app offers it), as in
// the editor; when it saves is its setting.

export const manifest = {
  id: "autosave",
  name: "Autosave",
  description: "Saves the post a few seconds after you stop typing, or every few minutes. Pick when in its settings.",
  version: "2.0.0",
  order: 130,
  permissions: ["ui", "document:read", "document:write", "hook:listen:posts:change", "hook:listen:posts:close"],
  services: ["document"],
  settings: {
    when: {
      type: "string",
      title: "Save",
      enum: ["2 seconds after I stop typing", "5 seconds after I stop typing", "30 seconds after I stop typing", "Every minute", "Every 5 minutes"],
      default: "5 seconds after I stop typing",
    },
  },
};

/** What a setting means: seconds idle before saving, or seconds between saves. */
const modeOf = (label) => {
  const n = Number(/\d+/.exec(label ?? "")?.[0] ?? 5);
  if (/^Every minute/.test(label)) return { every: 60 };
  if (/^Every/.test(label)) return { every: n * 60 };
  return { idle: n };
};

export default async function (ctx) {
  let label = (await ctx.settings.get()).when;
  let mode = modeOf(label);
  let idleTimer;
  let everyTimer;

  const save = async () => {
    const post = await ctx.call("document", "read");
    if (post?.unsaved) await ctx.call("document", "save");
  };
  const apply = () => {
    clearTimeout(idleTimer);
    clearInterval(everyTimer);
    if (mode.every) everyTimer = setInterval(save, mode.every * 1000);
    ctx.ui.render("status", "autosave", { type: "text", text: "Autosave", title: `Autosave: ${String(label).toLowerCase()}` });
  };

  ctx.on("posts:change", (post) => {
    if (!mode.idle || !post.unsaved) return;
    clearTimeout(idleTimer);
    // posts:change already comes about 300 ms after the last keystroke.
    idleTimer = setTimeout(save, Math.max(0, mode.idle * 1000 - 300));
  });
  ctx.on("posts:close", () => clearTimeout(idleTimer));
  ctx.settings.onChange((values) => {
    label = values.when;
    mode = modeOf(label);
    apply();
  });
  apply();
}
