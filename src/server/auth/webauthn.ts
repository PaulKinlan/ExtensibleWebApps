// Passkeys (WebAuthn), checked on the server with WebCrypto alone, so the same
// code runs on Node and in a Cloudflare Worker with no dependency. The browser
// and the server speak WebAuthn's JSON form: the server sends options as JSON
// (`PublicKeyCredential.parseCreationOptionsFromJSON` reads them), and the
// browser sends back `credential.toJSON()`, with bytes as base64url.
//
// What a passkey proves: the person holds the private key for a credential
// this site registered. We ask for no attestation (which would say who made
// the authenticator), so a registration is checked for its challenge, origin
// and site, and its public key is kept; a sign-in is checked by its signature.

/** Bytes as base64url, as WebAuthn's JSON form writes them. */
export const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function unb64url(text: string): Uint8Array {
  const b = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** The bytes WebCrypto takes, copied into an ArrayBuffer of their own. */
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(data)));

/** Reads one CBOR item (the subset WebAuthn uses), giving it and where the next item starts. */
export function cbor(bytes: Uint8Array, at = 0): { value: unknown; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = bytes[at];
  if (head === undefined) throw new Error("CBOR ends early");
  const major = head >> 5;
  const info = head & 31;
  let n: number;
  let next = at + 1;
  if (info < 24) n = info;
  else if (info === 24) (n = bytes[next]), (next += 1);
  else if (info === 25) (n = view.getUint16(next)), (next += 2);
  else if (info === 26) (n = view.getUint32(next)), (next += 4);
  else if (info === 27) (n = Number(view.getBigUint64(next))), (next += 8);
  else throw new Error("CBOR length not supported");
  switch (major) {
    case 0:
      return { value: n, end: next };
    case 1:
      return { value: -1 - n, end: next };
    case 2:
    case 3: {
      if (next + n > bytes.length) throw new Error("CBOR ends early");
      const slice = bytes.subarray(next, next + n);
      return { value: major === 2 ? slice : new TextDecoder().decode(slice), end: next + n };
    }
    case 4: {
      const list: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const item = cbor(bytes, next);
        list.push(item.value);
        next = item.end;
      }
      return { value: list, end: next };
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const key = cbor(bytes, next);
        const item = cbor(bytes, key.end);
        map.set(key.value, item.value);
        next = item.end;
      }
      return { value: map, end: next };
    }
    case 7:
      if (info === 20) return { value: false, end: next };
      if (info === 21) return { value: true, end: next };
      if (info === 22) return { value: null, end: next };
  }
  throw new Error("CBOR item not supported");
}

/** The algorithms a passkey may use, as COSE numbers: ES256, EdDSA (Ed25519), RS256. */
export const ALGORITHMS = [-7, -8, -257];

/** A credential's public key, as a JWK WebCrypto can import, with its COSE algorithm. */
export interface PublicKey {
  alg: number;
  jwk: { kty: string; [part: string]: string };
}

function coseToJwk(key: Map<unknown, unknown>): PublicKey {
  const alg = key.get(3);
  const bytes = (label: number) => {
    const v = key.get(label);
    if (!(v instanceof Uint8Array)) throw new Error("The key is missing a part");
    return b64url(v);
  };
  if (alg === -7 && key.get(1) === 2 && key.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) } };
  if (alg === -8 && key.get(1) === 1 && key.get(-1) === 6) return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2) } };
  if (alg === -257 && key.get(1) === 3) return { alg, jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2), alg: "RS256" } };
  throw new Error(`Algorithm ${String(alg)} isn't one this site accepts`);
}

/** An ECDSA signature arrives DER-encoded; WebCrypto wants r and s side by side, 32 bytes each. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("Not a DER signature");
  let at = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const part = () => {
    if (der[at] !== 0x02) throw new Error("Not a DER signature");
    const length = der[at + 1];
    let value = der.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error("Not a P-256 signature");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

export async function verifySignature(key: PublicKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const [importAlg, verifyAlg, sig] =
    key.alg === -7
      ? [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }, derToRaw(signature)]
      : key.alg === -8
        ? [{ name: "Ed25519" }, { name: "Ed25519" }, signature]
        : [{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }, signature];
  const imported = await crypto.subtle.importKey("jwk", key.jwk as never, importAlg, false, ["verify"]);
  return crypto.subtle.verify(verifyAlg, imported, buffer(sig), buffer(data));
}

/** What the authenticator says about a ceremony: which site, whether the person was there, its counter. */
interface AuthData {
  rpIdHash: Uint8Array;
  present: boolean;
  verified: boolean;
  counter: number;
  credential?: { id: Uint8Array; key: PublicKey };
}

