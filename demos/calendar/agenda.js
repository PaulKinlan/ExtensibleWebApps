// Agenda: the next two weeks, day by day. It reads two collections:
//
//   events    this app's, owned by events.js
//   contacts  the contacts app's, owned by ../contacts/people.js
//
// The contacts' owner doesn't have to be running. The kernel keeps which
// plugin owns each collection with the data, so once the contacts app has
// run, any plugin with `data:read:contacts` can read them. Until then the
// collection doesn't exist: reading it gives an empty list, and the agenda
// checks data.collections() to say why there are no birthdays.
//
// The agenda is a live view. Its function reads both collections, so a
// change to either draws it again; the contacts are followed even before
// they exist, so the birthdays appear as soon as the contacts app first
// runs, in any tab.

export const manifest = {
  id: "agenda",
  name: "Agenda",
  description: "The next two weeks: events, and birthdays from your contacts.",
  version: "1.0.0",
  permissions: ["ui", "data:read:events", "data:read:contacts"],
};

const DAYS = 14;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function (ctx) {
  const views = ctx.ui.views("agenda.html");

  views.live("side", "agenda", async (ctx) => {
    const events = await ctx.call("data", "list", "events");
    // The contacts app may never have run here: then there's no collection yet, and no contacts.
    const contacts = await ctx.call("data", "list", "contacts");
    const haveContacts = (await ctx.call("data", "collections")).some((c) => c.name === "contacts");

    const today = new Date();
    const days = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const date = iso(d);
      const items = [
        ...events.filter((e) => e.date === date).map((e) => ({ time: e.start ?? "", text: e.title, where: e.where ?? "" })),
        ...contacts.filter((p) => p.birthday?.slice(5) === date.slice(5)).map((p) => ({ time: "", text: `🎂 ${p.name}'s birthday`, where: "" })),
      ].sort((a, b) => a.time.localeCompare(b.time));
      if (items.length) days.push({ label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }), items });
    }
    return { days, contacts: haveContacts };
  });
}
