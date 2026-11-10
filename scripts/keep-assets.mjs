// A deploy never takes a file away from a page that is already open.
//
// The built platform scripts in dist/assets/ have their content's hash in their names, and a deploy serves
// only what the new build made. A page opened before the deploy still runs the scripts it loaded, and those
// name the old files: the first time it needs one it hasn't fetched yet (a kernel module, the reference, the
// kernel itself for a visitor whose browser kept an older page script), the server has nothing at that
// address. That was "Failed to fetch dynamically imported module".
//
// So each build brings the previous deploy's files along with it. It asks the live site for
// platform/kept.json (the list the last build wrote: each file in assets/, and the day it was last part of a
// build), downloads the ones this build no longer makes, and puts them in dist/assets/ beside the new ones.
// A file stays for KEEP_DAYS after the last build that made it, and at most MOST old files stay (the newest).
//
//   node scripts/keep-assets.mjs            writes dist/platform/kept.json; on a deploy, keeps the old files too
//
// It reaches the network only where a deploy is built: on Cloudflare's Workers Builds (WORKERS_CI), from the
// site named by `homepage` in package.json, or wherever KEEP_ASSETS_FROM names (a site's address). Anywhere
// else (this machine, the tests) it only writes the list. A site that can't be asked stops the build: a deploy
// that quietly dropped the old files is the bug this is here to prevent. A site with no list yet (its first
// deploy with this) has nothing to keep, and one old file that is already gone is left out and said.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the list is served: not under /assets/, whose files are never asked for twice. */
export const LIST = "platform/kept.json";
export const KEEP_DAYS = 90;
export const MOST = 2000;
/** A built file's name: letters, digits, dots, dashes, underscores. Nothing else is ever fetched or written. */
const NAME = /^[\w][\w.-]*$/;
const DAY = 86_400_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Asks until it gets an answer from the server (any status), three times at most. */
async function ask(fetcher, url, wait) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(wait * attempt);
    try {
      const response = await fetcher(url, { redirect: "error" });
      if (response.status < 500) return response;
      last = new Error(`${url} answered ${response.status}`);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`Couldn't ask ${url}: ${last instanceof Error ? last.message : last}`);
}

/** The list a site serves, checked: `{ files: { "<name>": "<yyyy-mm-dd>" } }`. A site with none has `{}`. */
async function previous(fetcher, site, wait) {
  const url = new URL(LIST, site).href;
  const response = await ask(fetcher, url, wait);
  // No list yet: the site was last deployed before builds wrote one (it answers its not-found page).
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  let json;
  try {
    json = JSON.parse(await response.text());
  } catch {
    throw new Error(`${url} isn't JSON`);
  }
  const files = json?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`${url} has no \`files\``);
  for (const [name, day] of Object.entries(files)) {
    if (!NAME.test(name)) throw new Error(`${url} lists ${JSON.stringify(name)}, which isn't a built file's name`);
    if (typeof day !== "string" || Number.isNaN(Date.parse(day))) throw new Error(`${url}: ${name} has no day`);
  }
  return files;
}

/**
 * Writes dist/platform/kept.json, and with `site` first brings along the files that site still lists and this
 * build doesn't make. Returns what it did.
 * @param {{ dist?: string, site?: string, today?: Date, fetcher?: typeof fetch, wait?: number, log?: (text: string) => void }} [options]
 */
export async function keepAssets({ dist = join(ROOT, "dist"), site, today = new Date(), fetcher = fetch, wait = 2000, log = () => {} } = {}) {
  const assets = join(dist, "assets");
  if (!existsSync(assets)) throw new Error(`${assets} isn't built: run \`vite build\` first`);
  const day = today.toISOString().slice(0, 10);
  const made = readdirSync(assets).filter((name) => NAME.test(name));
  /** @type {Record<string, string>} */
  const files = Object.fromEntries(made.sort().map((name) => [name, day]));
  const kept = [];
  const gone = [];
  let dropped = 0;
  if (site) {
    const before = await previous(fetcher, site, wait);
    const old = Object.entries(before)
      .filter(([name]) => !(name in files))
      .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]));
    const wanted = old.filter(([, last]) => today.getTime() - Date.parse(last) <= KEEP_DAYS * DAY).slice(0, MOST);
    dropped = old.length - wanted.length;
    // A few at a time: a site is asked for its own files, not flooded with them.
    for (let i = 0; i < wanted.length; i += 8) {
      await Promise.all(
        wanted.slice(i, i + 8).map(async ([name, last]) => {
          const response = await ask(fetcher, new URL(`assets/${name}`, site).href, wait);
          // Gone already (a deploy made before builds kept files): nothing can bring it back.
          if (response.status === 404) return void gone.push(name);
          if (!response.ok) throw new Error(`${site}assets/${name} answered ${response.status}`);
          writeFileSync(join(assets, name), Buffer.from(await response.arrayBuffer()));
          files[name] = last;
          kept.push(name);
        }),
      );
    }
    log(`Kept ${kept.length} file${kept.length === 1 ? "" : "s"} from ${site} that pages already open may still ask for${dropped ? `; ${dropped} older than ${KEEP_DAYS} days left behind` : ""}${gone.length ? `; ${gone.length} already gone (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", …" : ""})` : ""}.`);
  }
  mkdirSync(join(dist, "platform"), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(files).sort((a, b) => a[0].localeCompare(b[0])));
  writeFileSync(join(dist, LIST), `${JSON.stringify({ files: sorted }, null, 1)}\n`);
  return { made: made.length, kept: kept.sort(), gone: gone.sort(), dropped };
}

/** The site a deploy's old files come from: KEEP_ASSETS_FROM, or on Workers Builds the package's `homepage`. */
export function siteFor(env = process.env, root = ROOT) {
  const named = env.KEEP_ASSETS_FROM;
  if (named === undefined && !env.WORKERS_CI) return undefined;
  const from = named ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).homepage;
  if (typeof from !== "string" || !from) throw new Error("A deploy keeps the last deploy's files, so it needs the site's address: set `homepage` in package.json (or KEEP_ASSETS_FROM)");
  let url;
  try {
    url = new URL(from);
  } catch {
    throw new Error(`${JSON.stringify(from)} isn't a site's address`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${JSON.stringify(from)} isn't a site's address`);
  return `${url.origin}/`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await keepAssets({ site: siteFor(), log: (text) => console.log(text) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
