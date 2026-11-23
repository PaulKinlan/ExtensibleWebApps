// A new plugin with the id of one the app already has would run in that
// plugin's place (tests/checks/user-override.mjs). That is what a person
// wants when they copy the app's plugin to change it, and never what they
// want when they ask an agent for something new: a real model asked for a
// card that counts notes called it "note-stats", the id of the homepage's
// own Note stats, and the review read "replaces Note stats with Note stats".
//
// So authoring.check tells whoever wrote the draft, before anything is
// saved, and the review card says whose plugin goes and whose comes.
//
// It runs in a browser context of its own, like the homepage's check.

import { watchErrors } from "../page-errors.mjs";

const draft = (id, name) => `export const manifest = { id: "${id}", name: "${name}", permissions: ["ui"] };\nexport default (ctx) => ctx.ui.render("main", "mine", ctx.ui.html\`<p>Mine</p>\`);\n`;

/** A person's plugin that checks two drafts, says what it was told, and then saves the one with the app's id. */
const PROBE = `export const manifest = { id: "id-probe", name: "Id probe", permissions: ["plugins:author"] };
export default async (ctx) => {
  const taken = await ctx.call("authoring", "check", ${JSON.stringify(draft("note-stats", "Note stats"))});
  const free = await ctx.call("authoring", "check", ${JSON.stringify(draft("note-totals", "Note totals"))});
  ctx.log("checked " + JSON.stringify({ taken, free }));
  const saved = await ctx.call("authoring", "save", ${JSON.stringify(draft("note-stats", "Note stats"))});
  ctx.log("saved " + JSON.stringify(saved));
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "own-id-warning");
  await page.goto(URL);
  await page.waitForFunction(() => window.__host);
  const review = '[data-key^="review:"]';
  /** What the probe logged after a word, once it has. */
  const logged = (word) =>
    page
      .waitForFunction((word) => window.__host.traces.find((e) => e.plugin?.startsWith("id-probe") && e.detail?.startsWith(`${word} `))?.detail.slice(word.length + 1), word, { timeout: 15000 })
      .then((handle) => handle.jsonValue(), () => "");
  try {
    await page.waitForSelector('[data-key^="note-stats:"], [data-key^="note-stats@"]', { state: "attached", timeout: 15000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "root", files: [{ name: "id-probe.js", data }] }), PROBE);
    await page.evaluate(() => window.__host.command("user:on", { app: "root", id: "id-probe" }));
    const text = await logged("checked");
    const { taken, free } = JSON.parse(text || "{}");
    check(
      "checking a draft with the id of the app's own plugin says it would replace that plugin, and to pick another id",
      taken?.ok === true && taken.replaces?.id === "note-stats" && taken.replaces?.name === "Note stats" && /Give this one a different id/.test(taken.note ?? ""),
      text.slice(0, 600),
    );
    check("a draft with an id of its own gets no such note", free?.ok === true && !free.replaces && !free.note, JSON.stringify(free ?? null).slice(0, 300));

    const card = await page.waitForSelector(review, { timeout: 10000 }).then((el) => el.innerText(), () => "");
    check("saving it anyway asks on a review card that says whose plugin goes and whose comes", /replaces this app's own Note stats with your Note stats/.test(card.replace(/\s+/g, " ")), card.replace(/\s+/g, " ").slice(0, 300));
    await page.click(`${review} >> text="Decline"`);
    const saved = JSON.parse((await logged("saved")) || "{}");
    const mine = await page.evaluate(() => window.__host.command("user:list", { app: "root" }));
    check("declined, the app's own plugin stays as it was", saved?.ok === false && !mine.some((p) => p.id === "note-stats"), JSON.stringify(saved));
  } finally {
    await own.close();
  }
}
