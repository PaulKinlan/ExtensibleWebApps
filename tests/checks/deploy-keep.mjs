// An app's own Worker keeps the last deploy's files (scripts/deploy-keep.mjs), as the main site's build does
// (out-of-date.mjs): `npm run deploy:app` asks the Worker as it is now for the list its last deploy wrote, and
// puts the built files this deploy no longer makes beside the new ones, so a page that is open during the
// deploy still finds the scripts it names. Here the Cloudflare API and the Worker's address are stand-ins.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutApp } from "../../scripts/deploy-app.mjs";
import { beforeDeploy } from "../../scripts/deploy-keep.mjs";
import { addressOf } from "../../scripts/deploy-guard.mjs";
import { siteFor } from "../../scripts/keep-assets.mjs";

export default async function ({ check }) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  /** An account: its Workers ({ name: { app?, workersDev? } }) and its workers.dev subdomain. Counts what it is asked. */
  const account = (workers, { subdomain = "example-team", asked = [] } = {}) => async (url, init) => {
    asked.push(url);
    if (init?.headers?.authorization !== "Bearer t0ken") return json(403, { success: false, errors: [{ message: "Authentication error" }] });
    if (/\/workers\/subdomain$/.test(url)) return subdomain ? json(200, { success: true, result: { subdomain } }) : json(404, { success: false, errors: [{ message: "No subdomain" }] });
    const [, name, what] = /\/workers\/scripts\/([^/]+)\/(settings|subdomain)$/.exec(url) ?? [];
    const worker = workers[decodeURIComponent(name ?? "")];
    if (!worker) return json(404, { success: false, errors: [{ message: "This Worker does not exist on your account." }] });
    if (what === "subdomain") return json(200, { success: true, result: { enabled: worker.workersDev !== false } });
    return json(200, { success: true, result: { bindings: worker.app ? [{ type: "plain_text", name: "EXTENSIBLE_APP", text: worker.app }] : [] } });
  };
  /** A Worker's own address: the list its last deploy wrote and the files it serves. Anything else is its not-found page. */
  const live = (origin, list, files, asked = []) => async (url) => {
    asked.push(url);
    if (!url.startsWith(origin)) throw new TypeError("fetch failed");
    const path = url.slice(origin.length);
    if (path === "platform/kept.json" && list !== undefined) return typeof list === "string" ? new Response(list, { headers: { "content-type": "text/html" } }) : json(200, { files: list });
    if (path in files) return new Response(files[path]);
    return new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
  };

  const out = mkdtempSync(join(tmpdir(), "ewa-keep-"));
  const today = new Date("2026-11-10T12:00:00Z");
  const access = { token: "t0ken", account: "acc1", today, wait: 1 };
  const outcome = (worker, app, site, options) => beforeDeploy(worker, app, site, { ...access, ...options }).then((said) => ({ said }), (error) => ({ error: error.message }));
  try {
    const lay = () => layoutApp("demos/habits", { out });
    const { site } = lay();
    const built = readdirSync(join(site, "assets"));
    const kernel = built.find((name) => /^browser-.*\.js$/.test(name));
    const kept = () => JSON.parse(readFileSync(join(site, "platform/kept.json"), "utf8")).files;
    const address = "https://habits.example-team.workers.dev/";
    // What the Worker's last deploy served: a kernel module this build no longer makes, one it still does, and one from too long ago.
    const list = { "kernel-router-OLD00001.js": "2026-11-01", [kernel]: "2026-11-09", "kernel-sync-ANCIENT1.js": "2026-07-01" };
    const files = { "assets/kernel-router-OLD00001.js": "export const old = 1;", [`assets/${kernel}`]: "the old kernel", "assets/kernel-sync-ANCIENT1.js": "old" };

    const asked = [];
    const same = await outcome("habits", "demos/habits", site, { fetch: account({ habits: { app: "demos/habits" } }), fetcher: live(address, list, files, asked) });
    const now = kept();
    check(
      "deploy:app keeps the files its Worker's last deploy served: the ones this build no longer makes are in the site it deploys, and on its list with the day they were last built",
      !same.error && readFileSync(join(site, "assets/kernel-router-OLD00001.js"), "utf8") === "export const old = 1;" && now["kernel-router-OLD00001.js"] === "2026-11-01" && now[kernel] === "2026-11-10" && readFileSync(join(site, "assets", kernel), "utf8") !== "the old kernel",
      JSON.stringify(same),
    );
    check(
      "it asks the Worker's own workers.dev address, found from the account, and leaves behind a file older than 90 days",
      asked[0] === `${address}platform/kept.json` && !existsSync(join(site, "assets/kernel-sync-ANCIENT1.js")) && !("kernel-sync-ANCIENT1.js" in now) && same.said?.some((line) => /Kept 1 file from https:\/\/habits\.example-team\.workers\.dev\//.test(line)),
      JSON.stringify({ asked, said: same.said }),
    );

    // A name no Worker has: nothing to keep, and nothing is asked of any address.
    lay();
    const none = [];
    const fresh = await outcome("habits", "demos/habits", site, { fetch: account({}), fetcher: live(address, list, files, none) });
    check("a name no Worker has yet has nothing to keep, and no address is asked", !fresh.error && !none.length && Object.keys(kept()).length === built.length, JSON.stringify({ fresh, none }));

    // A Worker deployed before deploys kept files has no list: the deploy goes on, and starts one.
    const first = await outcome("habits", "demos/habits", site, { fetch: account({ habits: { app: "demos/habits" } }), fetcher: live(address, undefined, {}) });
    check("a Worker deployed before this has no list: nothing to keep, and the deploy goes on", !first.error && first.said?.some((line) => /Kept 0 files/.test(line)), JSON.stringify(first));

    // The files can't be fetched: nothing is deployed.
    const down = await outcome("habits", "demos/habits", site, { fetch: account({ habits: { app: "demos/habits" } }), fetcher: async () => { throw new TypeError("fetch failed"); } });
    const broken = await outcome("habits", "demos/habits", site, { fetch: account({ habits: { app: "demos/habits" } }), fetcher: live(address, list, { "assets/kernel-router-OLD00001.js": "x" }) });
    const halfway = await outcome("habits", "demos/habits", site, { fetch: account({ habits: { app: "demos/habits" } }), fetcher: live(address, "<h1>Hello</h1>", {}) });
    check(
      "a Worker that can't be asked, or whose list can't be read, stops the deploy: its files are never quietly dropped",
      [down, halfway].every((o) => /Nothing was deployed/.test(o.error ?? "")) && /fetch failed/.test(down.error) && /isn't JSON/.test(halfway.error) && !broken.error,
      JSON.stringify({ down, broken, halfway }),
    );

    // Not on workers.dev: the address must be given, and then it is the one asked.
    const elsewhere = account({ habits: { app: "demos/habits", workersDev: false } });
    const hidden = await outcome("habits", "demos/habits", site, { fetch: elsewhere, fetcher: live(address, list, files) });
    lay();
    const own = [];
    const given = await outcome("habits", "demos/habits", site, { fetch: elsewhere, keepFrom: "https://habits.example.com/app", fetcher: live("https://habits.example.com/", list, files, own) });
    const badAddress = await outcome("habits", "demos/habits", site, { fetch: elsewhere, keepFrom: "habits.example.com" });
    check(
      "a Worker that isn't served on workers.dev stops the deploy until --keep-from says where it is; then that address is asked",
      /isn't served on workers\.dev/.test(hidden.error ?? "") && /--keep-from/.test(hidden.error) && !given.error && own[0] === "https://habits.example.com/platform/kept.json" && existsSync(join(site, "assets/kernel-router-OLD00001.js")) && /isn't one/.test(badAddress.error ?? ""),
      JSON.stringify({ hidden, given, badAddress }),
    );

    // --replace over a Worker that isn't this app's: what it served isn't this app's to keep.
    lay();
    const stranger = await outcome("habits", "demos/habits", site, { replace: true, fetch: account({ habits: {} }), fetcher: live(address, "<h1>Another site</h1>", {}) });
    const refused = await outcome("habits", "demos/habits", site, { fetch: account({ habits: {} }), fetcher: live(address, list, files) });
    const unread = await outcome("habits", "demos/habits", site, { replace: true, token: "wrong", fetch: account({ habits: {} }) });
    check(
      "--replace over a Worker that isn't this app's goes on without a list, saying so; without --replace it is still refused, and an account that can't be read needs --keep-from",
      !stranger.error && stranger.said?.some((line) => /Kept none of the replaced Worker's files/.test(line)) && /already a Worker/.test(refused.error ?? "") && /--keep-from/.test(unread.error ?? ""),
      JSON.stringify({ stranger, refused, unread }),
    );

    const noSubdomain = await addressOf("habits", { token: "t0ken", account: "acc1", fetch: account({ habits: {} }, { subdomain: "" }) }).then((a) => a, (error) => error.message);
    check("the build inside deploy:app asks no site (KEEP_ASSETS_FROM=none), even where a deploy is built", siteFor({ KEEP_ASSETS_FROM: "none", WORKERS_CI: "1" }) === undefined && /subdomain/.test(noSubdomain), noSubdomain);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
