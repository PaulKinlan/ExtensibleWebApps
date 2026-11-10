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
import { service, SIGNED_IN, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** Where the server's accounts answer (src/server/auth/). */
const AUTH = "/auth/";
/** The folder the account app is in: only plugins it links may sign in as the person. */
const APP = "/account/";
/** An app's folder: /demos/reading-list/. */
const FOLDER = /^\/(?:[a-z0-9][a-z0-9-]*\/)+$/;

type Answer = { status: number; [key: string]: unknown };

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
    if (path === "/auth/me") await mark(res.ok).catch(() => {});
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
      if (method === "came") return cameFrom(host, dispatch);
      throw new Error(`account.${method} is not a method`);
    },
  };
};

export default service("account", make);
