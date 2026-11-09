// Signing in with another site's account (OAuth 2), as configuration: a
// provider is a few URLs and how to read a person's id and name from its
// answer. A provider that speaks plain OAuth 2 is one entry in the host's
// configuration, with no code.
//
// A provider that needs code of its own is a provider module, a file or
// folder in providers/, listed once in providers/index.ts, which each host
// passes to providersFrom. So the accounts never name a provider, and a
// site that leaves one out of the list doesn't build it in:
//   providers/github.ts     GitHub, as a preset of plain OAuth 2
//   providers/bluesky/      Bluesky (atproto), a flow with steps of its own
//
// A host turns providers on from its environment (Node's process.env, or a
// Worker's vars and secrets):
//   AUTH_PROVIDERS        JSON: [{ "id": "github", "clientId": "Iv1..." }], or for one with no preset,
//                         { "id": "...", "clientId": "...", "authorize": url, "token": url, "user": url, "scope": "...", "name": "..." }
//   <ID>_CLIENT_SECRET    each provider's secret (GITHUB_CLIENT_SECRET), kept as a secret, never in the JSON
//
// Bluesky (atproto) signs in with OAuth too, but its own way (a client
// metadata URL, PAR, DPoP, and checking the account's DID), so it's a Flow:
// a module with its own steps. It's turned on the same way, with
// { "id": "bluesky" } in AUTH_PROVIDERS, and needs no client id or secret.

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

/** Plain OAuth 2 with its URLs filled in: a provider module that needs only a client id and secret (providers/github.ts). */
export type Preset = Omit<OAuthProvider, "id" | "clientId" | "clientSecret">;

/** A provider module: a preset of plain OAuth 2, or what makes a flow from its AUTH_PROVIDERS entry. */
export type ProviderModule = { preset: Preset } | { flow: (entry: Record<string, unknown>) => Flow };

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

/**
 * The providers a host's environment turns on, from the provider modules the host builds in (providers/index.ts).
 * A configuration that is wrong stops the server from starting, naming each entry that is: AUTH_PROVIDERS
 * that isn't a JSON list, an entry that isn't an object, an id this host has no module for and no URLs,
 * or one missing its client id or secret. Nothing is quietly left out.
 */
export function providersFrom(env: Record<string, unknown>, modules: Record<string, ProviderModule>): Provider[] {
  const raw = env.AUTH_PROVIDERS;
  if (raw === undefined || raw === "") return [];
  let entries: unknown;
  try {
    entries = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("AUTH_PROVIDERS isn't JSON");
  }
  if (!Array.isArray(entries)) throw new Error("AUTH_PROVIDERS is a JSON list of providers");
  const out: Provider[] = [];
  const wrong: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry: unknown, n) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void wrong.push(`entry ${n + 1} isn't an object`);
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    if (!/^[a-z0-9-]{1,32}$/.test(id)) return void wrong.push(`entry ${n + 1} has no id of a-z, 0-9 and -`);
    if (seen.has(id)) return void wrong.push(`${id} is listed twice`);
    seen.add(id);
    const module = Object.hasOwn(modules, id) ? modules[id] : undefined;
    if (module && "flow" in module) return void out.push(module.flow(e));
    const preset = module && "preset" in module ? module.preset : e.authorize && e.token && e.user ? plain(e) : undefined;
    const secretName = `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`;
    const secret = env[secretName];
    const missing = [!preset && "a provider module on this host, or authorize, token and user URLs", !e.clientId && "clientId", (typeof secret !== "string" || !secret) && `the secret ${secretName}`].filter(Boolean);
    if (missing.length) return void wrong.push(`${id} needs ${missing.join(", ")}`);
    out.push({ ...preset!, ...(e.name ? { name: String(e.name) } : {}), id, clientId: String(e.clientId), clientSecret: secret as string });
  });
  if (wrong.length) throw new Error(`Sign-in providers (AUTH_PROVIDERS) are set up wrong: ${wrong.join("; ")}`);
  return out;
}
