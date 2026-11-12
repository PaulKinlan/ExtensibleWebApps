// Sharing an app by link (std/maker: link, linked, takeLink; recipe.ts).
//
//   the link is the app     its files, packed into the part of the address a
//                           browser never sends, and none of its data
//   someone else opens it   in a browser that has never seen the site and
//                           isn't signed in: they are told what it holds,
//                           see every file on one review, and get it as
//                           their own app, running
//   never over their own    a shared app with the name of one they have
//                           gets the next free name
//   a damaged link          says so, and what to do
//
// The first app comes from a folder, as in maker-for-real.mjs: the picker is
// replaced by one that hands back a folder in the browser's private files.
import { watchErrors } from "../page-errors.mjs";

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tide times</title><link rel="stylesheet" href="/platform/host.css"><script type="module" src="/platform/host.js"></script><link rel="plugin" href="tides.js"></head><body><main><slot name="main"></slot></main></body></html>';
const PLUGIN = (words) =>
  `export const manifest = {\n  id: "tide-times",\n  name: "Tides",\n  version: "1.0.0",\n  permissions: ["ui"],\n  collections: { tides: { schema: { type: "object", properties: { at: { type: "string" } } } } },\n};\n\nexport default async function (ctx) {\n  const kept = await ctx.call("data", "list", "tides");\n  ctx.ui.render("main", "tides", ctx.ui.html\`<p>${words} (\${kept.length} kept)</p>\`);\n}\n`;