function authData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new Error("Authenticator data is too short");
  const flags = bytes[32];
  const data: AuthData = {
    rpIdHash: bytes.subarray(0, 32),
    present: !!(flags & 0x01),
    verified: !!(flags & 0x04),
    counter: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0),
  };
  if (flags & 0x40) {
    const length = (bytes[53] << 8) | bytes[54];
    const id = bytes.subarray(55, 55 + length);
    const key = cbor(bytes, 55 + length).value;
    if (!(key instanceof Map)) throw new Error("The credential has no key");
    data.credential = { id, key: coseToJwk(key) };
  }
  return data;
}

/** The parts of `credential.toJSON()` this reads. */
export interface CredentialJSON {
  id: string;
  rawId?: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    userHandle?: string | null;
  };
}

/** Where a ceremony must have happened: this page's origin, for this site (its host name). */
export interface Expect {
  challenge: string;
  origin: string;
  rpId: string;
}

async function clientData(credential: CredentialJSON, type: string, expect: Expect): Promise<Uint8Array> {
  const raw = unb64url(credential.response.clientDataJSON);
  const data = JSON.parse(new TextDecoder().decode(raw)) as { type?: string; challenge?: string; origin?: string };
  if (data.type !== type) throw new Error(`Expected ${type}`);
  if (data.challenge !== expect.challenge) throw new Error("The challenge doesn't match");
  if (data.origin !== expect.origin) throw new Error("The page was on another site");
  return raw;
}

async function sameSite(data: AuthData, rpId: string): Promise<void> {
  const want = await sha256(new TextEncoder().encode(rpId));
  if (want.some((b, i) => b !== data.rpIdHash[i])) throw new Error("The passkey is for another site");
  if (!data.present) throw new Error("No one was at the authenticator");
}

/** A new passkey: its id, public key and counter, once its registration checks out. */
export async function verifyRegistration(credential: CredentialJSON, expect: Expect): Promise<{ id: string; key: PublicKey; counter: number }> {
  if (credential.type !== "public-key" || !credential.response.attestationObject) throw new Error("Not a passkey registration");
  await clientData(credential, "webauthn.create", expect);
  const attestation = cbor(unb64url(credential.response.attestationObject)).value;
  const bytes = attestation instanceof Map ? attestation.get("authData") : undefined;
  if (!(bytes instanceof Uint8Array)) throw new Error("No authenticator data");
  const data = authData(bytes);
  await sameSite(data, expect.rpId);
  if (!data.credential) throw new Error("No credential in the registration");
  const id = b64url(data.credential.id);
  if (id !== credential.id) throw new Error("The credential's id doesn't match");
  return { id, key: data.credential.key, counter: data.counter };
}

/** A sign-in with a known passkey: checks its signature, and gives its new counter. */
export async function verifyAssertion(credential: CredentialJSON, key: PublicKey, counter: number, expect: Expect): Promise<{ counter: number }> {
  const { authenticatorData, signature } = credential.response;
  if (credential.type !== "public-key" || !authenticatorData || !signature) throw new Error("Not a passkey sign-in");
  const raw = await clientData(credential, "webauthn.get", expect);
  const bytes = unb64url(authenticatorData);
  const data = authData(bytes);
  await sameSite(data, expect.rpId);
  const signed = new Uint8Array(bytes.length + 32);
  signed.set(bytes);
  signed.set(await sha256(raw), bytes.length);
  if (!(await verifySignature(key, unb64url(signature), signed))) throw new Error("The signature doesn't check out");
  // A counter that doesn't go up (when the authenticator keeps one) means the key may have been copied.
  if ((data.counter !== 0 || counter !== 0) && data.counter <= counter) throw new Error("The passkey's counter went backwards");
  return { counter: data.counter };
}
