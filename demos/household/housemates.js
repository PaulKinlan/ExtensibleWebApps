// Housemates: who lives here, and who is using this device. In a space
// (/s/<space>/demos/household/) the housemates are the space's members, each
// with the name on their account, and the space says which of them this
// phone is signed in as: nobody types a name, and nobody can sign as someone
// else. Opened on its own (/demos/household/) it's one person's list.
//
// It also decides, once, whether this is a new household, and posts the
// answer to the bus topic `household-new`: groceries.js and chores.js add
// their sample items only then. The answer comes from the `household`
// collection, which syncs: a phone new to a space where people have cleared
// everything doesn't put the samples back.

export const manifest = {
  id: "housemates",
  name: "Housemates",
  description: "Everyone who lives here (the space's members), and who is using this device.",
  version: "2.0.0",
  permissions: ["ui", "members", "hook:listen:members:changed", "bus:post:household-new"],
  collections: {
    household: {
      title: "Household",
      schema: {
        type: "object",
        properties: {
          started: { type: "boolean", title: "Started" },
        },
      },
    },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("housemates.html");

  // A new household is one nobody has opened before, on any phone. Two phones that start it at once
  // write the same record, which the space takes as one.
  const started = await ctx.call("data", "get", "household", "started");
  if (!started) await ctx.call("data", "put", "household", { id: "started", started: true });
  await ctx.call("bus", "post", "household-new", JSON.stringify({ new: !started }));

  const view = views.live("who", "who", async (ctx) => {
    const { space, you, members } = await ctx.call("sync", "members");
    const people = members.map((m) => ({ id: m.id, name: m.name, you: m.id === you })).sort((a, b) => Number(b.you) - Number(a.you) || a.name.localeCompare(b.name));
    const me = people.find((p) => p.you);
    return { shared: !!space, me: me?.name ?? null, others: people.filter((p) => !p.you).map((p) => p.name).join(", ") };
  });

  // The space says who its members are when the page connects, and again whenever it reconnects.
  ctx.on("members:changed", () => view.refresh());
}
