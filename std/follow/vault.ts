// The vault: how a person's API keys follow them between devices without the
// site's server ever being able to read one (std/follow/module.ts sends them,
// std/account/module.ts turns it on and unlocks it). Fetched the first time
// either needs it, so a device that keeps no keys in an account never loads it.
//
// The person's account gets one random key of its own, the vault key, made on
// the device where they turn this on. Every API key is encrypted with it
// (AES-GCM) before it leaves the device, so the account keeps only ciphertext:
//
//   key:gemini-api-key    { iv, ct }                       one API key, with the hosts it may be sent to
//
// The vault key itself is kept in the account too, locked with a secret only
// the person holds, once for each secret they set:
//
//   vault:pass            { kind, id, salt, iter, iv, ct }   locked with a passphrase (PBKDF2)
//   vault:prf-<passkey>   { kind, id, cred, iv, ct }         locked with a passkey (WebAuthn PRF)
//
// (`id` names the vault key without giving anything of it away, so a device
// can tell whether the one it unlocked is still the account's.)
//
// A new device asks for that secret once, unlocks the vault key and keeps it
// (in this origin's IndexedDB, so every app and space on the device has it).
// From then on its keys come and go like anything else that follows the
// person. Without the secret there is nothing to recover: the person starts
// again and types their keys once more.
//
// Nothing here writes a key, a passphrase or the vault key to a trace or a log.

import type { Secret } from "../../src/kernel/secrets";

/** The names the account keeps these under (src/server/auth/follow.ts takes the same). */
export const VAULT = /^vault:(?:pass|prf-[0-9a-f]{16})$/;
export const KEY = /^key:[a-z][a-z0-9-]{0,40}$/;
/** How hard a passphrase is stretched. A locked vault key that says fewer than MIN isn't trusted: a server can't make guessing cheap. */
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 300_000;
const MAX_ITERATIONS = 5_000_000;
export const MIN_PASSPHRASE = 10;
/** What a passkey is asked to derive from (the same on every device, so the same passkey gives the same answer). */
export const PRF_SALT = "extensible-web-apps: keys that follow you, v1";

/** A vault key as the account keeps it, locked. */
export type Locked = { kind: "pass"; id: string; salt: string; iter: number; iv: string; ct: string } | { kind: "prf"; id: string; cred: string; iv: string; ct: string };
/** An API key as the account keeps it. */
export type Sealed = { iv: string; ct: string };

const text = (value: string) => new TextEncoder().encode(value);
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const aes = (raw: Uint8Array) => crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);

async function seal(key: CryptoKey, about: string, plain: Uint8Array): Promise<Sealed> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: text(about) as BufferSource }, key, plain as BufferSource);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}
/** The plain bytes, or undefined if this key didn't seal them (or they were changed since). */
async function open(key: CryptoKey, about: string, sealed: { iv?: unknown; ct?: unknown }): Promise<Uint8Array | undefined> {
  if (typeof sealed?.iv !== "string" || typeof sealed.ct !== "string") return undefined;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) as BufferSource, additionalData: text(about) as BufferSource }, key, fromBase64(sealed.ct) as BufferSource));
  } catch {
    return undefined;
  }
}

const fromPassphrase = async (passphrase: string, salt: Uint8Array, iterations: number) =>
  crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, await crypto.subtle.importKey("raw", text(passphrase.normalize("NFKC")) as BufferSource, "PBKDF2", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const fromPasskey = async (derived: Uint8Array) =>
  crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text("vault key") as BufferSource }, await crypto.subtle.importKey("raw", derived as BufferSource, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

const hmac = async (raw: Uint8Array, what: string) => hex(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), text(what) as BufferSource));
/** What names a vault key: the same on every device that has it, and nothing anyone can work back from. */
export const idOf = async (raw: Uint8Array) => (await hmac(raw, "vault id")).slice(0, 16);
/** A hash of something sent to the account, as the account compares them. */
export const hashOf = async (value: unknown) => hex(await crypto.subtle.digest("SHA-256", text(JSON.stringify(value)) as BufferSource)).slice(0, 40);
/** A new vault key. */
export const fresh = () => random(32);
/** The name a passkey's lock is kept under: one for each passkey. */
export const prfName = async (cred: string) => `vault:prf-${hex(await crypto.subtle.digest("SHA-256", text(cred) as BufferSource)).slice(0, 16)}`;

