// Accounts and sign-in, the same on every host: a person, their passkeys, and
// the sessions they're signed in with, kept as files on the files seam. The
// Node host keeps them in <spaces>/_accounts/; on Cloudflare they live in a
// Durable Object of their own (src/server/cloudflare/worker.ts).
//
// The routes, all under /auth/ and all JSON:
//   POST /auth/register/options  { name }   options for a new passkey (a new account, or one more for
//                                            the person signed in)
//   POST /auth/register          credential the new passkey; signs in
//   POST /auth/signin/options                options for signing in with any passkey for this site
//   POST /auth/signin            credential signs in
//   GET  /auth/me                           who is signed in (401 if no one)
//   POST /auth/signout                      ends this session
//   POST /auth/me/email          { email }  sets your address ("" removes it) and mails it a link to confirm it
//   POST /auth/me/email/confirm  { token }  confirms it (the link opens /account/?confirm=<token>, which posts here)
//   POST /auth/me/email/test                sends your confirmed address a test message, to see mail arrives
//   GET  /auth/providers                    the other sites you can sign in with (providers.ts)
//   GET  /auth/oauth/<id>/start             goes to that site to sign in (or, signed in, to link it);
//                                            ?return=/auth/mcp/authorize?… comes back there instead of /account/
//   GET  /auth/oauth/<id>/callback          where that site sends you back; signs in, then /account/
//   GET  /auth/oauth/<id>/<other>           anything else a flow serves (Bluesky's client metadata)
//
// And the spaces people share (a space holds people and data; any app can
// open in it, and a personal space is one with one member):
//   GET  /auth/spaces                       the spaces you're in, with your role
//   POST /auth/spaces            { name }   makes a space, with you as its owner
//   GET  /auth/spaces/<name>                its members (members only)
//   POST /auth/spaces/<name>/invite         a one-time invite to it (its owner only)
//   POST /auth/invites/accept    { token }  joins the space an invite is for
//   POST /auth/spaces/<name>/leave { user? } leaves it, or (its owner) removes someone
//
// And what a person added to their apps, which follows them to each device they sign in on (follow.ts):
//   GET  /auth/follow?since=<n>, POST /auth/follow { changes }
//
// And the keys members give agents outside the browser, to reach a space's MCP server (agent-keys.ts):
//   GET  /auth/keys, POST /auth/keys { space, name }, POST /auth/keys/revoke { id }
// or that an MCP client gets by signing in with OAuth (mcp-oauth.ts): /auth/mcp/* and /.well-known/oauth-*.
//
// A host lets a client join a space's kernel only if `member()` says it's in it.
//
// A session is a random token in an HttpOnly cookie; the server keeps only its
// hash, so its files can't be used to sign in.

import { isAddress } from "../../kernel/address.ts";
import type { Email, Files } from "../../seams/index.ts";
import { agentKeys } from "./agent-keys.ts";
import { follow } from "./follow.ts";
import { mcpOAuth } from "./mcp-oauth.ts";
import { isFlow, type OAuthProvider, type Provider } from "./providers.ts";
import { ALGORITHMS, b64url, unb64url, type CredentialJSON, type PublicKey, verifyAssertion, verifyRegistration } from "./webauthn.ts";

export interface User {
  id: string;
  name: string;
  created: number;
  /**
   * The address they typed on /account/. A space's server plugins may email it (std/email/module.ts
   * sends only to its members' addresses) once it's confirmed: a link to confirm it is mailed to it.
   */
  email?: string;
  /** Whether they opened the link mailed to `email`, so it's theirs. */
  emailConfirmed?: boolean;
  /** The hash of the one link that can confirm `email` now: a new address, or none, retires the last. */
  emailLink?: string;
  /** How many messages the accounts sent them today (links to confirm, tests), to keep it to a few. */
  mailed?: { day: string; sent: number };
}

interface Credential {
  id: string;
  user: string;
  key: PublicKey;
  counter: number;
  created: number;
}