export default async function ({ check, context, URL, errors }) {
  const browser = context.browser();
  const yours = '[data-key^="your-apps@"][data-key$=":apps"]';
  const review = '[data-key^="review:"]';
  const seen = (page, selector, timeout = 10000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
  const open = async (page, url) => {
    await page.goto("about:blank");
    await page.goto(url);
    await page.waitForFunction(() => window.__host);
  };

  // ---- The person who made it ----
  const hers = await browser.newContext();
  await hers.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
  await hers.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("tide-times", { create: true });
  });
  const maker = await hers.newPage();
  watchErrors(maker, errors, "share-link (maker)");
  let link = "";
  try {
    await open(maker, `${URL}new/`);
    await maker.evaluate(
      async ([page, plugin]) => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("tide-times", { create: true });
        for (const [name, text] of [["app.html", page], ["tides.js", plugin]]) {
          const out = await (await folder.getFileHandle(name, { create: true })).createWritable();
          await out.write(text);
          await out.close();
        }
      },
      [PAGE, PLUGIN("High water at noon")],
    );
    await maker.click(`${yours} button[data-action="open-folder"]`);
    if (await seen(maker, `${review} >> text=makes Tide times`, 15000)) await maker.click(`${review} >> text="Accept"`);
    await seen(maker, `${yours} button[data-action="pick"]:has-text("Tide times")`);
    // Some data of hers, which must not travel.
    await maker.evaluate(() => window.__host.command("install", `export const manifest = { id: "tide-writer", name: "Tide writer", permissions: ["data:write:tides"] };\nexport default async (ctx) => { await ctx.call("data", "put", "tides", { id: "secret-tide", at: "her own data 04:12" }, "test"); ctx.log("tide written"); };`));
    if (await seen(maker, `${review} >> text=/Tide writer/`, 10000)) await maker.click(`${review} >> text="Accept"`);
    await maker.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
    await maker.waitForFunction(() => window.__host.traces.some((e) => e.plugin?.startsWith("tide-writer") && e.detail === "tide written"), null, { timeout: 10000 }).catch(() => {});
    await maker.evaluate(() => window.__host.command("uninstall", "tide-writer")).catch(() => {});

    await maker.click(`${yours} button[data-action="link"]`);
    const copied = await seen(maker, `${yours} >> text=/The link is copied/`);
    link = await maker.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check("Share a link copies a link to the app, and says what it holds", copied && link.startsWith(`${URL}new/#app=`) && (await seen(maker, `${yours} >> text=/2 files and none of your data/`, 2000)), `${copied} ${link.slice(0, 60)}`);
    check("the link fits where links go", link.length > 100 && link.length < 4000, String(link.length));

    await open(maker, link);
    const hasIt = await seen(maker, `${yours} .arrived >> text=/You have this app already/`);
    check("opening her own link says she has the app already, and adds nothing", hasIt && !(await maker.isVisible(review)));
  } finally {
    await hers.close();
  }

  // ---- Someone else: a browser that has never seen the site, signed out ----
  const theirs = await browser.newContext();
  const page = await theirs.newPage();
  watchErrors(page, errors, "share-link (opener)");
  try {
    const asked = [];
    page.on("request", (request) => asked.push(request.url()));
    await open(page, link);
    check("the app in the link never reaches the server: it is the part of the address a browser keeps", link.includes("#app=") && !asked.some((url) => url.includes(link.split("#app=")[1].slice(0, 40))));
    const told = await seen(page, `${yours} .arrived >> text=/Someone shared an app with you: Tide times/`, 15000);
    const about = (await page.textContent(`${yours} .arrived`).catch(() => "")) ?? "";
    check("someone who opens the link, signed out, is told what it holds before anything is added", told && /app\.html, tides\.js/.test(about) && /none of their data/.test(about) && (await page.evaluate(() => window.__host.command("user:list", { app: "new" }).then(() => fetch("/apps/tide-times/app.html").then((r) => r.status)))) === 404, about.slice(0, 200));

    await page.click(`${yours} button[data-action="take-link"]`);
    const reviewed = await seen(page, `${review} >> text=makes Tide times`, 15000);
    const card = (await page.textContent(review).catch(() => "")) ?? "";
    check("they see every file on one review card first", reviewed && /High water at noon/.test(card) && /<title>Tide times<\/title>/.test(card) && !/her own data/.test(card), card.slice(0, 200));
    if (reviewed) await page.click(`${review} >> text="Accept"`);
    const listed = await seen(page, `${yours} button[data-action="pick"]:has-text("Tide times")`);
    const said = await seen(page, `${yours} >> text=/It is yours now/`);
    check("once accepted it is their own app, and the link has left the address", listed && said && !(await page.evaluate(() => location.hash)));

    const app = await theirs.newPage();
    watchErrors(app, errors, "share-link (the app)");
    await app.goto(`${URL}apps/tide-times/`);
    check("the copy runs, with none of the first person's data", await seen(app, "main >> text=High water at noon (0 kept)", 15000), ((await app.textContent("main").catch(() => "")) ?? "").slice(0, 100));
    await app.close();

    // Another app of the same name arrives: theirs stays, the new one gets the next name.
    const other = await page.evaluate(
      async ([pageText, plugin]) => {
        const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, name: "tide-times", files: [{ name: "app.html", text: pageText }, { name: "tides.js", text: plugin }, { name: "../evil.js", text: "x" }] }));
        const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
        return btoa(String.fromCharCode(...packed)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      },
      [PAGE.replace("Tide times", "Tide times two"), PLUGIN("Low water at six").replace('"tide-times"', '"tide-times-two"')],
    );
    await open(page, `${URL}new/#app=${other}`);
    const second = await seen(page, `${yours} .arrived code >> text=tide-times-2`, 15000);
    await page.click(`${yours} button[data-action="take-link"]`);
    const again = await seen(page, `${review} >> text=makes Tide times two`, 15000);
    const cardTwo = (await page.textContent(review).catch(() => "")) ?? "";
    if (again) await page.click(`${review} >> text="Accept"`);
    await seen(page, `${yours} button[data-action="pick"]:has-text("Tide times two")`);
    const kept = await page.evaluate(() => Promise.all(["tide-times", "tide-times-2"].map((name) => fetch(`/apps/${name}/tides.js`).then((r) => r.text()))));
    check("a shared app with the name of one they have never replaces it: it gets the next free name", second && again && /High water at noon/.test(kept[0]) && /Low water at six/.test(kept[1]), `${second} ${again}`);
    check("a file a made app can't have is left out of what is added", !/evil/.test(cardTwo));

    await open(page, `${URL}new/#app=not-a-real-link`);
    const damaged = await seen(page, `${yours} >> text=/This link is damaged or cut short/`, 15000);
    check("a damaged link says so, and what to do", damaged && (await seen(page, `${yours} >> text=/Ask whoever sent it to share it again/`, 2000)));
    await page.click(`${yours} button[data-action="drop-link"]`);
    check("and closing it takes it out of the address", await page.waitForFunction(() => !location.hash, null, { timeout: 5000 }).then(() => true, () => false));
  } finally {
    await theirs.close();
  }
}
