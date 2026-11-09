// Read here: the feed reader with no space. It reads each feed you follow
// through this site's feed reader (GET /feed-reader?url=…, which
// src/server/feed-reader.ts answers with the feed's text only), while the
// app is open: when it starts, when you follow a feed, and every half hour.
// What it finds it keeps on this device, in two collections of its own:
//
//   here-items    one record a story, as fetch.js keeps them in a space
//   here-fetched  one record a feed: its title, when it was read, what went wrong
//
// Most sites don't let a page read their feed itself (no CORS), so it asks
// the site the page came from instead. No sign-in, no space.
//
// Open the app in a space and this does nothing: the space's server reads
// the feeds there (fetch.js), with no one's browser open, and every member
// gets the stories. Turn it off in Customize and the app only lists feeds.

export const manifest = {
  id: "feeds-here",
  name: "Read feeds here",
  description: "Without a space, reads the feeds you follow on this device, through this site, while the app is open.",
  version: "1.0.0",
  // `network` lets its worker fetch from this site (connect-src 'self'), where the feed reader is.
  permissions: ["network", "schedule", "sync", "data:read:feeds"],
  services: ["sync"],
  collections: {
    "here-items": {
      title: "Stories read on this device",
      schema: {
        type: "object",
        required: ["feed", "title"],
        properties: {
          feed: { type: "string", title: "Feed" },
          title: { type: "string", title: "Title", maxLength: 300 },
          link: { type: "string", title: "Link", maxLength: 2000 },
          published: { type: "string", title: "Published" },
          summary: { type: "string", title: "Summary", maxLength: 400 },
        },
      },
    },
    "here-fetched": {
      title: "Feeds read on this device",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Title", maxLength: 200 },
          at: { type: "string", title: "Last read" },
          error: { type: "string", title: "What went wrong", maxLength: 300 },
          count: { type: "number", title: "Stories" },
        },
      },
    },
  },
};

const EVERY = 30 * 60 * 1000;
const KEEP = 50;

export default async function (ctx) {
  // In a space, the space's server reads the feeds (fetch.js): nothing to do here.
  if ((await ctx.call("sync", "state")).space) return;

  /** One feed at a time, so two reads of the same feed don't both add its stories. */
  let reading = Promise.resolve();
  const inTurn = (work) => {
    const turn = reading.then(work);
    reading = turn.catch(() => {});
    return turn;
  };

  const read = (feed) =>
    inTurn(async () => {
      try {
        const now = (await ctx.call("data", "list", "feeds")).find((f) => f.id === feed.id);
        if (!now || now.url !== feed.url) return;
        const answer = await fetch(`/feed-reader?url=${encodeURIComponent(feed.url)}`);
        const said = await answer.json().catch(() => ({ error: `This site has no feed reader (it answered ${answer.status})` }));
        if (!answer.ok || said.error) throw new Error(said.error ?? `The feed reader answered ${answer.status}`);
        const had = new Set((await ctx.call("data", "list", "here-items")).filter((i) => i.feed === feed.id).map((i) => i.id));
        for (const item of said.items.slice(0, KEEP)) {
          const id = `${hash(feed.id)}-${hash(item.key)}${hash(`\n${item.key}`)}`;
          if (had.has(id)) continue;
          await ctx.call("data", "put", "here-items", { id, feed: feed.id, title: item.title, link: item.link, published: item.published, summary: item.summary });
        }
        await trim(feed.id);
        await ctx.call("data", "put", "here-fetched", { id: feed.id, title: said.title || feed.url, at: new Date().toISOString(), count: said.items.length });
      } catch (error) {
        await ctx.call("data", "put", "here-fetched", { id: feed.id, at: new Date().toISOString(), error: String(error?.message ?? error).slice(0, 300) });
      }
    });

  /** Keeps a feed's newest stories, and lets the rest go. */
  const trim = async (feed) => {
    const mine = (await ctx.call("data", "list", "here-items")).filter((i) => i.feed === feed).sort((a, b) => (b.published || b.createdAt).localeCompare(a.published || a.createdAt));
    for (const old of mine.slice(KEEP)) await ctx.call("data", "delete", "here-items", old.id);
  };

  /** A feed taken away: its stories and its record go too. */
  const forget = (feed) =>
    inTurn(async () => {
      for (const item of (await ctx.call("data", "list", "here-items")).filter((i) => i.feed === feed)) await ctx.call("data", "delete", "here-items", item.id);
      await ctx.call("data", "delete", "here-fetched", feed);
    });

  const readAll = async () => {
    for (const feed of await ctx.call("data", "list", "feeds")) await read(feed);
  };

  ctx.on("data:changed:feeds", (change) => {
    if (change.after && change.after.url !== change.before?.url) void read(change.after);
    if (!change.after && change.before) void forget(change.before.id);
  });
  ctx.schedule.every("refresh", EVERY, readAll);
  await readAll();
}

/** A short, stable name for a story (FNV-1a), as fetch.js makes them. */
function hash(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
