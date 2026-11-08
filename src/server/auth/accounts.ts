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
// A host lets a client join a space's kernel only if `member()` says it's in it.
//
// A session is a random token in an HttpOnly cookie; the server keeps only its
// hash, so its files can't be used to sign in.

import type { Files } from "../../seams/index.ts";
import { ALGORITHMS, b64url, unb64url, type CredentialJSON, type PublicKey, verifyAssertion, verifyRegistration } from "./webauthn.ts";

export interface User {
  id: string;
  name: string;
  created: number;
}

interface Credential {
  id: string;
  user: string;
  key: PublicKey;
  counter: number;
  created: number;
}

interface Challenge {
  kind: "register" | "signin";
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
const MAX_BODY = 64 * 1024;
const SWEEP_MS = 10 * 60_000;

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const hash = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** A request's body, read only up to `limit` bytes: null if it's longer. */
async function bodyOf(request: Request, limit: number): Promise<string | null> {
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
}

/** The routes, for a host to call with each request under /auth/. */
export function accounts(files: Files, hooks: Hooks = {}) {
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

  const signIn = async (request: Request, user: User): Promise<Response> => {
    const token = random(32);
    await write(`sessions/${await hash(token)}.json`, { user: user.id, expires: Date.now() + SESSION_MS });
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return json({ user }, 200, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}` });
  };

  /** Clears challenges and sessions that have run out, so they don't pile up: at most every ten minutes. */
  let swept = 0;
  const sweep = async () => {
    if (Date.now() - swept < SWEEP_MS) return;
    swept = Date.now();
    for (const path of [...(await files.list("challenges/")), ...(await files.list("sessions/")), ...(await files.list("invites/"))]) {
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

  const join = async (space: Space, user: string, role: Role) => {
    space.members[user] = role;
    await write(`spaces/${space.name}.json`, space);
    await write(`memberships/${user}/${space.name}.json`, { role });
  };

  const leave = async (space: Space, user: string) => {
    delete space.members[user];
    await write(`spaces/${space.name}.json`, space);
    await files.remove(`memberships/${user}/${space.name}.json`);
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

    /** Answers a request under /auth/, or gives undefined for one that isn't a route. */
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;

      if (route === "GET /auth/me") {
        const current = await session(request);
        return current ? json({ user: current.user }) : json({ error: "Not signed in" }, 401);
      }
      if (request.method === "GET" && url.pathname.startsWith("/auth/spaces")) return spaces(request, url.pathname, {});
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
      case "/auth/signout": {
        const current = await session(request);
        if (current) await files.remove(`sessions/${current.key}.json`);
        return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
    }
    return undefined;
  }
}

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
