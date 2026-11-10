// An app's own Worker keeps the last deploy's files too.
//
// The main site's build brings along the built files its last deploy served (scripts/keep-assets.mjs), so a
// page opened before a deploy still finds the scripts it names. A Worker made by `npm run deploy:app`, or by
// `extensible-app deploy` in a project of its own, is a site of its own with the same built files, and a deploy
// of it used to take them away the same way. So before either deploys, this:
//
//   1. asks the account what has the Worker's name (scripts/deploy-guard.mjs), as before;
//   2. finds the address the Worker is served at now: its workers.dev address, read from the account, or the
//      address given with --keep-from (a Worker served only on a domain of its own);
//   3. asks that address for the list its last deploy wrote (platform/kept.json), and copies the files this
//      deploy no longer makes into the laid-out site's assets/, beside the new ones, for the same 90 days.
//
// A name no Worker has yet has nothing to keep. When the files can't be fetched, nothing is deployed: a
// deploy that quietly dropped them is the bug this is here to prevent. The one exception is --replace over a
// Worker that isn't this app's: whatever it served isn't this app's to keep, so a list it doesn't have is
// said and the deploy goes on.
import { addressOf, lookUp } from "./deploy-guard.mjs";
import { keepAssets } from "./keep-assets.mjs";

/** A site's address given with --keep-from, checked: `https://host/`. */
export function addressGiven(from) {
  let url;
  try {
    url = new URL(from);
  } catch {
    throw new Error(`--keep-from needs the address the Worker is served at now, such as https://my-app.example.com/: ${JSON.stringify(from)} isn't one`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--keep-from needs an http or https address: ${JSON.stringify(from)} isn't one`);
  return `${url.origin}/`;
}

/**
 * The check and the keeping a deploy does first. Resolves to the lines to say; throws, saying why, when the
 * deploy mustn't go ahead.
 * @param {string} worker the Worker's name
 * @param {string} app what the Worker is marked with (EXTENSIBLE_APP)
 * @param {string} site the laid-out site's folder, with assets/ in it
 * @param {{ replace?: boolean, keepFrom?: string, token?: string, account?: string, fetch?: typeof fetch, fetcher?: typeof fetch, today?: Date, wait?: number }} [options]
 *   `fetch` reaches the Cloudflare API and `fetcher` the Worker's own address (stand-ins, in the tests).
 * @returns {Promise<string[]>}
 */
export async function beforeDeploy(worker, app, site, { replace = false, keepFrom, token, account, fetch = globalThis.fetch, fetcher = globalThis.fetch, today, wait } = {}) {
  const given = keepFrom === undefined ? undefined : addressGiven(keepFrom);
  const looked = await lookUp(worker, app, { replace, token, account, fetch });
  const said = [looked.said];
  const notMine = looked.was === "other";
  let from = given;
  if (!from && looked.was === "unknown") throw new Error(`The account couldn't be read, so the address the Worker "${worker}" is served at isn't known, and the files its last deploy served can't be kept. Nothing was deployed. Give its address with --keep-from.`);
  if (!from && looked.was !== "free") {
    try {
      from = await addressOf(worker, { token: looked.token, account: looked.account, fetch });
    } catch (error) {
      if (!notMine) throw new Error(`${error.message}, so the files its last deploy served can't be kept. Nothing was deployed. Give the address it is served at with --keep-from.`);
      said.push(`Kept none of the replaced Worker's files: ${error.message}`);
    }
  }
  if (!from) return said;
  try {
    await keepAssets({ dist: site, site: from, fetcher, log: (text) => said.push(text), ...(today ? { today } : {}), ...(wait === undefined ? {} : { wait }) });
  } catch (error) {
    if (!notMine || given) throw new Error(`${error.message}. Nothing was deployed: pages open now would lose the files they still ask for.`);
    said.push(`Kept none of the replaced Worker's files: ${error.message}`);
  }
  return said;
}
