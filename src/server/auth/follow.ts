// What follows a person from device to device: the plugins and agents they
// added, which of them are on, where they moved views, and the model they
// picked. A device's kernel (std/follow/module.ts) sends what changed there
// and asks for what changed elsewhere; the account keeps the latest of each.
//
// A person can have their API keys follow them too. The account never keeps
// one it could read: a device encrypts each key before sending it, with a key
// only the person's devices hold (std/follow/vault.ts), so a `key:` or
// `vault:` item is ciphertext and what unlocks it never comes here. An item of
// those kinds that isn't in that shape is refused.
//
// The account doesn't know what an item means. Each is a key (`file:demos/trip/countdown.js`,
// `on:_everywhere/clock`, `move:demos/trip|clock|main`, `llm:prefer`, `key:gemini`, `vault:pass`), a JSON
// value and the hash the device gave it. Every change takes the next number,
// so a device that says the last number it saw gets only what is newer. An
// item that was removed stays as a mark (`gone`), so the other devices remove
// it too. When two devices change the same item, the one that reaches the
// account last is kept.
//
// The routes, under the accounts' /auth/ (accounts.ts), for whoever is signed in:
//   GET  /auth/follow?since=<n>   { user, name, version, items: [{ key, v, h, value } | { key, v, gone: true }] }
//        (&only=vault gives only the items of that kind)
//   POST /auth/follow { changes: [{ key, h, value } | { key, gone: true }] }   { version, saved: [{ key, v }] }
//
// Kept on the accounts' files seam, so the same on Node and Cloudflare:
//   follow/<user>/index.json           the number, and each item's number, hash and size
//   follow/<user>/items/<hash of key>  each item's value

import type { Files } from "../../seams/index.ts";
import { bodyOf } from "./accounts.ts";

/** One request's changes, as sent: a device sends more in several requests. */
export const FOLLOW_BODY = 768 * 1024;
/** One item's value, as JSON. */
const MAX_ITEM = 256 * 1024;
/** Everything one person's account keeps, and how many items. */
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
/** Only the kinds of thing that follow a person, each named with nothing a path or a log could be confused by. Anything else is refused. */
const KEY = /^(?:(?:file|on|move):[\w.~|/-]{1,300}|llm:prefer|key:[a-z][a-z0-9-]{0,40}|vault:(?:pass|prf-[0-9a-f]{16}))$/;
const HASH = /^[\w+/=-]{1,100}$/;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const b64 = (value: unknown, min: number, max: number) => typeof value === "string" && value.length >= min && value.length <= max && B64.test(value);
const only = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every((name) => name in value);
/**
 * Whether a `key:` or `vault:` item is in the shape a device encrypts it to (std/follow/vault.ts): an AES-GCM
 * nonce and ciphertext, and for a vault key what it was locked with. Nothing else fits, so a device with a
 * mistake in it can't leave a readable key here.
 */
function encrypted(key: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!b64(v.iv, 16, 16)) return false;
  if (key.startsWith("key:")) return only(v, ["iv", "ct"]) && b64(v.ct, 24, 12_000);
  // A vault key is 32 bytes and its tag: 64 characters.
  if (!b64(v.ct, 64, 64) || typeof v.id !== "string" || !/^[0-9a-f]{16}$/.test(v.id)) return false;
  if (key === "vault:pass") return v.kind === "pass" && only(v, ["kind", "id", "salt", "iter", "iv", "ct"]) && b64(v.salt, 24, 24) && Number.isSafeInteger(v.iter) && (v.iter as number) > 0;
  return v.kind === "prf" && only(v, ["kind", "id", "cred", "iv", "ct"]) && typeof v.cred === "string" && /^[\w-]{1,1400}$/.test(v.cred);
}

