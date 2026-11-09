// Feeds: the reader, in the browser. It owns the `feeds` collection (the
// address of each feed you follow) and draws the stories fetch.js keeps in
// `items`, newest first, with what fetch.js says about each feed in
// `fetched`: its title, when it was read, and what went wrong.
//
// Who reads the feeds depends on where the app is open. On its own, with no
// sign-in, read-here.js reads them on this device while the app is open and
// keeps the stories in `here-items` and `here-fetched`. In a space
// (/s/<space>/demos/feeds/), the space's server reads them (fetch.js) every
// half hour, with no one's browser open, into `items` and `fetched`. This
// plugin draws whichever it finds: only one of the two ever writes.

export const manifest = {
  id: "feeds",
  name: "Feeds",
  description: "Follow RSS and Atom feeds, and read their stories.",
  version: "1.0.0",
  permissions: ["ui", "data:read:items", "data:read:fetched", "data:read:here-items", "data:read:here-fetched", "sync"],
  order: 10,
  collections: {
    feeds: {
      title: "Feeds",
      schema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", title: "Feed address", description: "An RSS or Atom feed, at https://", maxLength: 200 },
        },
      },
    },
  },
};

const SHOWN = 60;

export default async function (ctx) {
  const views = ctx.ui.views("feeds.html");
  /** Which feed's stories are shown: one feed's id, or every feed's. */
  let only = "";

  const reader = views.live("main", "feeds", async (ctx) => {
    const list = (name) => ctx.call("data", "list", name).catch(() => []);
    const [feeds, server, serverFetched, here, hereFetched, sync] = await Promise.all([list("feeds"), list("items"), list("fetched"), list("here-items"), list("here-fetched"), ctx.call("sync", "state")]);
    const items = [...server, ...here];
    const fetched = [...serverFetched, ...hereFetched];
    const about = new Map(fetched.map((f) => [f.id, f]));
    const name = (id) => decode(about.get(id)?.title || feeds.find((f) => f.id === id)?.url || "A feed");
    if (only && !feeds.some((f) => f.id === only)) only = "";
    const stories = items
      .filter((i) => !only || i.feed === only)
      .sort((a, b) => (b.published || b.createdAt).localeCompare(a.published || a.createdAt))
      .slice(0, SHOWN)
      .map((i) => ({ id: i.id, title: decode(i.title), link: i.link ?? "", summary: decode(i.summary ?? ""), feed: name(i.feed), when: i.published ? new Date(i.published).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "" }));
    return {
      space: sync.space ?? null,
      only,
      feeds: feeds.map((f) => {
        const a = about.get(f.id);
        return {
          id: f.id,
          url: f.url,
          title: decode(a?.title || f.url),
          error: a?.error ?? "",
          state: !a ? "Not read yet" : a.error ? "" : `${a.count ?? 0} stories, read ${new Date(a.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
          shown: only === f.id,
        };
      }),
      stories,
    };
  });

  ctx.ui.onEvent(async (action, value) => {
    if (action === "show") only = only === value ? "" : String(value);
    if (action === "all") only = "";
    if (action === "remove") await ctx.call("data", "delete", "feeds", value);
    reader.refresh();
  });
}

/**
 * Stories kept before the reader knew more than XML's five entities still hold "&rsquo;" and the like as
 * text: shown here as the characters they name. Text only, so this never makes HTML.
 */
const NAMED = { rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–", nbsp: " ", bull: "•", middot: "·", copy: "©", trade: "™", laquo: "«", raquo: "»" };
function decode(text) {
  return String(text).replace(/&([a-z]+);/gi, (all, e) => NAMED[e.toLowerCase()] ?? all);
}