interface Challenge {
  kind: "register" | "signin" | "oauth";
  /** For another site's sign-in: which provider, and the PKCE verifier its code needs. */
  provider?: string;
  verifier?: string;
  /** An invite to accept once back on /account/, so signing in with another site doesn't lose it. */
  invite?: string;
  /** Where to go once signed in, if not /account/: the page where an agent asks to connect (mcp-oauth.ts). */
  then?: string;
  /** What a flow (providers.ts) keeps between its start and its callback. */
  data?: Record<string, unknown>;
  expires: number;
  /** For a registration: the account it adds to (new or signed in), and that account's name. */
  user?: string;
  name?: string;
  /** For one more passkey on an account: the session that asked, which must still be signed in. */
  session?: string;
}

export type Role = "owner" | "member";

interface Space {
  name: string;
  owner: string;
  members: Record<string, Role>;
  created: number;
}

/** A space's name: what /s/<name>/kernel and the hosts' folders use. */
export const SPACE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INVITE_MS = 7 * 24 * 3600_000;

const COOKIE = "ewa-session";
const SESSION_MS = 30 * 24 * 3600_000;
const CHALLENGE_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,1400}$/;
const INVITE = /^[A-Za-z0-9_-]{20,100}$/;
/** Where a sign-in with another site may come back to instead of /account/: only the page where an agent asks to connect. */
const RETURN = /^\/auth\/mcp\/authorize\?[A-Za-z0-9%._~*&=+-]{1,4000}$/;
const MAX_BODY = 64 * 1024;
const SWEEP_MS = 10 * 60_000;

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const hash = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** A request's body, read only up to `limit` bytes: null if it's longer. */
export async function bodyOf(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) all.set(chunk, (at += chunk.byteLength) - chunk.byteLength);
  return new TextDecoder().decode(all);
}

/** What a host is told, to act on at once. */
export interface Hooks {
  /** Someone left a space, or was removed from it: close their connections to it. */
  left?(space: string, user: string): void | Promise<void>;
  /** An agent key for a space stopped working (revoked, renewed, or its member left): end what it still has open (src/server/mcp.ts). */
  keys?(space: string): void | Promise<void>;
  /** Sends a message, as the host sends a space's email; null when the host has no mail set up. */
  mail?(message: Parameters<Email["send"]>[0]): Promise<Awaited<ReturnType<Email["send"]>> | null>;
}

/** Messages the accounts send one person in a day: links to confirm an address, and tests. */
const MAILS_PER_DAY = 5;
/** How long a link to confirm an address works. */
const CONFIRM_MS = 24 * 60 * 60 * 1000;

/** Today's count of messages sent to someone, one more, or null when that's past the day's limit. */
const mailCount = (user: User): { day: string; sent: number } | null => {
  const day = new Date().toISOString().slice(0, 10);
  const sent = user.mailed?.day === day ? user.mailed.sent : 0;
  return sent >= MAILS_PER_DAY ? null : { day, sent: sent + 1 };
};

