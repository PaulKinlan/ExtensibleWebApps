// A passkey authenticator in software, for the server checks: it makes and
// uses passkeys as a browser and a phone would, answering the server's JSON
// options with `credential.toJSON()`'s shape. ES256 by default; EdDSA and
// RS256 too, to check every algorithm the server accepts.

import { createHash, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64url = (text) => new Uint8Array(Buffer.from(text, "base64url"));
const sha256 = (data) => new Uint8Array(createHash("sha256").update(data).digest());

/** CBOR for what an authenticator writes: maps, byte and text strings, small integers. */
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  if (typeof value === "number") return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (typeof value === "string") {
    const b = new TextEncoder().encode(value);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (value instanceof Uint8Array) return new Uint8Array([...head(2, value.length), ...value]);
  if (value instanceof Map) {
    const parts = [new Uint8Array(head(5, value.size))];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error(`Can't encode ${value}`);
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

const ALGS = {
  ES256: { cose: -7, gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
  EdDSA: { cose: -8, gen: { name: "Ed25519" }, sign: { name: "Ed25519" } },
  RS256: { cose: -257, gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
};

/** WebCrypto's ECDSA signature (r and s side by side) as the DER an authenticator sends. */
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([2, b.length]), b);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function coseKey(alg, publicKey) {
  const jwk = await subtle.exportKey("jwk", publicKey);
  if (alg === "ES256") return new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x)], [-3, unb64url(jwk.y)]]);
  if (alg === "EdDSA") return new Map([[1, 1], [3, -8], [-1, 6], [-2, unb64url(jwk.x)]]);
  return new Map([[1, 3], [3, -257], [-1, unb64url(jwk.n)], [-2, unb64url(jwk.e)]]);
}

const authData = (rpId, flags, counter, attested) => {
  const c = new Uint8Array(4);
  new DataView(c.buffer).setUint32(0, counter);
  return concat(sha256(rpId), new Uint8Array([flags]), c, attested ?? new Uint8Array());
};

/** An authenticator holding passkeys; `create` and `get` answer the server's options for `origin`. */
export function authenticator({ alg = "ES256", counting = true } = {}) {
  const keys = new Map();
  let counter = 0;
  return {
    keys,
    async create(options, origin, { rpId = options.rp.id, challenge = options.challenge, type = "webauthn.create" } = {}) {
      const pair = await subtle.generateKey(ALGS[alg].gen, true, ["sign", "verify"]);
      const id = webcrypto.getRandomValues(new Uint8Array(16));
      keys.set(b64url(id), { pair, user: options.user.id, rpId });
      const len = new Uint8Array([id.length >> 8, id.length & 255]);
      const attested = concat(new Uint8Array(16), len, id, cbor(await coseKey(alg, pair.publicKey)));
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(rpId, 0x45, counting ? ++counter : 0, attested)]]));
      return { id: b64url(id), rawId: b64url(id), type: "public-key", response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] }, clientExtensionResults: {}, authenticatorAttachment: "platform" };
    },
    async get(options, origin, { id = [...keys.keys()][0], rpId = options.rpId, challenge = options.challenge, counterOverride } = {}) {
      const key = keys.get(id);
      const data = authData(rpId, 0x05, counterOverride ?? (counting ? ++counter : 0));
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      let signature = new Uint8Array(await subtle.sign(ALGS[alg].sign, key.pair.privateKey, concat(data, sha256(clientDataJSON))));
      if (alg === "ES256") signature = rawToDer(signature);
      return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(data), signature: b64url(signature), userHandle: key.user }, clientExtensionResults: {}, authenticatorAttachment: "platform" };
    },
  };
}
