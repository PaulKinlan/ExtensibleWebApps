// Hugo preview: the open post as the site's own `hugo server` shows it, with
// the site's real theme, in a panel. Hugo runs on the person's computer (in
// the site folder they opened, `hugo server -D`), and the panel's
// <ui-site-preview> shows only a server on this device. Hugo reloads the page
// itself when a saved file changes; the panel also reloads it after each save.
// The server's address is kept, and can be changed in the panel.

export const manifest = {
  id: "hugo-preview",
  name: "Hugo preview",
  description: "Shows the open post as your site's own hugo server renders it, with your theme, next to the editor.",
  version: "1.0.0",
  order: 130,
  permissions: ["ui", "document:read", "folder:read", "hook:listen:posts:open", "hook:listen:posts:save", "hook:listen:posts:close"],
  services: ["document", "folder"],
};

const DEFAULT = "http://localhost:1313";

/** An origin typed in the panel, as http(s)://host:port, or null if it isn't one on this device. */
export function serverOrigin(text) {
  try {
    const url = new URL(/^https?:\/\//.test(text.trim()) ? text.trim() : `http://${text.trim()}`);
    const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return local ? url.origin : null;
  } catch {
    return null;
  }
}

export default async function (ctx) {
  let origin = (await ctx.storage.get("origin")) ?? DEFAULT;
  let shown = false;
  let post = null;
  let folder = null;
  let state = "";
  let saves = 0;
  let problem = "";

  const draw = () => {
    ctx.ui.render("toolbar", "button", { type: "button", label: shown ? "Hide preview" : "Preview", action: "toggle" });
    if (!shown) return ctx.ui.render("panels", "preview", null);
    const port = new URL(origin).port || "1313";
    ctx.ui.views("hugo-preview.html").render("panels", "preview", {
      origin,
      src: post ? new URL(post.url, origin).href : "",
      revision: String(saves),
      title: post?.title ?? "",
      none: !post,
      private: folder && !folder.picked,
      down: state === "down",
      blocked: state === "blocked",
      draft: post?.frontMatter?.draft === "true",
      command: `hugo server -D --port ${port}`,
      problem,
    });
  };

  const follow = async (p) => {
    post = p;
    if (shown) folder = await ctx.call("folder", "about");
    draw();
  };
  ctx.on("posts:open", follow);
  ctx.on("posts:close", () => follow(null));
  ctx.on("posts:save", (p) => {
    saves++;
    follow(p);
  });

  const toggle = async () => {
    shown = !shown;
    state = "";
    if (shown) {
      post = await ctx.call("document", "read");
      folder = await ctx.call("folder", "about");
    }
    draw();
  };
  ctx.commands.add({ id: "toggle", title: "Show or hide the Hugo preview" }, toggle);
  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") return toggle();
    if (action === "preview") {
      state = String(value);
      return draw();
    }
    if (action === "again") saves++;
    if (action === "server") {
      const next = serverOrigin(String(value?.origin ?? ""));
      problem = next ? "" : "The preview server must be on this device, such as localhost:1313.";
      if (next) {
        origin = next;
        await ctx.storage.set("origin", origin);
      }
    }
    draw();
  });
  draw();
}
