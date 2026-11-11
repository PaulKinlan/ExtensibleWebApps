// account: what the account service (std/account/module.ts) needs from the page (passkeys,
// what a passkey derives to unlock the person's keys, the page that linked here, leaving to
// sign in elsewhere, a file picked from disk, this browser's push subscription). Only the
// account app uses it, so its code is the app's own (account/page.js), loaded when first asked.

const PAGE = "/account/page.js";
const METHODS = ["create", "derive", "get", "referrer", "keep", "go", "pick", "pushState", "pushOn", "pushOff"];

export default () => Object.fromEntries(METHODS.map((name) => [name, async (...args: unknown[]) => (await import(/* @vite-ignore */ PAGE))[name](...args)]));
