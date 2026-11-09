// The platform's own pages and styles name no app, plugin, slot or element of
// their own choosing (the architecture audit's findings 7, 8 and 10):
// - host CSS floats slots the page marks (float), never a slot or a plugin's
//   element by name;
// - the account page opens the app you came from in a space, never a demo by name;
// - the demo gallery is built from each app's own <meta> tags, so it can't drift: the page is committed with
//   its lists empty, and the site fills them as it serves and builds (scripts/generated.mjs).
import { readdirSync, readFileSync } from "node:fs";
import { render } from "../../scripts/gallery.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
/** CSS with its comments taken out, so a comment may still give an example. */
const rules = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

export default async function ({ check, URL: SITE }) {
  const css = rules(read("src/host/styles.css"));
  check("host CSS doesn't place the debug console's element (a page marks a slot float instead)", !/ui-debug/.test(css));
  const slots = [...css.matchAll(/slot\[name[~|^$*]?=["']?([^"'\]]+)/g)].map((m) => m[1]);
  check("host CSS styles no slot by name (a page marks a slot float instead)", !slots.length, slots.join(", "));

  const account = readdirSync(new URL("account/", ROOT)).map((f) => read(`account/${f}`)).join("\n");
  const demos = [...account.matchAll(/\/demos\/[a-z0-9-]+/g)].map((m) => m[0]);
  check("the account page names no demo app: it opens the app you came from", !demos.length, demos.join(", "));

  let gallery = "";
  try {
    gallery = render();
  } catch (error) {
    gallery = String(error.message);
  }
  const served = await fetch(`${SITE}demos/`).then((r) => r.text(), () => "");
  check("the demo gallery the site serves is what the apps' gallery <meta> tags say", gallery === served, gallery.startsWith("<") ? "out of date" : gallery);
  const filled = [...read("demos/index.html").matchAll(/<ul class="apps" data-gallery="[a-z-]+">\s*<li/g)].length;
  check("demos/index.html is committed with its gallery lists empty (the build fills them, so adding demos never conflicts)", filled === 0, `${filled} lists have cards in the repo`);
}
