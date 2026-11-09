// Before `npm run deploy:app` deploys, it asks the Cloudflare account what
// already has the Worker's name. `wrangler deploy` replaces a Worker with the
// same name without asking, whatever it was: once, the default name
// markdown-editor nearly replaced a different app's Worker of that name, and
// only that Worker's Durable Object stopped it.
//
// So every Worker deploy-app.mjs makes carries the app's path in a plain
// variable, EXTENSIBLE_APP. A deploy goes ahead when no Worker has the name,
// or when the one that has it carries this app's path. Anything else (a
// Worker this script didn't make, or one serving another app) is refused,
// naming what is there, unless the person passes --replace.
//
// The account is read with the Cloudflare API: the token in
// CLOUDFLARE_API_TOKEN (as the "Deploy one app" workflow has), or else the
// one `wrangler login` keeps (`wrangler auth token`). The account is
// CLOUDFLARE_ACCOUNT_ID, or the token's only account. If the check can't be
// made, the deploy is refused too, rather than going ahead unchecked.

import { spawnSync } from "node:child_process";

/** The variable that names the app a Worker serves. */
export const APP_VAR = "EXTENSIBLE_APP";

const API = "https://api.cloudflare.com/client/v4";

/**
 * What already has a Worker name: `{ free: true }`, or the app it serves (`app`, undefined for a Worker
 * this script didn't make). Throws if the account can't be read.
 * @param {string} name
 * @param {{ token: string, account: string, fetch?: typeof fetch }} access
 * @returns {Promise<{ free: true } | { free: false, app: string | undefined }>}
 */
export async function whoHas(name, { token, account, fetch = globalThis.fetch }) {
  const response = await fetch(`${API}/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(name)}/settings`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return { free: true };
  if (!response.ok || !body.success) {
    const why = (body.errors ?? []).map((e) => e.message).join("; ") || `the API answered ${response.status}`;
    throw new Error(`Couldn't read the Worker "${name}" in the account: ${why}`);
  }
  const marked = (body.result?.bindings ?? []).find((b) => b.type === "plain_text" && b.name === APP_VAR);
  return { free: false, app: typeof marked?.text === "string" ? marked.text : undefined };
}

/**
 * Whether deploying the app at `path` as the Worker `name` may go ahead: resolves to what to say if so,
 * and throws, saying why, if not.
 * @param {string} name @param {string} path
 * @param {{ replace?: boolean, token?: string, account?: string, fetch?: typeof fetch }} [options]
 */
export async function checkName(name, path, { replace = false, fetch = globalThis.fetch, ...given } = {}) {
  const token = given.token ?? process.env.CLOUDFLARE_API_TOKEN ?? wranglerToken();
  if (!token) throw new Error(`Couldn't check whether a Worker called "${name}" is already in the account: set CLOUDFLARE_API_TOKEN, or run \`npx wrangler login\`. (--replace deploys without checking.)`);
  const account = given.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? (await onlyAccount(token, fetch));
  let found;
  try {
    found = await whoHas(name, { token, account, fetch });
  } catch (error) {
    if (replace) return `Couldn't check the account (${error.message}); deploying anyway, as --replace says`;
    throw new Error(`${error.message}. Nothing was deployed. (--replace deploys without checking.)`);
  }
  if (found.free) return `No Worker is called "${name}" yet: deploying a new one`;
  if (found.app === path) return `The Worker "${name}" serves /${path}/ already: deploying a new version of it`;
  const what = found.app === undefined ? "a Worker that npm run deploy:app didn't make (or made before Workers were marked)" : `a Worker serving another app, /${found.app}/`;
  if (replace) return `"${name}" is ${what}: replacing it, as --replace says`;
  throw new Error(`"${name}" is already ${what}. Deploying would replace it, so nothing was deployed. Pick another name with --name, or pass --replace if replacing it is what you want.`);
}

/** The token `wrangler login` keeps, or undefined. */
function wranglerToken() {
  const result = spawnSync("npx", ["wrangler", "auth", "token", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) return undefined;
  try {
    const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    const token = json.token ?? json.value ?? json.oauth_token;
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The account a token has, if it has exactly one; otherwise it asks for CLOUDFLARE_ACCOUNT_ID. */
async function onlyAccount(token, fetch) {
  const response = await fetch(`${API}/accounts?per_page=2`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  const accounts = response.ok && body.success ? body.result ?? [] : [];
  if (accounts.length !== 1) throw new Error("Couldn't tell which Cloudflare account to check: set CLOUDFLARE_ACCOUNT_ID");
  return accounts[0].id;
}