/** The routes, for a host to call with each request under /auth/. */
export function accounts(files: Files, providers: Provider[] = [], hooks: Hooks = {}) {
  // Every change runs one at a time: a check and the write that follows it
  // (a challenge used once, a passkey's counter, a new name) can't interleave
  // with another request's, on either host.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const read = async <T>(path: string): Promise<T | null> => {
    const text = await files.readText(path);
    return text === null ? null : (JSON.parse(text) as T);
  };
  const write = (path: string, value: unknown) => files.write(path, JSON.stringify(value));

  /** Takes a challenge once: a challenge used, or out of date, is gone. */
  const take = async (challenge: unknown, kind: Challenge["kind"]): Promise<Challenge | null> => {
    if (typeof challenge !== "string" || !ID.test(challenge)) return null;
    const found = await read<Challenge>(`challenges/${challenge}.json`);
    if (!found) return null;
    await files.remove(`challenges/${challenge}.json`);
    return found.kind === kind && found.expires > Date.now() ? found : null;
  };

  /** Who a request's session cookie belongs to, if it's current. */
  const session = async (request: Request): Promise<{ user: User; key: string } | null> => {
    const token = /(?:^|;\s*)ewa-session=([A-Za-z0-9_-]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token) return null;
    const key = await hash(token);
    const found = await read<{ user: string; expires: number }>(`sessions/${key}.json`);
    if (!found || found.expires < Date.now()) return null;
    const user = await read<User>(`users/${found.user}.json`);
    return user ? { user, key } : null;
  };

  /** A new session for someone, as the cookie that holds it. */
  const sessionCookie = async (request: Request, user: User): Promise<string> => {
    const token = random(32);
    await write(`sessions/${await hash(token)}.json`, { user: user.id, expires: Date.now() + SESSION_MS });
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`;
  };

  const signIn = async (request: Request, user: User): Promise<Response> => json({ user }, 200, { "set-cookie": await sessionCookie(request, user) });

  /** Who is asking, if they're signed in: their account, and the session they asked from. */
  const asker = async (request: Request) => {
    const current = await session(request);
    return current ? { user: current.user.id, session: current.key } : {};
  };

  /**
   * Another site's sign-in (OAuth 2 with PKCE). `start` sends the browser there with a state that is
   * kept here and in a cookie only this browser has, so a callback someone else started is refused.
   * The callback trades the code for a token, asks who it belongs to, and finds (or makes) the account
   * that identity belongs to. Signed in already, it links the identity to that account instead.
   */
  const oauth = async (request: Request, url: URL, id: string, step: string): Promise<Response | undefined> => {
    const provider = providers.find((p) => p.id === id);
    if (!provider) return json({ error: "No such provider" }, 404);
    const back = `${url.origin}/auth/oauth/${id}/callback`;
    const secure = url.protocol === "https:" ? "; Secure" : "";
    const toAccount = (headers: Headers, error?: string, invite?: string, then?: string) => {
      headers.set("location", error ? `/account/?error=${encodeURIComponent(error)}` : invite ? `/account/?invite=${invite}` : (then ?? "/account/"));
      headers.append("set-cookie", `ewa-oauth=; Path=/auth/oauth/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
      return new Response(null, { status: 303, headers });
    };

    if (step === "start") {
      // Only this site's own pages start a sign-in. A link on another site would otherwise carry
      // the signed-in person's cookie here, and link an account its author chose to theirs.
      // (A client that isn't a browser sends no Sec-Fetch-Site.)
      const from = request.headers.get("sec-fetch-site");
      if (from !== null && from !== "same-origin" && from !== "none") return toAccount(new Headers(), "Start signing in from this site's own page");
      const state = random(24);
      const verifier = random(48);
      const invite = url.searchParams.get("invite") ?? "";
      // Only back to this site's page where an agent asks to connect: never anywhere else.
      const then = url.searchParams.get("return") ?? "";
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      let to: string;
      let data: Record<string, unknown> | undefined;
      if (isFlow(provider)) {
        // A flow may need to look things up first (Bluesky finds the person's server), or send the browser elsewhere.
        try {
          ({ location: to, data } = await provider.start({ url, back, state, challenge }));
        } catch (error) {
          return toAccount(new Headers(), messageOf(error, `${provider.name} didn't start a sign-in`));
        }
        if (!data) {
          // Sent to another address of this site first (Bluesky's localhost to 127.0.0.1): the session
          // doesn't go along, so linking would become a sign-in to some other account.
          if ((await asker(request)).user) return toAccount(new Headers(), `To link ${provider.name}, sign in at ${new URL(to).host} first`);
          return new Response(null, { status: 302, headers: { location: to } });
        }
      } else {
        const at = new URL(provider.authorize);
        for (const [k, v] of Object.entries({ client_id: provider.clientId, redirect_uri: back, state, scope: provider.scope, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })) if (v) at.searchParams.set(k, v);
        to = at.href;
      }
      await sweep();
      await write(`challenges/${state}.json`, { kind: "oauth", provider: id, verifier, ...(await asker(request)), ...(INVITE.test(invite) ? { invite } : {}), ...(RETURN.test(then) ? { then } : {}), ...(data ? { data } : {}), expires: Date.now() + CHALLENGE_MS } satisfies Challenge);
      return new Response(null, { status: 302, headers: { location: to, "set-cookie": `ewa-oauth=${state}; Path=/auth/oauth/; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_MS / 1000}${secure}` } });
    }
    if (step !== "callback") return isFlow(provider) ? provider.serve?.(url, step) : undefined;

    const state = url.searchParams.get("state") ?? "";
    const mine = /(?:^|;\s*)ewa-oauth=([A-Za-z0-9_-]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const found = mine === state ? await serial(() => take(state, "oauth")) : null;
    if (!found || found.provider !== id || !found.verifier) return toAccount(new Headers(), "That sign-in has expired; try again");
    const code = url.searchParams.get("code");
    if (!code) return toAccount(new Headers(), `${provider.name} didn't sign you in`);

    let theirs: { id: string; name: string };
    try {
      theirs = isFlow(provider) ? await provider.finish({ url, back, data: found.data ?? {}, verifier: found.verifier }) : await whoAt(provider, code, back, found.verifier);
    } catch (error) {
      return toAccount(new Headers(), messageOf(error, `${provider.name} didn't say who you are`, isFlow(provider)));
    }
    const theirId = theirs.id;
    if (!theirId || theirId === "undefined") return toAccount(new Headers(), `${provider.name} didn't say who you are`);

    // The identity's file is named by a hash, so any id a provider uses makes a safe path.
    const identity = `identities/${id}/${await hash(theirId)}.json`;
    // Linking needs the session that started it, still signed in.
    if (found.session && (await session(request))?.key !== found.session) return toAccount(new Headers(), "Sign in again, then link it");
    // The rest reads and writes accounts, so it runs one at a time with every other change.
    return serial(async () => {
      const linked = await read<{ user: string }>(identity);
      let user = linked ? await read<User>(`users/${linked.user}.json`) : null;
      if (found.user) {
        // Linking: the identity joins the signed-in account, unless it's already someone else's.
        if (linked && linked.user !== found.user) return toAccount(new Headers(), `That ${provider.name} account is linked to another account here`);
        user = await read<User>(`users/${found.user}.json`);
        if (!user) return toAccount(new Headers(), "Sign in again, then link it");
        await write(identity, { user: user.id, provider: id, created: Date.now() });
      } else if (!user) {
        user = { id: random(16), name: theirs.name.slice(0, 64), created: Date.now() };
        await write(`users/${user.id}.json`, user);
        await write(identity, { user: user.id, provider: id, created: Date.now() });
      }
      const headers = new Headers();
      headers.append("set-cookie", await sessionCookie(request, user));
      return toAccount(headers, undefined, found.invite, found.then);
    });
  };

  /** Clears challenges and sessions that have run out, so they don't pile up: at most every ten minutes. */
  let swept = 0;
  const sweep = async () => {
    if (Date.now() - swept < SWEEP_MS) return;
    swept = Date.now();
    for (const path of [...(await files.list("challenges/")), ...(await files.list("sessions/")), ...(await files.list("invites/")), ...(await files.list("email-links/"))]) {
      const found = await read<{ expires: number }>(path);
      if (!found || found.expires < Date.now()) await files.remove(path);
    }
  };

  /** A person's passkeys. */
  const credentials = async (user: string): Promise<Credential[]> => {
    const all = await Promise.all((await files.list("credentials/")).map((path) => read<Credential>(path)));
    return all.filter((c): c is Credential => c?.user === user);
  };

  /** A space's record, if the name is a space's. */
  const spaceOf = (name: string) => (SPACE_NAME.test(name) ? read<Space>(`spaces/${name}.json`) : Promise.resolve(null));

  const keys = agentKeys(files, { isMember: async (name, user) => !!(await spaceOf(name))?.members[user], ended: (name) => hooks.keys?.(name) });
  const mcpSignIn = mcpOAuth(files, {
    user: async (request) => (await session(request))?.user ?? null,
    isMember: async (name, user) => !!(await spaceOf(name))?.members[user],
    keys,
    serial,
    providers: () => providers.map((p) => ({ id: p.id, name: p.name, ...(isFlow(p) && p.ask ? { ask: p.ask } : {}) })),
  });

  const following = follow(files, async (request) => (await session(request))?.user ?? null, serial);

  const join = async (space: Space, user: string, role: Role) => {
    space.members[user] = role;
    await write(`spaces/${space.name}.json`, space);
    await write(`memberships/${user}/${space.name}.json`, { role });
  };

  const leave = async (space: Space, user: string) => {
    delete space.members[user];
    await write(`spaces/${space.name}.json`, space);
    await files.remove(`memberships/${user}/${space.name}.json`);
    // Their agents' keys for it end too (and so a signed-in agent's refreshing): joining again starts afresh.
    await keys.revokeSpace(user, space.name);
    await Promise.resolve(hooks.left?.(space.name, user)).catch((error) => console.error("Closing a member's connections:", error));
  };

  /** Space routes: GET and POST, all for someone signed in. */
  const spaces = async (request: Request, path: string, body: Record<string, unknown>): Promise<Response | undefined> => {
    const current = await session(request);
    if (!current) return json({ error: "Not signed in" }, 401);
    const me = current.user.id;
    const route = `${request.method} ${path}`;

    if (route === "GET /auth/spaces") {
      const mine = await Promise.all(
        (await files.list(`memberships/${me}/`)).map(async (p) => ({ name: p.slice(`memberships/${me}/`.length, -".json".length), role: (await read<{ role: Role }>(p))?.role })),
      );
      return json({ spaces: mine });
    }
    if (route === "POST /auth/spaces") {
      const name = String(body.name ?? "");
      if (!SPACE_NAME.test(name)) return json({ error: "A space's name is lowercase letters, numbers and dashes" }, 400);
      if (await spaceOf(name)) return json({ error: "That name is taken" }, 409);
      const space: Space = { name, owner: me, members: {}, created: Date.now() };
      await join(space, me, "owner");
      return json({ space: { name, role: "owner" } });
    }
    if (route === "POST /auth/invites/accept") {
      const token = String(body.token ?? "");
      const key = await hash(token);
      const invite = /^[A-Za-z0-9_-]{20,100}$/.test(token) ? await read<{ space: string; expires: number }>(`invites/${key}.json`) : null;
      const space = invite && invite.expires > Date.now() ? await spaceOf(invite.space) : null;
      if (!space) return json({ error: "That invite has been used or has expired" }, 404);
      // One person, one use: the invite is gone once someone joins with it.
      await files.remove(`invites/${key}.json`);
      if (!space.members[me]) await join(space, me, "member");
      return json({ space: { name: space.name, role: space.members[me] } });
    }

    const match = /^\/auth\/spaces\/([^/]+)(\/invite|\/leave)?$/.exec(path);
    const space = match ? await spaceOf(match[1]) : null;
    // Someone who isn't in a space can't tell it from one that doesn't exist.
    if (!match || !space || !space.members[me]) return match ? json({ error: "No such space" }, 404) : undefined;
    const action = `${request.method} ${match[2] ?? ""}`;

    if (action === "GET ") {
      const members = await Promise.all(Object.entries(space.members).map(async ([id, role]) => ({ id, role, name: (await read<User>(`users/${id}.json`))?.name ?? "?" })));
      return json({ name: space.name, members });
    }
    if (action === "POST /invite") {
      if (space.members[me] !== "owner") return json({ error: "Only the space's owner can invite people" }, 403);
      const token = random(24);
      await write(`invites/${await hash(token)}.json`, { space: space.name, by: me, expires: Date.now() + INVITE_MS });
      return json({ token, expires: Date.now() + INVITE_MS });
    }
    if (action === "POST /leave") {
      const who = typeof body.user === "string" ? body.user : me;
      if (who !== me && space.members[me] !== "owner") return json({ error: "Only the space's owner can remove people" }, 403);
      if (space.members[who] === "owner") return json({ error: "A space's owner can't leave it" }, 400);
      if (!space.members[who]) return json({ error: "They aren't in this space" }, 404);
      await leave(space, who);
      return json({ ok: true });
    }
    return undefined;
  };

  return {
    credentials,

    /** Whether a request's session is a member of a space, and as what: for a host to ask before a client joins it. */
    async member(request: Request, name: string): Promise<{ user: User; role: Role } | null> {
      const current = await session(request);
      const space = current ? await spaceOf(name) : null;
      const role = space && current ? space.members[current.user.id] : undefined;
      return current && role ? { user: current.user, role } : null;
    },

    /** The email addresses a space's members gave (User.email): the only ones its server plugins may email. */
    async addresses(name: string): Promise<string[]> {
      const space = await spaceOf(name);
      if (!space) return [];
      const users = await Promise.all(Object.keys(space.members).map((id) => read<User>(`users/${id}.json`)));
      // Only an address its owner confirmed: anyone can type someone else's.
      return users.flatMap((u) => (u?.email && u.emailConfirmed ? [u.email] : []));
    },

    /** Which member of a space an agent's key (an `Authorization` header) is for: for a host to ask before an MCP request. */
    agent: (authorization: string | null, name: string, plugin?: string) => keys.member(authorization, name, plugin),

    /** A space's members, each with the name on their account: what a page shows for a change's `by`. */
    async members(name: string): Promise<{ id: string; name: string }[]> {
      const space = await spaceOf(name);
      if (!space) return [];
      const users = await Promise.all(Object.keys(space.members).map((id) => read<User>(`users/${id}.json`)));
      return users.flatMap((u) => (u ? [{ id: u.id, name: u.name }] : []));
    },

    /** Whether a space by this name exists: for a host to ask before waking it for a public route. */
    async exists(name: string): Promise<boolean> {
      return (await spaceOf(name)) !== null;
    },

    /** Answers a request under /auth/, or gives undefined for one that isn't a route. */
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      // An MCP client signing in (mcp-oauth.ts): its own checks, since its forms and clients aren't this site's pages.
      const signingIn = await mcpSignIn.handle(request);
      if (signingIn) return signingIn;
      // What a person added, following them from device to device (follow.ts).
      const followed = await following.handle(request, url);
      if (followed) return followed;

      if (route === "GET /auth/me") {
        const current = await session(request);
        return current ? json({ user: current.user }) : json({ error: "Not signed in" }, 401);
      }
      if (request.method === "GET" && url.pathname.startsWith("/auth/spaces")) return spaces(request, url.pathname, {});
      if (route === "GET /auth/keys") {
        const current = await session(request);
        return current ? json({ keys: await keys.list(current.user.id) }) : json({ error: "Not signed in" }, 401);
      }
      if (route === "GET /auth/providers") return json({ providers: providers.map((p) => ({ id: p.id, name: p.name, ...(isFlow(p) && p.ask ? { ask: p.ask } : {}) })) });
      const other = /^\/auth\/oauth\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(url.pathname);
      if (other && request.method === "GET") return oauth(request, url, other[1], other[2]);
      if (request.method !== "POST" || !url.pathname.startsWith("/auth/")) return undefined;
      // Only this site's own pages may sign in or out (a form on another site can't).
      if (request.headers.get("origin") !== url.origin) return json({ error: "Not from this site" }, 403);
      const text = await bodyOf(request, MAX_BODY);
      if (text === null) return json({ error: "Too big" }, 413);
      let body: Record<string, unknown> = {};
      try {
        if (text) body = JSON.parse(text);
      } catch {
        return json({ error: "JSON only" }, 400);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "A JSON object, please" }, 400);
      return serial(() => change(request, url, body));
    },

    /** Who a request is signed in as, for a host to ask when a client joins a space. */
    async user(request: Request): Promise<User | null> {
      return (await session(request))?.user ?? null;
    },
  };

  /** A POST under /auth/, run one at a time. */
  async function change(request: Request, url: URL, body: Record<string, unknown>): Promise<Response | undefined> {
    const where = { origin: url.origin, rpId: url.hostname };
    if (url.pathname.startsWith("/auth/spaces") || url.pathname === "/auth/invites/accept") return spaces(request, url.pathname, body);
    switch (url.pathname) {
      case "/auth/register/options": {
        const current = await session(request);
        const name = current?.user.name ?? String(body.name ?? "").trim().slice(0, 64);
        if (!name) return json({ error: "A name, please" }, 400);
        const user = current?.user.id ?? random(16);
        const challenge = random(32);
        await sweep();
        await write(`challenges/${challenge}.json`, { kind: "register", expires: Date.now() + CHALLENGE_MS, user, name, session: current?.key } satisfies Challenge);
        const existing = current ? await credentials(user) : [];
        return json({
          challenge,
          rp: { id: where.rpId, name: "Extensible Web Apps" },
          user: { id: user, name, displayName: name },
          pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
          attestation: "none",
          excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
          timeout: CHALLENGE_MS,
        });
      }
      case "/auth/register": {
        const credential = body as unknown as CredentialJSON;
        const challenge = clientChallenge(credential);
        const found = await take(challenge, "register");
        if (!found?.user || !found.name) return json({ error: "That registration has expired; try again" }, 400);
        // One more passkey for an account needs the session that asked for it, still signed in.
        if (found.session && (await session(request))?.key !== found.session) return json({ error: "Sign in again to add a passkey" }, 401);
        if (!found.session && (await files.readText(`users/${found.user}.json`))) return json({ error: "That registration has expired; try again" }, 400);
        let made;
        try {
          made = await verifyRegistration(credential, { challenge: challenge!, ...where });
        } catch (error) {
          return json({ error: String((error as Error).message ?? error) }, 400);
        }
        if (await files.readText(await credentialPath(made.id))) return json({ error: "That passkey is already registered" }, 409);
        const user = (await read<User>(`users/${found.user}.json`)) ?? { id: found.user, name: found.name, created: Date.now() };
        await write(`users/${user.id}.json`, user);
        await write(await credentialPath(made.id), { id: made.id, user: user.id, key: made.key, counter: made.counter, created: Date.now() } satisfies Credential);
        return signIn(request, user);
      }
      case "/auth/signin/options": {
        const challenge = random(32);
        await sweep();
        await write(`challenges/${challenge}.json`, { kind: "signin", expires: Date.now() + CHALLENGE_MS } satisfies Challenge);
        return json({ challenge, rpId: where.rpId, userVerification: "preferred", allowCredentials: [], timeout: CHALLENGE_MS });
      }
      case "/auth/signin": {
        const credential = body as unknown as CredentialJSON;
        const challenge = clientChallenge(credential);
        if (!(await take(challenge, "signin"))) return json({ error: "That sign-in has expired; try again" }, 400);
        const stored = typeof credential.id === "string" && ID.test(credential.id) ? await read<Credential>(await credentialPath(credential.id)) : null;
        const user = stored ? await read<User>(`users/${stored.user}.json`) : null;
        if (!stored || !user) return json({ error: "This site doesn't know that passkey" }, 401);
        // A passkey names its account; it must be the one we registered it for.
        if (credential.response?.userHandle && credential.response.userHandle !== user.id) return json({ error: "That passkey is for another account" }, 401);
        try {
          const { counter } = await verifyAssertion(credential, stored.key, stored.counter, { challenge: challenge!, ...where });
          await write(await credentialPath(stored.id), { ...stored, counter });
        } catch (error) {
          return json({ error: String((error as Error).message ?? error) }, 401);
        }
        return signIn(request, user);
      }
      case "/auth/keys": {
        const current = await session(request);
        if (!current) return json({ error: "Not signed in" }, 401);
        const made = await keys.make(current.user.id, String(body.space ?? ""), String(body.name ?? ""));
        return "error" in made ? json({ error: made.error }, made.status) : json(made);
      }
      case "/auth/keys/revoke": {
        const current = await session(request);
        if (!current) return json({ error: "Not signed in" }, 401);
        return (await keys.revoke(current.user.id, String(body.id ?? ""))) ? json({ ok: true }) : json({ error: "You have no key by that id" }, 404);
      }
      case "/auth/me/email": {
        const current = await session(request);
        if (!current) return json({ error: "Not signed in" }, 401);
        const email = typeof body.email === "string" ? body.email.trim() : null;
        if (email === null || (email && !isAddress(email))) return json({ error: "That isn't an email address" }, 400);
        const { email: _old, emailConfirmed: _confirmed, emailLink: _link, ...rest } = current.user;
        if (!email) {
          await write(`users/${rest.id}.json`, rest);
          return json({ user: rest });
        }
        // The same address, already confirmed: nothing to do.
        if (email === current.user.email && current.user.emailConfirmed) return json({ user: current.user });
        if (!hooks.mail) return json({ error: "This server can't send email, so it can't confirm an address" }, 503);
        const count = mailCount(current.user);
        if (count === null) return json({ error: `The accounts send you at most ${MAILS_PER_DAY} messages a day: try again tomorrow` }, 429);
        await sweep();
        const token = random(32);
        const linkHash = await hash(token);
        const updated: User = { ...rest, email, emailConfirmed: false, emailLink: linkHash, mailed: count };
        await write(`users/${rest.id}.json`, updated);
        await write(`email-links/${linkHash}.json`, { user: rest.id, email, expires: Date.now() + CONFIRM_MS });
        const host = url.host;
        const link = `${url.origin}/account/?confirm=${token}`;
        const sent = await hooks.mail({
          to: [email],
          subject: `Confirm your email for ${host}`,
          text: `Hello ${rest.name},\n\nTo let apps in your spaces on ${host} email you here, open this link within a day:\n\n${link}\n\nIf you didn't ask for this, someone typed your address on their account. Ignore this message and nothing more will come.`,
        });
        if (!sent) return json({ error: "This server keeps email in an outbox and doesn't send it yet, so it can't confirm an address" }, 503);
        if (!sent.ok) return json({ error: `The link couldn't be sent: ${sent.error}` }, 502);
        return json({ user: updated, sent: true });
      }
      case "/auth/me/email/confirm": {
        const token = typeof body.token === "string" ? body.token : "";
        if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return json({ error: "That link isn't right" }, 400);
        const linkHash = await hash(token);
        const path = `email-links/${linkHash}.json`;
        const found = await read<{ user: string; email: string; expires: number }>(path);
        if (!found) return json({ error: "That link has been used, or isn't right" }, 400);
        await files.remove(path);
        const user = await read<User>(`users/${found.user}.json`);
        // Only the last link mailed counts: one from before the address was changed or removed confirms nothing.
        if (found.expires < Date.now() || !user || user.email !== found.email || user.emailLink !== linkHash) return json({ error: "That link is out of date: save your address again for a new one" }, 400);
        const { emailLink: _used, ...confirmed } = user;
        await write(`users/${user.id}.json`, { ...confirmed, emailConfirmed: true });
        return json({ ok: true, email: user.email });
      }
      case "/auth/me/email/test": {
        const current = await session(request);
        if (!current) return json({ error: "Not signed in" }, 401);
        const { user } = current;
        if (!user.email) return json({ error: "Save an email address first" }, 400);
        if (!user.emailConfirmed) return json({ error: "Confirm your address first: open the link mailed to it" }, 400);
        if (!hooks.mail) return json({ error: "This server can't send email" }, 503);
        const count = mailCount(user);
        if (count === null) return json({ error: `The accounts send you at most ${MAILS_PER_DAY} messages a day: try again tomorrow` }, 429);
        await write(`users/${user.id}.json`, { ...user, mailed: count });
        const host = url.host;
        const result = await hooks.mail({ to: [user.email], subject: `A test message from ${host}`, text: `Hello ${user.name},\n\nYou asked ${host} to send you a test message, and here it is: apps in your spaces can reach you at this address.` });
        if (!result) return json({ error: "This server keeps email in an outbox and doesn't send it yet" }, 503);
        if (!result.ok) return json({ error: `The message couldn't be sent: ${result.error}` }, 502);
        return json({ ok: true, id: result.id });
      }
      case "/auth/signout": {
        const current = await session(request);
        if (current) await files.remove(`sessions/${current.key}.json`);
        return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
    }
    return undefined;
  }
}

