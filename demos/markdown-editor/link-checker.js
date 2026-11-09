// Link checker: finds links to pages the site doesn't have, and external
// links whose server can't be reached. Runs when a post opens, when it is
// saved and when you ask (Check links), and agents can run it as a tool. It needs the network permission to try
// other sites.

export const manifest = {
  id: "link-checker",
  name: "Link checker",
  description: "Checks the post's links: internal ones against the site's pages and files, external ones by connecting to them.",
  version: "2.0.0",
  order: 90,
  permissions: ["ui", "network", "document:read", "folder:read", "hook:listen:posts:open", "hook:listen:posts:save", "hook:listen:posts:close"],
  services: ["document", "folder"],
};

const TIMEOUT_MS = 8000;

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/** Links in the post body: Markdown links and images, HTML href/src, and ref/relref shortcodes. */
function findLinks(post) {
  const body = post.text.slice(post.bodyStart);
  const out = [];
  const add = (url, index, length) => out.push({ url: url.trim(), from: post.bodyStart + index, to: post.bodyStart + index + length });
  for (const m of body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) add(m[1], m.index, m[0].length);
  for (const m of body.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/g)) add(m[1], m.index, m[0].length);
  for (const m of body.matchAll(/\{\{<\s*(?:rel)?ref\s+"([^"]+)"\s*>\}\}/g)) out.push({ url: m[1], ref: true, from: post.bodyStart + m.index, to: post.bodyStart + m.index + m[0].length });
  return out.filter((l) => l.url && !l.url.startsWith("#") && !/^(mailto|tel|javascript):/i.test(l.url) && !l.url.includes("{{"));
}

export default function (ctx) {
  const reachable = new Map();
  const status = (text, title) => ctx.ui.render("status", "links", text ? { type: "text", text, title } : null);

  /** Whether a server answers: an opaque answer (no-cors) still proves it is there. */
  const external = (url) => {
    if (!reachable.has(url)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      reachable.set(
        url,
        fetch(url, { method: "HEAD", mode: "no-cors", signal: controller.signal, redirect: "follow" })
          .then(() => true, () => false)
          .finally(() => clearTimeout(timer)),
      );
    }
    return reachable.get(url);
  };

  const internal = async (link, posts) => {
    if (link.ref) {
      const target = link.url.replace(/^\/+/, "").replace(/\/$/, "");
      return posts.some((p) => p.path.endsWith(target) || p.path.endsWith(`${target}.md`) || p.path.endsWith(`${target}/index.md`) || p.path.endsWith(`${target}/_index.md`));
    }
    const path = decodeURI(link.url.split(/[?#]/)[0]);
    const page = path.endsWith("/") ? path : `${path}/`;
    if (posts.some((p) => p.url === path || p.url === page)) return true;
    for (const dir of ["static", "assets"]) if ((await ctx.call("folder", "read", `${dir}${path}`).catch(() => null)) !== null) return true;
    return false;
  };

  const check = async () => {
    const post = await ctx.call("document", "read");
    if (!post) return [];
    const posts = await ctx.call("document", "list");
    const links = findLinks(post);
    status(`Checking ${links.length} links…`);
    const results = await Promise.all(
      links.map(async (link) => {
        const isExternal = /^(https?:)?\/\//i.test(link.url);
        let ok = true;
        if (isExternal) ok = await external(link.url.startsWith("//") ? `https:${link.url}` : link.url);
        else if (link.url.startsWith("/") || link.ref) ok = await internal(link, posts);
        return { ...link, ok, external: isExternal, line: lineOf(post.text, link.from) };
      }),
    );
    const broken = results.filter((r) => !r.ok);
    status(broken.length ? `${broken.length} broken links` : `${results.length} links OK`, broken.map((b) => `• ${b.url}`).join("\n") || "Every link resolved.");
    await ctx.call("document", "annotate", "broken-links", broken.map((b) => ({ from: b.from, to: b.to, severity: "warning", message: b.external ? `Couldn't reach ${b.url}` : `No page or file at ${b.url}` })));
    return results;
  };

  ctx.commands.add({ id: "check", title: "Check links" }, async () => {
    const results = await check();
    const broken = results.filter((r) => !r.ok).length;
    return results.length ? `${broken} of ${results.length} links look broken` : "The post has no links.";
  });
  ctx.commands.add(
    { id: "check-links", title: "Check links (report)", group: "Tools", description: "Checks every link in the open post: internal links against the site's pages and static files, external links by connecting to the server. Lists the broken ones with line numbers.", args: { type: "object", properties: {} } },
    async () => {
      const results = await check();
      const broken = results.filter((r) => !r.ok);
      if (!results.length) return "The post has no links.";
      return broken.length
        ? `${broken.length} of ${results.length} links look broken:\n${broken.map((b) => `- line ${b.line}: ${b.url} (${b.external ? "server unreachable" : "no such page or file"})`).join("\n")}`
        : `All ${results.length} links resolved.`;
    },
  );
  // A post is checked when it opens and each time it is saved; "Check links" checks it now.
  ctx.on("posts:open", () => {
    status("");
    void ctx.call("document", "annotate", "broken-links", []).then(check);
  });
  ctx.on("posts:save", () => void check());
  ctx.on("posts:close", () => status(""));
  void check();
}
