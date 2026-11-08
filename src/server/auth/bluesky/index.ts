// Sign in with Bluesky: the AT Protocol's OAuth profile, as a sign-in "flow"
// that src/server/auth/accounts.ts runs at /auth/oauth/bluesky/… in place of
// plain OAuth 2. It differs from GitHub's sign-in in four ways:
//
// 1. There's no app to register. This server's client id is a URL, where it
//    publishes what it is (/auth/oauth/bluesky/client-metadata.json), and the
//    person's server fetches that. On http://127.0.0.1 (development) it's the
//    "loopback" client id atproto keeps for that, so it works with no setup.
// 2. There's no one server. The person types their handle, and this finds
//    which server signs them in (resolve.ts).
// 3. The request goes to that server first, by a back channel (PAR), and
//    every request carries a DPoP proof (dpop.ts).
// 4. The token says which account signed in (its DID, in `sub`), and that's
//    only believed if the DID's own document points at the server that said
//    so. Otherwise any server could claim to be anyone.
//
// Then it's like any other site: the DID is the identity (it never changes,
// even when the handle does), and the handle is the new account's name. The
// tokens are thrown away: this is sign-in only.
//
// Turned on in AUTH_PROVIDERS with { "id": "bluesky" }. Nothing else is
// needed; "name", "plc", "dns" and "resolver" (a server that answers
// com.atproto.identity.resolveHandle) may be set, and "insecure": true lets
// http:// servers through, for the server checks only.

import { guardedFetch } from "./guarded-fetch.ts";
import { checkedHandle, DID, issuerOf, resolveHandle, account, safeUrl, serverMeta, type Settings } from "./resolve.ts";
import { newKey, post, type Jwk } from "./dpop.ts";
import type { Flow } from "../providers.ts";

interface Kept {
  key: Jwk;
  issuer: string;
  token: string;
  nonce?: string;
  /** The account they said they are, if they typed a handle or a DID: the token must be for it. */
  did?: string;
  handle?: string;
}

const TIMEOUT = 10_000;

/** A JSON object's fields, or none if it isn't one. */
const parsed = <T extends object>(text: string): Partial<T> => {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as T) : {};
  } catch {
    return {};
  }
};

