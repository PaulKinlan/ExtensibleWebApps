// Front matter: a form over the open post's front matter, in a panel. Each
// field gets a control that fits its value: a checkbox for true or false
// (draft), a comma-separated list for tags and categories, a box with a Now
// button for dates, a larger box for the description and summary, and a line
// for the rest. A change goes into the post through the document service's
// setFrontMatter, in the front matter's own format (YAML, TOML or JSON), as an
// edit the person can undo; the post is saved when they save it. A field the
// form can't show (a map under a key) stays as it is in the text.
//
// The description and summary each get a Draft button, as in the original
// editor: the browser's own on-device summarizer (the <ui-summarizer>
// element, which runs in the page) reads the post's prose and writes a short
// draft into the field, which Undo takes out again. Nothing leaves the
// device, and in a browser without one the button isn't there.

export const manifest = {
  id: "front-matter",
  name: "Front matter",
  description: "A form for the post's front matter: title, date, draft, tags and the rest, each with a control that fits.",
  version: "1.0.0",
  order: 105,
  permissions: ["ui", "document:read", "document:write", "hook:listen:posts:open", "hook:listen:posts:change", "hook:listen:posts:save", "hook:listen:posts:close"],
  services: ["document"],
};

const DATES = new Set(["date", "lastmod", "publishdate", "expirydate"]);
const LONG = new Set(["description", "summary"]);
/** The longest prose handed to the summarizer, which halves it again if the model says it is too long. */
const MAX_PROSE = 20_000;
/** Shown first, in this order; the rest follow as the file has them. */
const FIRST = ["title", "slug", "date", "draft", "description", "summary", "tags", "categories"];

/** The form's fields for a post's front matter: each with the kind of control that fits its value. */
export function fieldsOf(frontMatter = {}) {
  const keys = Object.keys(frontMatter);
  const ordered = [...FIRST.filter((k) => keys.includes(k)), ...keys.filter((k) => !FIRST.includes(k))];
  return ordered.map((key) => {
    const value = frontMatter[key];
    const field = { key, label: key.replace(/[_-]+/g, " ") };
    if (Array.isArray(value)) return { ...field, list: true, value: value.join(", ") };
    const text = String(value ?? "");
    if (text === "true" || text === "false") return { ...field, check: true, value: text === "true" };
    if (DATES.has(key)) return { ...field, date: true, value: text };
    if (LONG.has(key) || text.length > 90 || text.includes("\n")) return { ...field, long: true, value: text };
    return { ...field, line: true, value: text, number: /^-?\d+(\.\d+)?$/.test(text) };
  });
}

/** A post's body as a summary should read it: no code, shortcodes, HTML, images or link addresses. */
export function proseOnly(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\{\{[<%][\s\S]*?[%>]\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PROSE);
}

/** How the summarizer should write for a field: a teaser for a description, a short summary for the rest. */
export function draftFor(key, siteName) {
  return {
    kind: key.toLowerCase() === "description" ? "teaser" : "tldr",
    context: `A post from the blog "${siteName || "Site"}", summarised for its ${key} field. Write in the author's voice, not about "the author".`,
  };
}

/** What a control sent, as the value to set: a list from comma-separated text, a number for a number field. */
export function valueFor(field, sent) {
  if (field?.list) return String(sent ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (field?.check) return sent === true;
  const text = String(sent ?? "");
  if (field?.number && /^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text.trim());
  return text;
}

export default async function (ctx) {
  let post = null;
  let shown = (await ctx.storage.get("shown")) ?? true;
  let problem = "";

  const draw = () => {
    if (!post) return ctx.ui.render("panels", "form", null);
    const fields = fieldsOf(post.frontMatter).map((f) => (LONG.has(f.key) ? { ...f, draft: { label: `Draft ${f.key}`, ...draftFor(f.key, post.siteName) } } : f));
    const source = proseOnly(post.text.slice(post.bodyStart));
    // With no description yet, the form offers to draft one.
    const describe = "description" in (post.frontMatter ?? {}) ? null : { label: "Draft a description", ...draftFor("description", post.siteName) };
    ctx.ui.views("front-matter.html").render("panels", "form", { shown, fields, empty: !Object.keys(post.frontMatter ?? {}).length, problem, source, describe, path: post.path });
  };
  const follow = (p) => {
    post = p;
    draw();
  };
  ctx.on("posts:open", (p) => {
    problem = "";
    follow(p);
  });
  ctx.on("posts:change", follow);
  ctx.on("posts:save", follow);
  ctx.on("posts:close", () => follow(null));

  const set = async (key, value) => {
    problem = (await ctx.call("document", "setFrontMatter", key, value)) ? "" : `Couldn't set ${key}.`;
    draw();
  };

  ctx.ui.onEvent(async (action, value) => {
    if (action === "toggle") {
      shown = !shown;
      await ctx.storage.set("shown", shown);
      return draw();
    }
    if (!post) return;
    const field = (key) => fieldsOf(post.frontMatter).find((f) => f.key === key);
    if (action.startsWith("set:")) return set(action.slice(4), valueFor(field(action.slice(4)), value));
    if (action.startsWith("draft:")) {
      // What <ui-summarizer> wrote ({ text }), or why it couldn't ({ error }).
      const key = action.slice(6);
      // A draft of a post that is no longer open (it took a while, and the person moved on) is dropped.
      if (!LONG.has(key) || value?.subject !== post.path) return;
      if (typeof value?.text === "string" && value.text.trim()) return set(key, value.text.trim());
      problem = typeof value?.error === "string" ? value.error : `Couldn't draft the ${key}.`;
      return draw();
    }
    if (action.startsWith("now:")) return set(action.slice(4), new Date().toISOString().replace(/\.\d+Z$/, "Z"));
    if (action.startsWith("remove:")) return set(action.slice(7), null);
    if (action === "add") {
      const key = String(value?.key ?? "").trim();
      if (!/^[A-Za-z_][\w-]*$/.test(key)) {
        problem = "A field's name is letters, digits, - and _, starting with a letter.";
        return draw();
      }
      return set(key, String(value?.value ?? ""));
    }
  });

  ctx.commands.add({ id: "toggle", title: "Show or hide the front matter form" }, async () => {
    shown = !shown;
    await ctx.storage.set("shown", shown);
    draw();
  });
  follow(await ctx.call("document", "read"));
}
