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
 * One that is missing a part is left out, with a warning.
 */
export function providersFrom(env: Record<string, unknown>, modules: Record<string, ProviderModule>): Provider[] {
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
    const module = Object.hasOwn(modules, id) ? modules[id] : undefined;
    if (module && "flow" in module) {
      out.push(module.flow(entry));
      continue;
    }
    const secret = env[`${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`];
    const preset = (module && "preset" in module ? module.preset : undefined) ?? (entry.authorize && entry.token && entry.user ? plain(entry) : undefined);
    if (!/^[a-z0-9-]{1,32}$/.test(id) || !preset || !entry.clientId || typeof secret !== "string") {
      console.warn(`Sign-in provider ${id || "(no id)"} is missing a part, so it's off`);
      continue;
    }
    out.push({ ...preset, ...(entry.name ? { name: String(entry.name) } : {}), id, clientId: String(entry.clientId), clientSecret: secret });
  }
  return out;
}