interface Entry {
  v: number;
  h?: string;
  /** Its value's size, as JSON. */
  n?: number;
  gone?: true;
}
interface Index {
  version: number;
  items: Record<string, Entry>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const refuse = (error: string, status = 400) => json({ error }, status);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function follow(
  files: Files,
  /** Who a request is signed in as. */
  who: (request: Request) => Promise<{ id: string; name: string } | null>,
  /** Runs one change at a time, with the accounts' other changes. */
  serial: <T>(task: () => Promise<T>) => Promise<T>,
) {
  const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const indexAt = (user: string) => `follow/${user}/index.json`;
  const itemAt = async (user: string, key: string) => `follow/${user}/items/${await sha(key)}.json`;
  const indexOf = async (user: string): Promise<Index> => {
    const text = await files.readText(indexAt(user));
    const index = text ? (JSON.parse(text) as Index) : null;
    return index && typeof index.version === "number" && index.items && typeof index.items === "object" ? index : { version: 0, items: {} };
  };

  async function changed(user: { id: string; name: string }, since: number, kind?: string): Promise<Response> {
    const index = await indexOf(user.id);
    const items = [];
    for (const [key, entry] of Object.entries(index.items).sort((a, b) => a[1].v - b[1].v)) {
      if (entry.v <= since || (kind && !key.startsWith(`${kind}:`))) continue;
      if (entry.gone) {
        // A device that has seen nothing has nothing to remove.
        if (since > 0) items.push({ key, v: entry.v, gone: true });
        continue;
      }
      const text = await files.readText(await itemAt(user.id, key));
      if (text !== null) items.push({ key, v: entry.v, h: entry.h, value: JSON.parse(text) });
    }
    return json({ user: user.id, name: user.name, version: index.version, items });
  }

  async function save(user: { id: string }, changes: unknown): Promise<Response> {
    if (!Array.isArray(changes) || changes.length > MAX_ITEMS) return refuse("Send { changes: [{ key, h, value }] } or [{ key, gone: true }]");
    const index = await indexOf(user.id);
    const items = { ...index.items };
    let version = index.version;
    const writes: { key: string; text?: string }[] = [];
    for (const change of changes as Record<string, unknown>[]) {
      const key = change?.key;
      if (typeof key !== "string" || !KEY.test(key)) return refuse(`${String(JSON.stringify(key)).slice(0, 80)} isn't the name of something an account keeps`);
      const had = items[key];
      if (change.gone === true) {
        if (!had || had.gone) continue;
        items[key] = { v: ++version, gone: true };
        writes.push({ key });
        continue;
      }
      if (typeof change.h !== "string" || !HASH.test(change.h) || change.value === undefined) return refuse(`${key} needs its value and its hash`);
      if (had && !had.gone && had.h === change.h) continue;
      if (/^(?:key|vault):/.test(key) && !encrypted(key, change.value)) return refuse(`${key} wasn't encrypted on the device first, and your account never keeps a key it could read. Nothing was saved.`);
      const text = JSON.stringify(change.value);
      const n = new TextEncoder().encode(text).length;
      if (n > MAX_ITEM) return refuse(`${key} is ${kb(n)}, and your account keeps a file of at most ${kb(MAX_ITEM)}. It stays on this device only.`, 413);
      items[key] = { v: ++version, h: change.h, n };
      writes.push({ key, text });
    }
    const kept = Object.values(items).filter((entry) => !entry.gone);
    const total = kept.reduce((sum, entry) => sum + (entry.n ?? 0), 0);
    if (kept.length > MAX_ITEMS) return refuse(`Your account keeps at most ${MAX_ITEMS} plugins, files and moves, and this would make ${kept.length}. Remove some you no longer use, then try again.`, 413);
    if (total > MAX_TOTAL) return refuse(`Your account keeps at most ${kb(MAX_TOTAL)} of plugins and their files, and this would make ${kb(total)}. Remove a plugin you no longer use, then try again.`, 413);
    // The values first, then the index that says they are there: a write that stops half way leaves the index as it was.
    for (const { key, text } of writes) {
      const at = await itemAt(user.id, key);
      if (text === undefined) await files.remove(at);
      else await files.write(at, text);
    }
    if (writes.length) await files.write(indexAt(user.id), JSON.stringify({ version, items }));
    return json({ version, saved: writes.map(({ key }) => ({ key, v: items[key].v })) });
  }

  return {
    /** Answers a request for /auth/follow, or gives undefined for any other. */
    async handle(request: Request, url: URL): Promise<Response | undefined> {
      if (url.pathname !== "/auth/follow" || (request.method !== "GET" && request.method !== "POST")) return undefined;
      // Only this site's own pages and kernels send changes (a form on another site can't).
      if (request.method === "POST" && request.headers.get("origin") !== url.origin) return refuse("Not from this site", 403);
      const user = await who(request);
      if (!user) return refuse("Not signed in", 401);
      if (request.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isSafeInteger(since) || since < 0) return refuse("since is the last number this device saw");
        // In the queue with the saves, so an item's number and hash are never read with another save's value.
        const kind = url.searchParams.get("only") ?? undefined;
        if (kind !== undefined && !/^[a-z]{1,10}$/.test(kind)) return refuse("only is a kind of item: file, on, move, llm, key or vault");
        return serial(() => changed(user, since, kind));
      }
      const text = await bodyOf(request, FOLLOW_BODY);
      if (text === null) return refuse(`That is more than ${kb(FOLLOW_BODY)} in one request: send fewer changes at a time`, 413);
      let body: { changes?: unknown };
      try {
        body = JSON.parse(text || "{}");
      } catch {
        return refuse("JSON only");
      }
      return serial(() => save(user, body?.changes));
    },
  };
}
