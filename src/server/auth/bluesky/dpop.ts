// DPoP (RFC 9449): each request to a Bluesky sign-in server carries a proof,
// a small JWT signed with a key this server made for that one sign-in. The
// server binds the tokens it hands out to that key, so a token copied off the
// wire is no use to anyone without it.
//
// The key is an ES256 (P-256) key, the one algorithm every atproto server
// supports. It's kept, as a JWK, with the sign-in's other state for the few
// minutes the sign-in takes, then thrown away with it.

import { b64url } from "../webauthn.ts";

/** An EC key as a JWK: the public point (x, y), and with `d`, the private part. */
export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
}

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const text = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** A new key for one sign-in, as the private JWK to keep with it. */
export async function newKey(): Promise<Jwk> {
  const pair = (await crypto.subtle.generateKey(ES256, true, ["sign", "verify"])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  return { kty, crv, x, y, d };
}

/**
 * A proof for one request: its method and URL (without a query or fragment), and the server's
 * latest nonce, if it has given one. Each proof has an id of its own, so the server can refuse a replay.
 */
export async function proof(key: Jwk, method: string, url: string, nonce?: string): Promise<string> {
  const { kty, crv, x, y } = key;
  const target = new URL(url);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } };
  const claims = {
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
    htm: method,
    htu: `${target.origin}${target.pathname}`,
    iat: Math.floor(Date.now() / 1000),
    ...(nonce ? { nonce } : {}),
  };
  const signing = `${text(header)}.${text(claims)}`;
  const privateKey = await crypto.subtle.importKey("jwk", key, ES256, false, ["sign"]);
  // WebCrypto signs ECDSA as r‖s, which is what a JWS wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(signing));
  return `${signing}.${b64url(new Uint8Array(signature))}`;
}

/**
 * A form POST with a DPoP proof. A server that wants a nonce first says so (400 or 401,
 * `use_dpop_nonce`, with the nonce in a DPoP-Nonce header); this asks once more with it.
 * Gives the answer and the server's latest nonce, for the next request to the same server.
 */
export async function post(key: Jwk, url: string, form: Record<string, string>, nonce: string | undefined, send: typeof fetch) {
  let answer: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    answer = await send(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", dpop: await proof(key, "POST", url, nonce) },
      body: new URLSearchParams(form),
    });
    const given = answer.headers.get("dpop-nonce") ?? undefined;
    const retry = (answer.status === 400 || answer.status === 401) && given && given !== nonce && (await wantsNonce(answer.clone()));
    nonce = given ?? nonce;
    if (!retry) break;
  }
  return { answer: answer!, nonce };
}

const wantsNonce = async (answer: Response) => {
  if (/use_dpop_nonce/.test(answer.headers.get("www-authenticate") ?? "")) return true;
  const body = (await answer.json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "use_dpop_nonce";
};
