// The account app's code in the page, for the `account` bridge (src/host/bridges/account.ts),
// which loads it the first time the account service (std/account/module.ts) asks: a passkey
// is made and used with the browser's WebAuthn API, which only a page has; the page that
// linked here is the page's own to know; going to another site to sign in leaves the page;
// and a copy of a space is a file the person picks. Kept here, not in the host, so pages
// that never sign anyone in don't carry it.

/** The most a copy of a space read from disk may be. */
const MAX = 50_000_000;

const passkeys = () => {
  const api = window.PublicKeyCredential;
  if (!api?.parseCreationOptionsFromJSON || !api.parseRequestOptionsFromJSON) throw new Error("This browser can't use passkeys yet.");
  return api;
};

/** The credential as JSON for the server, or a plain error: closing the browser's prompt isn't worth more than a line. */
async function asked(made) {
  try {
    const credential = await made;
    if (!credential) throw new Error("No passkey was used.");
    return credential.toJSON();
  } catch (error) {
    if (error?.name === "NotAllowedError") throw new Error("No passkey was used.");
    throw error;
  }
}

/** Makes a passkey from the server's options. */
export const create = (options) => asked(navigator.credentials.create({ publicKey: passkeys().parseCreationOptionsFromJSON(options) }));

/** Uses a passkey the browser has for this site. */
export const get = (options) => asked(navigator.credentials.get({ publicKey: passkeys().parseRequestOptionsFromJSON(options) }));

/** Where the app the person came from is kept for this tab, since signing in with another site comes back without it. */
const KEPT = "account:app";

/**
 * The path of the page on this site that linked here, or else the app kept for this tab (keep), or null.
 * Coming back from another site's sign-in, the referrer is that site.
 */
export function referrer() {
  try {
    const from = new URL(document.referrer);
    if (from.origin === location.origin && !/^\/(account|auth)\//.test(from.pathname)) return from.pathname;
  } catch {}
  try {
    return sessionStorage.getItem(KEPT);
  } catch {
    return null;
  }
}

/** Keeps the app the person came from for this tab (or forgets it, given ""). */
export function keep(path) {
  try {
    if (path) sessionStorage.setItem(KEPT, path);
    else sessionStorage.removeItem(KEPT);
  } catch {}
  return true;
}

/** Leaves for another site to sign in: only the server's own sign-in starts. */
export function go(path) {
  if (typeof path !== "string" || !/^\/auth\/oauth\/[a-z0-9-]+\/start(\?|$)/.test(path)) throw new Error("account can only go to the server's sign-in");
  location.assign(path);
  return true;
}

/** Asks for a .json file (only right after the person clicks) and reads it, or null if they pick none. */
export function pick() {
  if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("A file can be chosen only right after the person clicks"));
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json", hidden: true });
    input.addEventListener("cancel", () => (input.remove(), resolve(null)));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      if (file.size > MAX) return reject(new Error(`A copy of a space is at most ${MAX / 1_000_000} MB`));
      file.text().then(resolve, reject);
    });
    document.body.append(input);
    input.click();
  });
}