export function bluesky(entry: Record<string, unknown>): Flow {
  const settings: Settings = {
    plc: String(entry.plc ?? "https://plc.directory").replace(/\/$/, ""),
    dns: String(entry.dns ?? "https://cloudflare-dns.com/dns-query"),
    resolver: typeof entry.resolver === "string" ? entry.resolver.replace(/\/$/, "") : undefined,
    insecure: entry.insecure === true,
    // On Node, a fetch that won't connect to a private address, whatever a name resolves to.
    fetch: (url, init) => (entry.insecure === true ? fetch : guardedFetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }),
  };
  if (settings.insecure) console.warn("Bluesky sign-in is insecure (it asks http:// servers): for the server checks only");
  const id = "bluesky";

  /** This server's client id: a URL saying what it is, or on 127.0.0.1, atproto's loopback client. */
  const clientId = (url: URL, back: string) => {
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")) return `http://localhost?redirect_uri=${encodeURIComponent(back)}&scope=atproto`;
    if (url.protocol === "https:") return `${url.origin}/auth/oauth/${id}/client-metadata.json`;
    throw new Error("Bluesky sign-in needs this site on HTTPS (or, to try it out, at http://127.0.0.1)");
  };

  return {
    id,
    name: String(entry.name ?? "Bluesky"),
    ask: { name: "handle", label: "Your Bluesky handle", placeholder: "you.bsky.social" },

    async start({ url, back, state, challenge }) {
      // The loopback client must come back to 127.0.0.1, so its cookie must be set there.
      if (url.hostname === "localhost" && url.protocol === "http:") {
        const there = new URL(url);
        there.hostname = "127.0.0.1";
        return { location: there.href };
      }
      const client = clientId(url, back);
      const typed = (url.searchParams.get("handle") ?? "").trim().replace(/^@/, "");
      if (!typed) throw new Error("Type your Bluesky handle, such as you.bsky.social");

      let issuer: string;
      let kept: Pick<Kept, "did" | "handle"> = {};
      if (/^https?:\/\//.test(typed)) {
        // A server (bsky.social, or someone's own PDS): it says who signs its people in, or does itself.
        const server = safeUrl(typed, settings).origin;
        issuer = await issuerOf(server, settings).catch(() => server);
      } else {
        const did = typed.startsWith("did:") ? typed : await resolveHandle(typed.toLowerCase(), settings);
        const found = await account(did, settings);
        // A handle is theirs only if their DID's document names it too.
        if (!typed.startsWith("did:") && found.handle !== typed.toLowerCase()) throw new Error(`${typed}'s account doesn't name that handle`);
        issuer = await issuerOf(found.pds, settings);
        kept = { did, handle: typed.startsWith("did:") ? await checkedHandle(found, settings) : found.handle };
      }
      const meta = await serverMeta(issuer, settings);

      // Ask by the back channel; the answer is a reference to send the browser with.
      const key = await newKey();
      const form: Record<string, string> = { client_id: client, redirect_uri: back, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state, scope: "atproto" };
      if (kept.handle ?? kept.did) form.login_hint = (kept.handle ?? kept.did)!;
      const answer = await post(key, meta.pushed_authorization_request_endpoint, form, undefined, settings.fetch);
      const { request_uri } = parsed<{ request_uri?: unknown }>(answer.text);
      if (!answer.ok || typeof request_uri !== "string") throw new Error(`${new URL(issuer).host} wouldn't start a sign-in (${answer.status})`);

      const to = new URL(meta.authorization_endpoint);
      to.searchParams.set("client_id", client);
      to.searchParams.set("request_uri", request_uri);
      return { location: to.href, data: { key, issuer, token: meta.token_endpoint, nonce: answer.nonce, ...kept } satisfies Kept };
    },

    async finish({ url, back, data, verifier }) {
      const kept = data as unknown as Kept;
      // The answer must come from the server this sign-in went to (RFC 9207), not one pretending.
      if (url.searchParams.get("iss") !== kept.issuer) throw new Error("That answer came from another server");
      const code = url.searchParams.get("code") ?? "";
      const answer = await post(kept.key, kept.token, { grant_type: "authorization_code", code, redirect_uri: back, code_verifier: verifier, client_id: clientId(url, back) }, kept.nonce, settings.fetch);
      const tokens = parsed<{ sub?: unknown; scope?: unknown; token_type?: unknown }>(answer.text);
      const sub = typeof tokens.sub === "string" && DID.test(tokens.sub) ? tokens.sub : null;
      if (!answer.ok || !sub || String(tokens.token_type).toLowerCase() !== "dpop" || !String(tokens.scope ?? "").split(" ").includes("atproto")) {
        throw new Error("Bluesky didn't say who you are");
      }

      // Believe the account only if it's the one asked for, or its own document names this server.
      if (kept.did) {
        if (sub !== kept.did) throw new Error("Bluesky signed in another account than the one you typed");
        return { id: sub, name: kept.handle ?? sub };
      }
      const found = await account(sub, settings);
      if ((await issuerOf(found.pds, settings)) !== kept.issuer) throw new Error("That server can't sign in that account");
      return { id: sub, name: (await checkedHandle(found, settings)) ?? sub };
    },

    /** What this server is, for the person's server to read: atproto's client metadata. */
    serve(url, step) {
      if (step !== "client-metadata.json" || url.protocol !== "https:") return undefined;
      const back = `${url.origin}/auth/oauth/${id}/callback`;
      return new Response(
        JSON.stringify({
          client_id: clientId(url, back),
          client_name: "Extensible Web Apps",
          client_uri: url.origin,
          redirect_uris: [back],
          scope: "atproto",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          application_type: "web",
          token_endpoint_auth_method: "none",
          dpop_bound_access_tokens: true,
        }),
        { headers: { "content-type": "application/json", "cache-control": "max-age=300" } },
      );
    },
  };
}
