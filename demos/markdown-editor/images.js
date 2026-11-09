// Images: a picture you paste or drop on the post is saved in the site's
// static/ folder, under static/images/<post>/, and a Markdown image pointing
// at it goes in where you pasted. Hugo serves static/ at the site's root, so
// the link works on the built site. A file of the same name is never
// replaced: a pasted screenshot (always image.png) gets -2, -3, … instead.
// It listens to the posts plugin's paste and drop hooks, and answers with the
// text to put in, so a paste with no image goes in as it would without it.

export const manifest = {
  id: "images",
  name: "Images",
  description: "Saves images you paste or drop on a post in the site's static/images/ folder, and puts a link to each in the post.",
  version: "1.0.0",
  order: 120,
  permissions: ["document:read", "folder:read", "folder:write", "hook:intercept:posts:paste", "hook:intercept:posts:drop"],
  services: ["document", "folder"],
};

const TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg" };

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);

/** The folder a post's images go in, under static/: images/<slug>, from the slug field or the file's name (its folder's, for a bundle's index.md). */
export function folderFor(post) {
  const parts = post.path.replace(/\.(md|markdown)$/i, "").split("/");
  const name = post.frontMatter?.slug || (/^_?index$/.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1));
  return `images/${slugify(name) || "post"}`;
}

export default function (ctx) {
  /** Saves the images among a paste's or drop's files, and answers with the Markdown for them; nothing when there are none. */
  const take = async ({ files, from, to }) => {
    const images = (Array.isArray(files) ? files : []).filter((f) => typeof f?.dataUrl === "string" && TYPES[f.type]);
    if (!images.length) return undefined;
    const post = await ctx.call("document", "read");
    if (!post) return undefined;
    const dir = folderFor(post);
    const links = [];
    for (const file of images) {
      const base = slugify(String(file.name ?? "").replace(/\.[^.]+$/, "")) || "image";
      const ext = TYPES[file.type];
      let url = `/${dir}/${base}${ext}`;
      for (let n = 2; await ctx.call("folder", "exists", `static${url}`); n++) url = `/${dir}/${base}-${n}${ext}`;
      await ctx.call("folder", "writeData", `static${url}`, file.dataUrl);
      links.push(`![${base.replace(/-/g, " ")}](${url})`);
    }
    // Each image a paragraph of its own: blank lines around it unless the paste is already at a line's start or end.
    const before = post.text.slice(0, from).slice(-2);
    const after = post.text.slice(to, to + 2);
    const lead = !before || before === "\n\n" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const tail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    return { text: lead + links.join("\n\n") + tail };
  };
  ctx.on("posts:paste", take);
  ctx.on("posts:drop", take);
}
