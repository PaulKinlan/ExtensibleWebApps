// Snippets: saved bits of text to put in the post, from this browser or the
// site's .editor/snippets.json ({ "name": "text" }). {{date}}, {{time}} and
// {{title}} are filled in when one goes in. "Insert snippet…"
// (Mod+Shift+X) opens the list; "Save selection as snippet…" names the
// selected text and keeps it.

export const manifest = {
  id: "snippets",
  name: "Snippets",
  description: "Insert saved snippets of text (Mod+Shift+X), save the selection as one, or share them in the site's .editor/snippets.json.",
  version: "2.0.0",
  order: 160,
  permissions: ["ui", "document:read", "document:write", "folder:read", "hook:listen:posts:close"],
  services: ["document", "folder"],
};

const SITE_FILE = ".editor/snippets.json";

const fill = (text, post) => {
  const now = new Date();
  return text.replaceAll("{{date}}", now.toISOString().slice(0, 10)).replaceAll("{{time}}", now.toTimeString().slice(0, 5)).replaceAll("{{title}}", post?.title ?? "");
};

export default function (ctx) {
  /** What the panel shows: null (closed), "insert", "remove" or "save". */
  let showing = null;
  let list = [];
  let selected = "";
  let note = "";

  const mine = async () => (await ctx.storage.get("snippets")) ?? {};
  const fromSite = async () => {
    try {
      const text = await ctx.call("folder", "read", SITE_FILE);
      return text ? JSON.parse(text) : {};
    } catch (error) {
      note = `${SITE_FILE} isn't valid JSON: ${error instanceof Error ? error.message : error}`;
      return {};
    }
  };

  const draw = () => {
    if (!showing) return ctx.ui.render("panels", "snippets", null);
    ctx.ui.views("snippets.html").render("panels", "snippets", {
      insert: showing === "insert",
      remove: showing === "remove",
      save: showing === "save",
      items: list.map((name, i) => ({ i, name })),
      none: !list.length,
      selected,
      note,
    });
  };

  const open = async (what) => {
    note = "";
    showing = what;
    if (what === "insert") list = Object.keys({ ...(await fromSite()), ...(await mine()) }).sort();
    if (what === "remove") list = Object.keys(await mine()).sort();
    if (what === "save") {
      const post = await ctx.call("document", "read");
      selected = post ? post.text.slice(post.selection.from, post.selection.to) : "";
      if (!selected) note = "Select the text to save as a snippet first.";
    }
    draw();
  };

  ctx.commands.add({ id: "insert", title: "Insert snippet…", keys: ["Mod+Shift+X"] }, () => open("insert"));
  ctx.commands.add({ id: "save", title: "Save selection as snippet…" }, () => open("save"));
  ctx.commands.add({ id: "remove", title: "Remove snippet…" }, () => open("remove"));

  ctx.ui.render("toolbar", "button", { type: "button", label: "Snippets", action: "toggle" });
  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") return showing ? ((showing = null), draw()) : open("insert");
    if (action === "close") showing = null;
    if (action.startsWith("insert:")) {
      const name = list[Number(action.slice(7))];
      const all = { ...(await fromSite()), ...(await mine()) };
      if (name in all) await ctx.call("document", "insert", fill(String(all[name]), await ctx.call("document", "read")));
      showing = null;
    }
    if (action.startsWith("remove:")) {
      const snippets = await mine();
      delete snippets[list[Number(action.slice(7))]];
      await ctx.storage.set("snippets", snippets);
      list = Object.keys(snippets).sort();
    }
    if (action === "keep") {
      const name = String(value?.name ?? "").trim();
      if (name && selected) {
        await ctx.storage.set("snippets", { ...(await mine()), [name]: selected });
        note = `Saved snippet “${name}”.`;
        showing = null;
      }
    }
    draw();
  });
  ctx.on("posts:close", () => {
    showing = null;
    draw();
  });
}
