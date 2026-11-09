// `npm run deploy:app` never deploys over a Worker that isn't this app's
// (scripts/deploy-guard.mjs): it asks the account what has the name first.
// Here the Cloudflare API is a stand-in that answers as the real one does.
import { checkName } from "../../scripts/deploy-guard.mjs";

export default async function ({ check }) {
  /** An account whose Workers are `workers` ({ name: bindings }), answering the API's settings and accounts calls. */
  const account = (workers) => async (url, init) => {
    const ok = init?.headers?.authorization === "Bearer t0ken";
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!ok) return json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    if (/\/accounts\?/.test(url)) return json(200, { success: true, result: [{ id: "acc1" }] });
    const name = decodeURIComponent(/\/workers\/scripts\/([^/]+)\/settings$/.exec(url)?.[1] ?? "");
    if (!(name in workers)) return json(404, { success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] });
    return json(200, { success: true, result: { bindings: workers[name] } });
  };
  const workers = {
    habits: [{ type: "plain_text", name: "EXTENSIBLE_APP", text: "demos/habits" }, { type: "durable_object_namespace", name: "SPACE", class_name: "Space" }],
    "markdown-editor": [{ type: "durable_object_namespace", name: "STORE", class_name: "ExtensionStore" }],
    recipes: [{ type: "plain_text", name: "EXTENSIBLE_APP", text: "demos/recipes" }],
  };
  const fetch = account(workers);
  const outcome = (name, path, options = {}) => checkName(name, path, { token: "t0ken", account: "acc1", fetch, ...options }).then((said) => ({ said }), (error) => ({ error: error.message }));

  const fresh = await outcome("packing-list", "demos/packing-list");
  const same = await outcome("habits", "demos/habits");
  check("deploy:app deploys under a name no Worker has, and over its own Worker for the same app", /new one/.test(fresh.said) && /new version/.test(same.said), JSON.stringify({ fresh, same }));

  const stranger = await outcome("markdown-editor", "demos/markdown-editor");
  const otherApp = await outcome("recipes", "demos/habits");
  check(
    "deploy:app refuses to deploy over a Worker it didn't make, or one serving another app, and says what is there",
    /didn't make/.test(stranger.error) && /--name/.test(stranger.error) && /another app, \/demos\/recipes\//.test(otherApp.error),
    JSON.stringify({ stranger, otherApp }),
  );
  const replaced = await outcome("markdown-editor", "demos/markdown-editor", { replace: true });
  check("--replace deploys over it anyway, saying so", /replacing it/.test(replaced.said), JSON.stringify(replaced));

  const badToken = await outcome("habits", "demos/habits", { token: "wrong" });
  const onlyAccount = await outcome("habits", "demos/habits", { account: undefined });
  check(
    "deploy:app refuses when it can't read the account, rather than deploying unchecked; with one account, it needs no account id",
    /Authentication error/.test(badToken.error) && /Nothing was deployed/.test(badToken.error) && /new version/.test(onlyAccount.said ?? ""),
    JSON.stringify({ badToken, onlyAccount }),
  );
}
