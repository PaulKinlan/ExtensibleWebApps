// The `account` service: the person's account on this site's server, for the
// account app (account/app.html) and only for it. Its plugins show who is
// signed in, sign in with a passkey or another site, keep an email address,
// make and share spaces, and make agent keys. The server's side is
// src/server/auth/ (docs/server.md, step 5).
// A kernel module (docs/layers.md): a site that lists `account` in kernel.json has it, as `ctx.call("account", …)`.
//
// Signing in is the person acting as themselves on the whole site, so only the
// plugins the account app itself links (origin "app", loaded from /account/)
// may call this: not a person's own plugin, not one shared in a space, not
// another app's. And a plugin calls it from one tab (`scope: "tab"`), since a
// passkey is asked for in the tab the person clicked in.
//
// The server is asked from the kernel, on this site, so its sign-in cookie
// goes with each request. A passkey is made or used in the page (the
// `account` bridge, src/host/bridges/account.ts, which loads account/page.js): the browser's WebAuthn API
// only exists there. A plugin never sees the cookie or the passkey, only
// what the server answers.

import type { Host } from "../../src/kernel/hosts";
import { part } from "../../src/kernel/part";
import { service, SIGNED_IN, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** Where the server's accounts answer (src/server/auth/). */
const AUTH = "/auth/";
/** The folder the account app is in: only plugins it links may sign in as the person. */
const APP = "/account/";
/** An app's folder: /demos/reading-list/. */
const FOLDER = /^\/(?:[a-z0-9][a-z0-9-]*\/)+$/;

type Answer = { status: number; [key: string]: unknown };
/** The part that encrypts the person's API keys for their account (std/follow/vault.ts), fetched when they first ask about them. */
const vault = () => part("the part that keeps your keys encrypted", () => import("../follow/vault"));
/** Where what follows the person is kept (src/server/auth/follow.ts). */
const FOLLOW = "/auth/follow";

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, hosts, remote } = kernel;
  kernel.hook("account:changed", {
    mode: "emit",
    needs: "account",
    args: "{}",
    description: "The person signed in or out, or changed something in their account (an email address, a space, a key). Ask again for what you show.",
  });

  /** The tab a call comes from, after checking that the plugin may make it. */
  const from = (instance: string): Host => {
    if (hosts.mode === "server") throw new Error("account is only in the browser: a space's server has no one signed in");
    const [id, tab] = instance.split("@");
    const plugin = remote.installed.get(id);
    let folder = "";
    try {
      const at = new URL(plugin?.href ?? "");
      if (at.origin === self.location.origin) folder = at.pathname;
    } catch {}
    if (plugin?.origin !== "app" || !folder.startsWith(APP)) throw new Error("Only the account app's own plugins (account/app.html) can use account");
    const host = tab ? hosts.list.find((h) => h.tab === tab) : undefined;
    if (!host) throw new Error('account is called from a tab: give the plugin `scope: "tab"`');
    return host;
  };

  /**
   * Leaves a mark on this device while someone is signed in, and takes it away when no one is, so the modules
   * that need an account (`"starts": "account"`: std/follow, which brings what the person added on their other
   * devices) start with every app here, and only then.
   */
  const mark = async (signedIn: boolean) => {
    const marked = (await kernel.store.readText(SIGNED_IN)) !== undefined;
    if (signedIn === marked) return;
    if (signedIn) await kernel.store.writeText(SIGNED_IN, "{}");
    else await kernel.store.removeFile(SIGNED_IN);
    if (signedIn) root.emit("internal/account");
  };

  /** Asks the server, and gives back its answer with its status. A 401 is an answer (signed out), not an error. */
  const ask = async (path: string, body?: unknown): Promise<Answer> => {
    if (typeof path !== "string" || !path.startsWith(AUTH) || path.includes("..")) throw new Error(`account asks only the server's accounts, at ${AUTH}`);
    const res = await fetch(new URL(path, self.location.origin), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/auth/me" && (res.status === 404 || !res.headers.get("content-type")?.includes("json"))) return { status: 404, unavailable: true };
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a plain answer says who is signed in: a server that is failing says nothing about it.
    if (path === "/auth/me" && (res.ok || res.status === 401)) await mark(res.ok).catch(() => {});
    if (!res.ok && res.status !== 401) throw new Error(typeof data.error === "string" ? data.error : `The server answered ${res.status}`);
    return { ...data, status: res.status, site: self.location.origin };
  };
  const changed = () => root.emit({}, "account:changed", {});

  /** The app a person came to this page from, to open in a space: ?app=/demos/x/, or the app page that linked here. */
  const cameFrom = async (host: Host, dispatch: Parameters<ServiceProvider["call"]>[3]) => {
    // The tab keeps what was found, as signing in with another site comes back with no ?app= and that site as the referrer.
    const found = await lookUp(host, dispatch);
    if (found?.path || found?.error) await hosts.bridge("account", "keep", [found.path ?? ""], dispatch, host);
    return found;
  };
  const lookUp = async (host: Host, dispatch: Parameters<ServiceProvider["call"]>[3]): Promise<{ path?: string; title?: string; error?: string } | null> => {
    if (!host.url) throw new Error("The tab hasn't said its address yet: ask again once it has (router:changed)");
    const asked = host.url.query?.app;
    const exact = typeof asked === "string";
    let path = exact ? asked : (((await hosts.bridge("account", "referrer", [], dispatch, host)) as string | null) ?? "");
    if (!exact) path = path.replace(/^\/s\/[a-z0-9][a-z0-9-]*\//, "/").replace(/[^/]*$/, "");
    if (!FOLDER.test(path) || path.startsWith(APP)) return exact ? { error: `There's no app at ${asked} to open in a space.` } : null;
    // A page that linked here may be one of an app's screens (/demos/reading-list/book/42): its nearest folder with an app.html is the app.
    for (;;) {
      const res = await fetch(new URL(`${path}app.html`, self.location.origin)).catch(() => undefined);
      if (res?.ok && (res.headers.get("content-type") ?? "").includes("html")) {
        const title = /<title>([^<]*)<\/title>/i.exec(await res.text())?.[1]?.trim();
        return { path, title: title || path };
      }
      if (exact || path.split("/").length <= 3) return exact ? { error: `There's no app at ${asked} to open in a space.` } : null;
      path = path.replace(/[^/]+\/$/, "");
    }
  };

  // The person's API keys, following them between their devices (std/follow), encrypted with a vault key the
  // server never has. Turning that on, unlocking it on a new device and taking the keys out of the account again
  // are done here, on the account page, since they are the person acting as themselves on the whole site.
  type Locked = import("../follow/vault").Locked;
  /** What the account keeps of one kind: who is signed in, and the items. */
  const kept = async (kind: string): Promise<{ user?: string; items: { key: string; value?: unknown }[] }> => {
    const res = await fetch(new URL(`${FOLLOW}?since=0&only=${kind}`, self.location.origin), { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { user?: unknown; items?: unknown; error?: unknown };
    if (res.status === 401) return { items: [] };
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Your account couldn't be asked about your keys (the server answered ${res.status}). Try again in a moment.`);
    return { user: typeof data.user === "string" ? data.user : undefined, items: Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.key === "string" && !i.gone) : [] };
  };
  const send = async (changes: unknown[]) => {
    const res = await fetch(new URL(FOLLOW, self.location.origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes }) });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Your account couldn't be changed (the server answered ${res.status}). Try again in a moment.`);
  };
  /** How the person's keys stand: who they are, the vault key as the account keeps it, and this device's unlocked copy if it has one. */
  const standing = async () => {
    const { user, items } = await kept("vault");
    const vaults = Object.fromEntries(items.map((i) => [i.key, i.value as Locked]));
    const raw = user && items.length ? await (await vault()).unlocked(user, vaults) : undefined;
    return { user, vaults, raw };
  };
  const describe = (s: Awaited<ReturnType<typeof standing>>) => {
    const kinds = Object.values(s.vaults).map((v) => v?.kind);
    return { state: !s.user ? "signed-out" : !kinds.length ? "off" : s.raw ? "on" : "locked", passphrase: kinds.includes("pass"), passkey: kinds.includes("prf") };
  };
  /** What a passkey of the person's derives for their keys: asked for in the tab, and never sent anywhere. */
  const derive = async (host: Host, dispatch: Parameters<ServiceProvider["call"]>[3], creds: string[]) => {
    const { PRF_SALT } = await vault();
    return (await hosts.bridge("account", "derive", [PRF_SALT, creds], dispatch, host)) as { cred: string; derived: string };
  };
  /** Every kernel on the device that follows the account does so again now (std/follow hears this). */
  const follow = () => root.emit("internal/account");
  async function keys(host: Host, method: string, how: unknown, dispatch: Parameters<ServiceProvider["call"]>[3]) {
    const s = await standing();
    if (method === "keys") return describe(s);
    if (!s.user) throw new Error("You're signed out: sign in again, then try once more.");
    const v = await vault();
    const passkey = (how as { passkey?: unknown } | undefined)?.passkey === true;
    // A passphrase is typed into a card the kernel draws in this tab, so no plugin ever holds it.
    const typed = (twice: boolean) =>
      kernel.secrets.ask({
        heading: twice ? "Choose a passphrase for your keys" : "Unlock your keys",
        text: twice
          ? `Your API keys are encrypted with it on this device before they go to your account, so this site can never read them. At least ${v.MIN_PASSPHRASE} characters: a few words you'll remember work well. If you lose it, nobody can get your keys back, and you'd type them in again.`
          : "Type the passphrase you chose for your keys. It unlocks them on this device once, and is never sent to this site.",
        label: "Passphrase",
        twice,
        tab: host.tab,
      });
    if (method === "keys:remove") {
      const all = [...Object.keys(s.vaults), ...(await kept("key")).items.map((i) => i.key)];
      if (all.length) await send(all.map((key) => ({ key, gone: true })));
      await v.keep(s.user).catch(() => {});
    } else if (method === "keys:protect") {
      // The first secret makes the vault key; another is one more way to unlock the same one.
      if (Object.keys(s.vaults).length && !s.raw) throw new Error("Unlock your keys on this device first, then add another way to unlock them.");
      const raw = s.raw ?? v.fresh();
      let key: string;
      let locked: Locked;
      if (passkey) {
        const { cred, derived } = await derive(host, dispatch, []);
        [key, locked] = [await v.prfName(cred), await v.lockWithPasskey(s.user, raw, cred, derived)];
      } else {
        const passphrase = await typed(true);
        if (passphrase === undefined) return describe(s);
        if (passphrase.length < v.MIN_PASSPHRASE) throw new Error(`Choose a passphrase of at least ${v.MIN_PASSPHRASE} characters: a few words you'll remember work well.`);
        [key, locked] = ["vault:pass", await v.lockWithPassphrase(s.user, raw, passphrase)];
      }
      await send([{ key, h: await v.hashOf(locked), value: locked }]);
      await v.keep(s.user, raw);
    } else if (method === "keys:unlock") {
      let raw: Uint8Array | undefined;
      if (passkey) {
        const locks = Object.values(s.vaults).filter((l): l is Extract<Locked, { kind: "prf" }> => l?.kind === "prf");
        if (!locks.length) throw new Error("Your keys aren't protected with a passkey. Use your passphrase instead.");
        const { cred, derived } = await derive(host, dispatch, locks.map((l) => l.cred));
        const lock = locks.find((l) => l.cred === cred);
        raw = lock && (await v.unlock(s.user, lock, derived));
        if (!raw) throw new Error("That passkey isn't the one that protects your keys. Use the passkey you set them up with, or your passphrase.");
      } else {
        const lock = s.vaults["vault:pass"];
        if (!lock) throw new Error("Your keys aren't protected with a passphrase. Use your passkey instead.");
        const passphrase = await typed(false);
        if (passphrase === undefined) return describe(s);
        raw = await v.unlock(s.user, lock, passphrase);
        if (!raw) throw new Error("That passphrase didn't unlock your keys. Check it and try again.");
      }
      await v.keep(s.user, raw);
    } else throw new Error(`account.${method} is not a method`);
    follow();
    changed();
    return describe(await standing());
  }

  return {
    description: "The person's account on this site's server, for the account app's own plugins: who is signed in, passkeys, other sites to sign in with, their email address, spaces and agent keys.",
    methods: {
      get: {
        args: "(path)",
        returns: "{ status, site, ...answer }",
        needs: "account",
        params: [{ name: "path", schema: { type: "string", description: "A path under /auth/: /auth/me, /auth/spaces, /auth/keys, /auth/providers" } }],
        description: "Asks the server's accounts (src/server/auth/) for something, as the person signed in on this device; `site` is the site's own address, for links to it. A 401 comes back as { status: 401 }, not an error; /auth/me answers { status: 404, unavailable: true } when the site has no server.",
      },
      post: {
        args: "(path, body)",
        returns: "{ status, ...answer }",
        needs: "account",
        params: [
          { name: "path", schema: { type: "string", description: "A path under /auth/: /auth/spaces, /auth/me/email, /auth/keys/revoke…" } },
          { name: "body", schema: { type: "object", description: "What to send, as JSON" } },
        ],
        description: "Sends something to the server's accounts as the person, and raises account:changed when it works.",
      },
      "space-key": {
        args: "(space, vendor, label?)",
        returns: "{ set, vendor, model, byName, at } or null",
        needs: "account",
        params: [
          { name: "space", schema: { type: "string", description: "A space the person owns" } },
          { name: "vendor", schema: { type: "string", description: "Whose key it is: a vendor's id from /auth/spaces/<space>/model" } },
          { name: "label", optional: true, schema: { type: "string", description: "The vendor's name, for the card" } },
        ],
        description: "Gives a space a model key for its members (src/server/space-model.ts): the person types it into a card the kernel draws, and it goes straight to the server, which keeps it encrypted. No plugin sees it. null if they closed the card.",
      },
      register: {
        args: "(name?)",
        returns: "{ status }",
        needs: "account",
        params: [{ name: "name", schema: { type: "string", description: "The new account's name; leave it out to add a passkey to the account signed in" } }],
        description: "Makes a passkey in this tab (the browser asks the person) and gives it to the server: a new account called `name`, or another passkey for the account signed in.",
      },
      signin: {
        args: "()",
        returns: "{ status, error? }",
        needs: "account",
        params: [],
        description: "Signs in with a passkey the browser has for this site (it asks the person which). { status: 401, error } if the server didn't know it.",
      },
      start: {
        args: "(provider, fields?)",
        returns: "true",
        needs: "account",
        params: [
          { name: "provider", schema: { type: "string", description: "A provider's id from /auth/providers" } },
          { name: "fields", schema: { type: "object", description: "What the provider asks for first (its `ask`), and an invite to accept once signed in" } },
        ],
        description: "Goes to another site to sign in (or, signed in, to link that account): the tab leaves the app, and comes back to /account/.",
      },
      load: {
        args: "(space)",
        returns: "{ status } | null",
        needs: "account",
        params: [{ name: "space", schema: { type: "string", description: "A space the person owns, empty" } }],
        description: "Asks the person for a copy of a space (a .space.json file, from the server's Download a copy), right after they click, and loads it into `space`. null if they pick nothing.",
      },
      keys: {
        args: "()",
        returns: "{ state, passphrase, passkey }",
        needs: "account",
        params: [],
        description: "Whether the person's API keys follow them between devices: `state` is off, locked (their account keeps them, and this device hasn't been given what unlocks them), on, or signed-out; `passphrase` and `passkey` say what unlocks them. The server keeps them encrypted and can't read one.",
      },
      "keys:protect": {
        args: "({ passkey: true }?)",
        returns: "{ state, passphrase, passkey }",
        needs: "account",
        params: [{ name: "how", schema: { type: "object", description: "`passkey: true` to use a passkey of theirs (the browser asks). Left out, the person chooses a passphrase, in a card the kernel draws: a plugin never sees it" } }],
        description: "Has the person's API keys follow them, encrypted on this device with a key only that passphrase or passkey unlocks. Called again on a device that has them unlocked, it adds another way to unlock them.",
      },
      "keys:unlock": {
        args: "({ passkey: true }?)",
        returns: "{ state, passphrase, passkey }",
        needs: "account",
        params: [{ name: "how", schema: { type: "object", description: "`passkey: true` to use the passkey that protects them. Left out, the person types their passphrase, in a card the kernel draws" } }],
        description: "Unlocks the person's API keys on this device, once: from then on they come and go with everything else that follows them. It fails, saying so, if the passphrase or passkey isn't the one.",
      },
      "keys:remove": {
        args: "()",
        returns: "{ state, passphrase, passkey }",
        needs: "account",
        params: [],
        description: "Takes the person's API keys out of their account. Each device keeps the keys it has, and asks for a key it hasn't.",
      },
      came: {
        args: "()",
        returns: "{ path, title } | { error } | null",
        needs: "account",
        params: [],
        description: "The app the person came here from, to open in a space: the one named in ?app=/demos/x/, or the app page that linked here. null if neither. It fails, saying so, while the tab is still opening; ask again then.",
      },
    },
    capability: () => "account",
    call: async (instance, method, args, dispatch) => {
      const host = from(instance);
      if (method === "get") return ask(String(args[0]));
      if (method === "post") {
        const answer = await ask(String(args[0]), args[1] ?? {});
        if (answer.status < 400) changed();
        return answer;
      }
      if (method === "register") {
        const name = args[0];
        const options = await ask("/auth/register/options", typeof name === "string" ? { name } : {});
        const credential = await hosts.bridge("account", "create", [options], dispatch, host);
        const answer = await ask("/auth/register", credential);
        changed();
        return answer;
      }
      if (method === "signin") {
        const options = await ask("/auth/signin/options", {});
        const credential = await hosts.bridge("account", "get", [options], dispatch, host);
        const answer = await ask("/auth/signin", credential);
        if (answer.status < 400) changed();
        return answer;
      }
      if (method === "start") {
        const [provider, fields] = args as [unknown, Record<string, unknown> | undefined];
        if (typeof provider !== "string" || !/^[a-z0-9-]+$/.test(provider)) throw new Error("account.start takes a provider's id");
        const query = new URLSearchParams(Object.entries(fields ?? {}).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, String(v)]));
        const search = query.size ? `?${query}` : "";
        await hosts.bridge("account", "go", [`/auth/oauth/${provider}/start${search}`], dispatch, host);
        return true;
      }
      if (method === "load") {
        const space = args[0];
        if (typeof space !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(space)) throw new Error("account.load takes a space's name");
        const text = (await hosts.bridge("account", "pick", [], dispatch, host)) as string | null;
        if (text === null) return null;
        const res = await fetch(new URL(`/auth/spaces/${space}/import`, self.location.origin), { method: "POST", headers: { "content-type": "application/json" }, body: text });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `The server answered ${res.status}`);
        changed();
        return { ...data, status: res.status };
      }
      if (method === "space-key") {
        const [space, vendor, label] = args;
        if (typeof space !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(space)) throw new Error("account.space-key takes a space's name");
        if (typeof vendor !== "string" || !/^[a-z0-9-]+$/.test(vendor)) throw new Error("account.space-key takes whose key it is");
        const whose = typeof label === "string" && label ? label.slice(0, 40) : vendor;
        // Typed into a card the kernel draws in this tab, and sent straight to the server: no plugin ever holds it.
        const key = await kernel.secrets.ask({
          heading: `A ${whose} key for ${space}`,
          text: `Paste a ${whose} API key. It goes to this site's server, which keeps it encrypted and uses it only to ask ${whose} for the members of ${space}. It is never sent back to a browser, yours included. You pay for what the members ask, so make a key just for this where ${whose} lets you, with a spending limit.`,
          label: "API key",
          twice: false,
          tab: host.tab,
        });
        if (key === undefined) return null;
        const res = await fetch(new URL(`/auth/spaces/${space}/model/key`, self.location.origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vendor, key }) });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `The server answered ${res.status}`);
        changed();
        return { ...data, status: res.status };
      }
      if (method === "came") return cameFrom(host, dispatch);
      if (method === "keys" || method.startsWith("keys:")) return keys(host, method, args[0], dispatch);
      throw new Error(`account.${method} is not a method`);
    },
  };
};

export default service("account", make);