/** The vault key, locked with a passphrase. */
export async function lockWithPassphrase(user: string, raw: Uint8Array, passphrase: string): Promise<Locked> {
  const salt = random(16);
  return { kind: "pass", id: await idOf(raw), salt: toBase64(salt), iter: ITERATIONS, ...(await seal(await fromPassphrase(passphrase, salt, ITERATIONS), `vault|${user}`, raw)) };
}
/** The vault key, locked with what a passkey derived (`derived`, as base64). */
export async function lockWithPasskey(user: string, raw: Uint8Array, cred: string, derived: string): Promise<Locked> {
  return { kind: "prf", id: await idOf(raw), cred, ...(await seal(await fromPasskey(fromBase64(derived)), `vault|${user}`, raw)) };
}
/** The vault key, if the passphrase (or what the passkey derived) is the one that locked it. */
export async function unlock(user: string, locked: Locked, secret: string): Promise<Uint8Array | undefined> {
  let key: CryptoKey;
  if (locked?.kind === "pass") {
    if (typeof locked.salt !== "string" || !Number.isSafeInteger(locked.iter) || locked.iter < MIN_ITERATIONS || locked.iter > MAX_ITERATIONS) return undefined;
    key = await fromPassphrase(secret, fromBase64(locked.salt), locked.iter);
  } else if (locked?.kind === "prf") key = await fromPasskey(fromBase64(secret));
  else return undefined;
  const raw = await open(key, `vault|${user}`, locked);
  return raw?.length === 32 && (await idOf(raw)) === locked.id ? raw : undefined;
}

/** An API key, sealed for the account: its value, the hosts it may be sent to and its label. */
export async function sealSecret(user: string, raw: Uint8Array, name: string, secret: Secret): Promise<Sealed> {
  return seal(await aes(raw), `key|${user}|${name}`, text(JSON.stringify({ value: secret.value, hosts: secret.hosts, label: secret.label })));
}
/** The API key the account kept, or undefined if this vault key didn't seal it. */
export async function openSecret(user: string, raw: Uint8Array, name: string, sealed: unknown): Promise<Secret | undefined> {
  const plain = await open(await aes(raw), `key|${user}|${name}`, (sealed ?? {}) as Sealed);
  if (!plain) return undefined;
  try {
    const s = JSON.parse(new TextDecoder().decode(plain));
    if (typeof s?.value !== "string" || !s.value || !Array.isArray(s.hosts) || !s.hosts.length || s.hosts.some((h: unknown) => typeof h !== "string")) return undefined;
    return { value: s.value, hosts: s.hosts, ...(typeof s.label === "string" && { label: s.label }) };
  } catch {
    return undefined;
  }
}
/** What stands for an API key when devices compare what they have: the same for the same key, and no use to anyone without the vault key. */
export async function markOf(raw: Uint8Array, name: string, secret: Secret): Promise<string> {
  return (await hmac(raw, JSON.stringify([name, secret.value, secret.hosts, secret.label ?? ""]))).slice(0, 40);
}

// The unlocked vault key, kept for the whole device: every kernel here (each app's, each space's) reads the same one.
const DB = "follow-vault";
const STORE = "keys";
const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("This browser wouldn't open the place your unlocked keys are kept"));
  });
async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const open = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = open.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("This browser couldn't keep your unlocked keys"));
    });
  } finally {
    open.close();
  }
}
/** The vault key this device has unlocked for a person, if it has and it is still one of the account's (`vaults`: what the account keeps locked). */
export async function unlocked(user: string, vaults: Record<string, { id?: unknown }>): Promise<Uint8Array | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const raw = await inStore("readonly", (store) => store.get(user)).catch(() => undefined);
  if (!(raw instanceof Uint8Array) || raw.length !== 32) return undefined;
  const id = await idOf(raw);
  return Object.values(vaults).some((v) => v?.id === id) ? raw : undefined;
}
/** Keeps the unlocked vault key on this device, or (given none) forgets it. */
export async function keep(user: string, raw?: Uint8Array): Promise<void> {
  await inStore("readwrite", (store): IDBRequest => (raw ? store.put(raw, user) : store.delete(user)));
}