/** Plain OAuth 2: trade the code for a token, then ask the provider's user API who it belongs to. */
async function whoAt(provider: OAuthProvider, code: string, back: string, verifier: string): Promise<{ id: string; name: string }> {
  const tokenAnswer = await fetch(provider.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: back, client_id: provider.clientId, client_secret: provider.clientSecret, code_verifier: verifier }),
  });
  const { access_token } = (await tokenAnswer.json()) as { access_token?: string };
  if (!access_token) throw new Error("no token");
  const who = await fetch(provider.user, { headers: { accept: "application/json", authorization: `Bearer ${access_token}`, "user-agent": "extensible-web-apps" } });
  if (!who.ok) throw new Error(`user ${who.status}`);
  const profile = (await who.json()) as Record<string, unknown>;
  return { id: provider.id_(profile), name: provider.name_(profile) };
}

/** What to tell the person when a sign-in step fails: a flow's own words, else a plain fallback. */
const messageOf = (error: unknown, fallback: string, own = true) =>
  own && error instanceof Error && error.name === "Error" && error.message ? error.message.slice(0, 200) : fallback;

/** Where a passkey is kept: by a hash of its id, which can be up to 1023 bytes, too long for a file's name. */
const credentialPath = async (id: string) => `credentials/${await hash(id)}.json`;

/** The challenge a credential's client data answers, read before it's checked, to find its record. */
function clientChallenge(credential: CredentialJSON): string | undefined {
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64url(credential.response.clientDataJSON))) as { challenge?: unknown };
    return typeof data.challenge === "string" ? data.challenge : undefined;
  } catch {
    return undefined;
  }
}
