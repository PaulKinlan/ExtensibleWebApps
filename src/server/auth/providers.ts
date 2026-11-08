// Signing in with another site's account (OAuth 2), as configuration: a
// provider is a few URLs and how to read a person's id and name from its
// answer. GitHub is a preset; another provider that speaks plain OAuth 2 is
// one more entry, in code here or in the host's configuration.
//
// A host turns providers on from its environment (Node's process.env, or a
// Worker's vars and secrets):
//   AUTH_PROVIDERS        JSON: [{ "id": "github", "clientId": "Iv1..." }], or for one with no preset,
//                         { "id": "...", "clientId": "...", "authorize": url, "token": url, "user": url, "scope": "...", "name": "..." }
//   <ID>_CLIENT_SECRET    each provider's secret (GITHUB_CLIENT_SECRET), kept as a secret, never in the JSON
//
// Bluesky (atproto) signs in with OAuth too, but its own way (a client
// metadata URL, PAR, DPoP, and checking the account's DID), so it's a Flow:
// a module with its own steps, in bluesky/. It's turned on the same way, with
// { "id": "bluesky" } in AUTH_PROVIDERS, and needs no client id or secret.

import { bluesky } from "./bluesky/index.ts";

/** Another site to sign in with: plain OAuth 2, or a flow with steps of its own. */
export type Provider = OAuthProvider | Flow;

export interface OAuthProvider {
  id: string;
  /** What the sign-in button says: "Sign in with GitHub". */
  name: string;
  clientId: string;
  clientSecret: string;
  authorize: string;
  token: string;
  /** The API that answers who the token belongs to, as JSON. */
  user: string;
  scope: string;
  /** From that answer: the person's id at the provider (which never changes), and their name. */
  id_: (profile: Record<string, unknown>) => string;
  name_: (profile: Record<string, unknown>) => string;
}

/**
 * A sign-in with its own steps, which accounts.ts runs at /auth/oauth/<id>/… in place of plain
 * OAuth 2. It keeps the parts every sign-in shares: the state cookie, the PKCE verifier, linking,
 * invites, and finding or making the account. A step throws an Error whose message the person sees.
 */
export interface Flow {
  id: string;
  name: string;
  /** What the person types to start, sent to `start` as a query parameter: a field beside the button. */
  ask?: { name: string; label: string; placeholder: string };
  /** Where to send the browser, and what to keep until it comes back (kept for minutes, on the server). */
  start(step: { url: URL; back: string; state: string; challenge: string }): Promise<{ location: string; data?: Record<string, unknown> }>;
  /** The callback's query, checked: who signed in, by an id at that site that never changes. */
  finish(step: { url: URL; back: string; data: Record<string, unknown>; verifier: string }): Promise<{ id: string; name: string }>;
  /** Any other GET at /auth/oauth/<id>/<step>, such as a document the other site reads. */
  serve?(url: URL, step: string): Response | undefined;
}

export const isFlow = (provider: Provider): provider is Flow => "finish" in provider;

type Preset = Omit<OAuthProvider, "id" | "clientId" | "clientSecret">;

const PRESETS: Record<string, Preset> = {
  github: {
    name: "GitHub",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    // No scope: only the public profile, which is all sign-in needs.
    scope: "",
    id_: (p) => String(p.id),
    name_: (p) => String(p.name || p.login || "GitHub user"),
  },
};

/** A provider with no preset: plain OAuth 2, whose user API answers with `id` (or `sub`) and `name`. */
const plain = (entry: Record<string, unknown>): Preset => ({
  name: String(entry.name ?? entry.id),
  authorize: String(entry.authorize),
  token: String(entry.token),
  user: String(entry.user),
  scope: String(entry.scope ?? ""),
  id_: (p) => String(p.id ?? p.sub),
  name_: (p) => String(p.name ?? p.login ?? p.preferred_username ?? "Someone"),
});

/** The providers a host's environment turns on. One that is missing a part is left out, with a warning. */
export function providersFrom(env: Record<string, unknown>): Provider[] {
  let entries: Record<string, unknown>[] = [];
  try {
    entries = typeof env.AUTH_PROVIDERS === "string" && env.AUTH_PROVIDERS ? JSON.parse(env.AUTH_PROVIDERS) : [];
  } catch {
    console.warn("AUTH_PROVIDERS isn't JSON; no providers are on");
  }
  const out: Provider[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      console.warn("An AUTH_PROVIDERS entry isn't an object, so it's skipped");
      continue;
    }
    const id = String(entry.id ?? "");
    if (id === "bluesky") {
      out.push(bluesky(entry));
      continue;
    }
    const secret = env[`${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`];
    const preset = (Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined) ?? (entry.authorize && entry.token && entry.user ? plain(entry) : undefined);
    if (!/^[a-z0-9-]{1,32}$/.test(id) || !preset || !entry.clientId || typeof secret !== "string") {
      console.warn(`Sign-in provider ${id || "(no id)"} is missing a part, so it's off`);
      continue;
    }
    out.push({ ...preset, ...(entry.name ? { name: String(entry.name) } : {}), id, clientId: String(entry.clientId), clientSecret: secret });
  }
  return out;
}
