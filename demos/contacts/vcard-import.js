// vCard import: paste the text of one or more vCards (what a phone or mail
// app exports) to add those people. It may write to the contacts
// (`data:write:contacts`), but they belong to people.js, so the kernel shows
// the person each new contact first.
//
// Someone already in the contacts with the same email is skipped, so
// importing the same file twice doesn't make duplicates. Reading the
// contacts to check needs `data:read:contacts` too.

export const manifest = {
  id: "vcard-import",
  name: "vCard import",
  description: "Paste vCards to add people to your contacts.",
  version: "1.0.0",
  permissions: ["ui", "data:read:contacts", "data:write:contacts"],
  order: 20,
};

/** The people in vCard text: FN, EMAIL, TEL, BDAY and ORG of each card. */
export function parse(text) {
  // Long lines are folded onto the next line, which starts with a space.
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const people = [];
  let card = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    // "EMAIL;TYPE=work:ada@example.com": the name is before any ";".
    const name = line.slice(0, colon).split(";")[0].toUpperCase();
    const value = line.slice(colon + 1).trim();
    if (name === "BEGIN") card = {};
    else if (name === "END" && card) {
      if (card.name) people.push(card);
      card = null;
    } else if (card && value) {
      if (name === "FN") card.name = value;
      if (name === "EMAIL" && !card.email) card.email = value;
      if (name === "TEL" && !card.phone) card.phone = value;
      if (name === "ORG") card.company = value.split(";")[0];
      // 1815-12-10 or 18151210; a birthday without a year (--1210) is left out.
      const bday = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value);
      if (name === "BDAY" && bday) card.birthday = `${bday[1]}-${bday[2]}-${bday[3]}`;
    }
  }
  return people;
}

export default async function (ctx) {
  const views = ctx.ui.views("vcard-import.html");
  let status = "";
  const draw = () => views.render("side", "form", { status });

  ctx.ui.onEvent(async (action, value) => {
    if (action !== "import") return;
    const people = parse(value.cards ?? "");
    const known = new Set((await ctx.call("data", "list", "contacts")).map((p) => p.email?.toLowerCase()).filter(Boolean));
    let added = 0;
    let skipped = 0;
    for (const person of people) {
      if (person.email && known.has(person.email.toLowerCase())) {
        skipped++;
        continue;
      }
      // Each write waits for the person's answer to the review card.
      const result = await ctx.call("data", "put", "contacts", person, `Add ${person.name} from a vCard`).catch((error) => ({ ok: false, error: error.message }));
      if (result.ok) added++;
    }
    status = people.length ? `Added ${added} of ${people.length}${skipped ? `; ${skipped} already there` : ""}.` : "No vCards found in that text.";
    draw();
  });
  draw();
}
