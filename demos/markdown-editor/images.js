// Images: a picture you paste or drop on the post is saved in the site's
// folder, and a link to it goes in where you pasted.
//
// Where it goes: next to the post when the post is a page bundle (a folder
// with an index.md, whose pictures are its own resources, linked by their
// name), and otherwise under static/images/<post>/, which Hugo serves at the
// site's root. Its settings can send every picture to static/ instead.
// What goes in: a Markdown image, or Hugo's built-in figure shortcode, as its
// settings say.
//
// A file of the same name is never replaced: a pasted screenshot (always
// image.png) gets -2, -3, … instead. It listens to the posts plugin's paste
// and drop hooks, and answers with the text to put in, so a paste with no
// image goes in as it would without it. The picture's bytes never cross the
// hook: it carries a token, and the posts plugin saves the picture for it
// (document.saveImage), so a large screenshot fits and two pastes at once
// can't pick the same name.

export const manifest = {
  id: "images",
  name: "Images",
  description: "Saves images you paste or drop on a post next to it (a page bundle) or in static/images/, and puts a Markdown image or Hugo figure for each in the post.",
  version: "1.1.0",
  order: 120,
  permissions: ["document:read", "document:write", "hook:intercept:posts:paste", "hook:intercept:posts:drop"],
  services: ["document"],
  settings: {
    place: { type: "string", title: "Save pictures", enum: ["Next to the post, when it is a page bundle", "Always in static/images/"], default: "Next to the post, when it is a page bundle" },
    insert: { type: "string", title: "Put in the post", enum: ["A Markdown image", "Hugo's figure shortcode"], default: "A Markdown image" },
  },
};

/** The settings' choices, as the manifest lists them. */
const BUNDLE = "Next to the post, when it is a page bundle";
const STATIC = "Always in static/images/";
const MARKDOWN = "A Markdown image";
const FIGURE = "Hugo's figure shortcode";

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);

/** Whether a post is a page bundle: an index.md (or _index.md) in a folder of its own under content/. */
export const isBundle = (post) => /^content\/.+\/_?index\.(md|markdown)$/i.test(post?.path ?? "");

/** The folder a post's images go in, under static/: images/<slug>, from the slug field or the file's name (its folder's, for a bundle's index.md). */
export function folderFor(post) {
  const parts = post.path.replace(/\.(md|markdown)$/i, "").split("/");
  const name = post.frontMatter?.slug || (/^_?index$/.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1));
  return `images/${slugify(name) || "post"}`;
}

/**
 * Where a post's pictures are saved, and the address the post links them by: the bundle's own folder and
 * the file's name for a page bundle (unless the settings say static/), static/images/<post>/ and /images/<post>/… otherwise.
 */
export function placeFor(post, place = BUNDLE) {
  if (place !== STATIC && isBundle(post)) {
    const dir = post.path.replace(/\/[^/]+$/, "");
    return { dir, link: (path) => path.slice(dir.length + 1) };
  }
  const dir = `static/${folderFor(post)}`;
  return { dir, link: (path) => path.replace(/^static/, "") };
}

/** The text for one picture: a Markdown image, or Hugo's figure shortcode. */
export function imageText(src, alt, insert = MARKDOWN) {
  if (insert === FIGURE) return `{{< figure src="${src.replace(/"/g, "%22")}" alt="${alt.replace(/"/g, "'")}" caption="" >}}`;
  return `![${alt.replace(/[[\]]/g, "")}](${/[\s()]/.test(src) ? `<${src}>` : src})`;
}

export default async function (ctx) {
  let settings = {};
  ctx.settings.onChange((values) => (settings = values ?? {}));

  /** Saves the images among a paste's or drop's files, and answers with the text for them; nothing when there are none. */
  const take = async ({ files, from, to }) => {
    const images = (Array.isArray(files) ? files : []).filter((f) => typeof f?.image === "string");
    if (!images.length) return undefined;
    const post = await ctx.call("document", "read");
    if (!post) return undefined;
    const { dir, link } = placeFor(post, settings.place);
    const texts = [];
    for (const file of images) {
      const base = slugify(String(file.name ?? "").replace(/\.[^.]+$/, "")) || "image";
      // posts.js keeps the bytes and picks a free name, one picture at a time: never over another file.
      const saved = await ctx.call("document", "saveImage", file.image, dir, base);
      if (saved) texts.push(imageText(link(saved.path), base.replace(/-/g, " "), settings.insert));
    }
    if (!texts.length) return undefined;
    // Each image a paragraph of its own: blank lines around it unless the paste is already at a line's start or end.
    const before = post.text.slice(0, from).slice(-2);
    const after = post.text.slice(to, to + 2);
    const lead = !before || before === "\n\n" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const tail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    return { text: lead + texts.join("\n\n") + tail };
  };
  ctx.on("posts:paste", take);
  ctx.on("posts:drop", take);
  settings = (await ctx.settings.get()) ?? {};
}
