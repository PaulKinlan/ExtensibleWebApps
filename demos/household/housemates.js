// Housemates: owns the `housemates` collection, everyone's name, which syncs
// to every device in the space like any collection. It also asks who is
// using this device, and remembers the answer here alone (in its own
// storage, which never leaves the device).
//
// The other plugins learn the answer from the bus: this plugin posts it to
// the topic `household-me`, and they read the latest post. The bus is kept
// by this device's kernel, so each phone has its own "me". The plugins never
// call each other; a post is information, not permission.

export const manifest = {
  id: "housemates",
  name: "Housemates",
  description: "Everyone who lives here, and who is using this device.",
  version: "1.0.0",
  permissions: ["ui", "bus:post:household-me", "bus:read:household-me", "hook:listen:bus:posted"],
  collections: {
    housemates: {
      title: "Housemates",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Name", maxLength: 40 },
        },
      },
    },
  },
};

const TOPIC = "household-me";

export default async function (ctx) {
  const views = ctx.ui.views("housemates.html");
  /** Bumped after each join, so the template's form is drawn fresh, with its field empty. */
  let joined = 0;
  /** Showing the list to pick from again, after "Not you?". */
  let choosing = false;

  /** Who this device is, as the last post on the topic says: { id, name } or null. */
  const me = async () => {
    const posts = await ctx.call("bus", "read", TOPIC);
    try {
      return posts.length ? JSON.parse(posts[posts.length - 1].text) : null;
    } catch {
      return null;
    }
  };
  const become = (person) => ctx.call("bus", "post", TOPIC, JSON.stringify(person ? { id: person.id, name: person.name } : null));

  const view = views.live("who", "who", async (ctx) => {
    const people = (await ctx.call("data", "list", "housemates")).sort((a, b) => a.name.localeCompare(b.name));
    let current = await me();
    // Someone renamed on another device is still them here; someone removed isn't anyone.
    const still = current && people.find((p) => p.id === current.id);
    if (current && !still) current = null;
    if (still && still.name !== current.name) await become(still);
    return {
      me: current && !choosing ? still.name : null,
      choosing: !current || choosing,
      people: people.map((p) => ({ id: p.id, name: p.name })),
      form: `join-${joined}`,
    };
  });

  ctx.on("bus:posted", ({ topic }) => topic === TOPIC && view.refresh());

  ctx.ui.onEvent(async (action, value) => {
    if (action === "change") {
      choosing = true;
      view.refresh();
    }
    if (action.startsWith("pick:")) {
      const person = await ctx.call("data", "get", "housemates", action.slice(5));
      if (!person) return;
      choosing = false;
      await become(person);
    }
    if (action === "join" && value.name?.trim()) {
      const name = value.name.trim();
      // Joining under a name someone already has is them, on a new device.
      const people = await ctx.call("data", "list", "housemates");
      const found = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const result = found ? { ok: true, id: found.id } : await ctx.call("data", "put", "housemates", { name });
      if (!result.ok) return;
      joined++;
      choosing = false;
      await become({ id: result.id, name: found?.name ?? name });
    }
  });
}
