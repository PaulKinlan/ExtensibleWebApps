// account: what the account service (std/account/module.ts) needs from the page (passkeys,
// the page that linked here, leaving to sign in elsewhere, a file picked from disk). Only the
// account app uses it, so its code is the app's own (account/page.js), loaded when first asked.

const PAGE = "/account/page.js";
const METHODS = ["create", "get", "referrer", "keep", "go", "pick"];

export default () => Object.fromEntries(METHODS.map((name) => [name, async (...args: unknown[]) => (await import(/* @vite-ignore */ PAGE))[name](...args)]));
