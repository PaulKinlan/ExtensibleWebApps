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
}

const COOKIE = "ewa-session";
const SESSION_MS = 30 * 24 * 3600_000;
const CHALLENGE_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,512}$/;

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const hash = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** The routes, for a host to call with each request under /auth/. */
export function accounts(files: Files) {
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

  /** Clears challenges and sessions that have run out, so they don't pile up. */
  const sweep = async () => {
    for (const path of [...(await files.list("challenges/")), ...(await files.list("sessions/"))]) {
      const found = await read<{ expires: number }>(path);
      if (!found || found.expires < Date.now()) await files.remove(path);
    }
  };

  /** A person's passkeys. */
  const credentials = async (user: string): Promise<Credential[]> => {
    const all = await Promise.all((await files.list("credentials/")).map((path) => read<Credential>(path)));
    return all.filter((c): c is Credential => c?.user === user);
  };

  return {
    credentials,

    /** Answers a request under /auth/, or gives undefined for one that isn't a route. */
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const where = { origin: url.origin, rpId: url.hostname };

      if (route === "GET /auth/me") {
        const current = await session(request);
        return current ? json({ user: current.user }) : json({ error: "Not signed in" }, 401);
      }
      if (request.method !== "POST" || !url.pathname.startsWith("/auth/")) return undefined;
      // Only this site's own pages may sign in or out (a form on another site can't).
      if (request.headers.get("origin") !== url.origin) return json({ error: "Not from this site" }, 403);
      let body: Record<string, unknown> = {};
      try {
        const text = await request.text();
        if (text.length > 64 * 1024) return json({ error: "Too big" }, 413);
        if (text) body = JSON.parse(text);
      } catch {
        return json({ error: "JSON only" }, 400);
      }

      switch (url.pathname) {
        case "/auth/register/options": {
          const current = await session(request);
          const name = current?.user.name ?? String(body.name ?? "").trim().slice(0, 64);
          if (!name) return json({ error: "A name, please" }, 400);
          const user = current?.user.id ?? random(16);
          const challenge = random(32);
          await sweep();
          await write(`challenges/${challenge}.json`, { kind: "register", expires: Date.now() + CHALLENGE_MS, user, name } satisfies Challenge);
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
          let made;
          try {
            made = await verifyRegistration(credential, { challenge: challenge!, ...where });
          } catch (error) {
            return json({ error: String((error as Error).message ?? error) }, 400);
          }
          if (await files.readText(`credentials/${made.id}.json`)) return json({ error: "That passkey is already registered" }, 409);
          const user = (await read<User>(`users/${found.user}.json`)) ?? { id: found.user, name: found.name, created: Date.now() };
          await write(`users/${user.id}.json`, user);
          await write(`credentials/${made.id}.json`, { id: made.id, user: user.id, key: made.key, counter: made.counter, created: Date.now() } satisfies Credential);
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
          const stored = typeof credential.id === "string" && ID.test(credential.id) ? await read<Credential>(`credentials/${credential.id}.json`) : null;
          const user = stored ? await read<User>(`users/${stored.user}.json`) : null;
          if (!stored || !user) return json({ error: "This site doesn't know that passkey" }, 401);
          // A passkey names its account; it must be the one we registered it for.
          if (credential.response?.userHandle && credential.response.userHandle !== user.id) return json({ error: "That passkey is for another account" }, 401);
          try {
            const { counter } = await verifyAssertion(credential, stored.key, stored.counter, { challenge: challenge!, ...where });
            await write(`credentials/${stored.id}.json`, { ...stored, counter });
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
    },

    /** Who a request is signed in as, for a host to ask when a client joins a space. */
    async user(request: Request): Promise<User | null> {
      return (await session(request))?.user ?? null;
    },
  };
}

/** The challenge a credential's client data answers, read before it's checked, to find its record. */
function clientChallenge(credential: CredentialJSON): string | undefined {
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64url(credential.response.clientDataJSON))) as { challenge?: unknown };
    return typeof data.challenge === "string" ? data.challenge : undefined;
  } catch {
    return undefined;
  }
}
