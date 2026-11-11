// Web Push from the server: notifications that reach a person's device with
// every tab of the site closed. A device subscribes with the browser's push
// service (in a page, account/page.js) and gives the subscription to the
// person's account; when a space's server plugin shows a notification
// (std/notify/module.ts), the server sends it, encrypted for that device, to
// the push service, which wakes the site's service worker to show it
// (sw/push.js).
//
// The routes, under the accounts' /auth/ (accounts.ts), for whoever is signed in:
//   GET  /auth/push           { key, devices: [{ id, label, created }] }: the server's public key, which a
//                              subscription is made for, and the person's devices that get notifications
//                              (?endpoint=<a subscription's address> adds `here`, that device's id, if it is one of them)
//   POST /auth/push           { subscription: { endpoint, keys: { p256dh, auth } }, label? }   adds this device
//   POST /auth/push/remove    { id } or { endpoint }   takes a device away
//   POST /auth/push/test      sends the person's own devices a test notification, to see one arrives
//
// The server's key pair (VAPID, RFC 8292) is made here the first time it is
// needed and kept with the accounts, never in the repository or a setting: a
// push service takes a message for a subscription only from whoever holds
// the key the subscription was made for. Each message is encrypted for the
// one device (RFC 8291, aes128gcm), so the push service carries it without
// being able to read it.
//
// A subscription's address is where the server sends, and a client chooses
// it, so only the browsers' own push services are sent to (HOSTS), plus any
// the deployment names in PUSH_HOSTS. Anything else is refused when the
// device subscribes, saying so.
//
// Kept on the accounts' files seam, so the same on Node and Cloudflare:
//   push/vapid.json                       the server's key pair
//   push/devices/<user>/<id>.json         each device's subscription
//   push/sent/<user>.json                 how many were sent to a person today

import type { Files } from "../../seams/index.ts";

/** What a notification says, as the service worker shows it. */
export interface PushNote {
  title: string;
  body?: string;
  /** A notification with the same tag replaces the last. */
  tag?: string;
  /** Where a click on it goes: a path on this site. */
  url: string;
  /** The app it is from (its folder's path), so a tab with it open is brought forward, and one being looked at isn't interrupted. */
  app?: string;
  /** Shown even while the person is looking at the app. */
  always?: boolean;
}

interface Device {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  created: number;
}

/** The browsers' own push services: Chrome and Edge on Android and desktop, Firefox, Windows, Safari. */
const HOSTS = ["fcm.googleapis.com", ".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];
const MAX_DEVICES = 10;
/** Notifications one person is sent in a day, across every space and plugin. */
const PER_DAY = 200;
/** The most a push service must take is 4096 bytes; what is said is kept well under it. */
const MAX_PAYLOAD = 3000;
const TTL = 24 * 3600;
const B64 = /^[A-Za-z0-9_-]+$/;

// (Named here from the functions that give them: Node's and Workers' type libraries don't name them alike.)
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Pair = { publicKey: Key; privateKey: Key };

const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
/** How many bytes a base64url text holds: 0 for one that isn't base64url. */
const bytesIn = (text: string) => {
  try {
    return unb64url(text).length;
  } catch {
    return 0;
  }
};
const utf8 = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The deployment's PUSH_HOSTS setting: more push services to send to, as origins separated by commas
 * ("https://push.example.com"). Plain http only to this machine (the server checks' stand-in). Anything else
 * stops the server from starting, rather than quietly sending nowhere or somewhere unexpected.
 */
export function pushHostsFrom(setting: string | undefined): string[] {
  return (setting ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL | undefined;
      try {
        url = new URL(entry);
      } catch {}
      const local = url && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
      if (!url || url.pathname !== "/" || url.search || !(url.protocol === "https:" || (url.protocol === "http:" && local))) throw new Error(`PUSH_HOSTS: ${entry} must be an https origin such as https://push.example.com`);
      return url.origin;
    });
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A message encrypted for one subscription (RFC 8291): only the device that made the subscription can read it. */
export async function encrypt(keys: { p256dh: string; auth: string }, text: string): Promise<Uint8Array> {
  const theirs = unb64url(keys.p256dh);
  const secret = unb64url(keys.auth);
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as Pair;
  const ours = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const theirKey = await crypto.subtle.importKey("raw", theirs, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], pair.privateKey, 256));
  const ikm = await hkdf(secret, shared, join(utf8("WebPush: info\0"), theirs, ours), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the text, then the byte that says it is the last.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, join(utf8(text), new Uint8Array([2]))));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, 4096);
  return join(salt, size, new Uint8Array([ours.length]), ours, sealed);
}

export interface PushOptions {
  /** More push services to send to (pushHostsFrom). */
  hosts?: string[];
  /** How the server reaches a push service, when not with fetch. */
  fetch?: typeof globalThis.fetch;
}

export function push(files: Files, user: (request: Request) => Promise<{ id: string; name: string } | null>, serial: <T>(task: () => Promise<T>) => Promise<T>, options: PushOptions = {}) {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const read = async <T>(path: string): Promise<T | null> => {
    const bytes = await files.read(path);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      return null;
    }
  };
  const write = (path: string, value: unknown) => files.write(path, JSON.stringify(value));

  /** Whether a subscription's address is one of a push service this server sends to. */
  const known = (endpoint: unknown): URL | null => {
    let url: URL;
    try {
      url = new URL(String(endpoint));
    } catch {
      return null;
    }
    if (typeof endpoint !== "string" || endpoint.length > 2000 || url.username || url.password) return null;
    if ((options.hosts ?? []).includes(url.origin)) return url;
    if (url.protocol !== "https:" || url.port) return null;
    return HOSTS.some((h) => (h.startsWith(".") ? url.hostname.endsWith(h) : url.hostname === h)) ? url : null;
  };

  /** The server's key pair, made the first time it is needed. */
  let pair: Promise<{ publicKey: string; sign: Key }> | undefined;
  const vapid = () =>
    (pair ??= serial(async () => {
      let kept = await read<{ publicKey: string; privateKey: string }>("push/vapid.json");
      if (!kept?.publicKey || !kept.privateKey) {
        const made = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as Pair;
        kept = { publicKey: b64url((await crypto.subtle.exportKey("raw", made.publicKey)) as ArrayBuffer), privateKey: b64url((await crypto.subtle.exportKey("pkcs8", made.privateKey)) as ArrayBuffer) };
        await write("push/vapid.json", kept);
      }
      return { publicKey: kept.publicKey, sign: await crypto.subtle.importKey("pkcs8", unb64url(kept.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
    }).catch((error) => {
      pair = undefined;
      throw error;
    }));

  /** What tells a push service the message is from the server the subscription was made for (RFC 8292). */
  async function authorization(endpoint: URL, origin: string): Promise<string> {
    const { publicKey, sign } = await vapid();
    const part = (value: unknown) => b64url(utf8(JSON.stringify(value)));
    // A push service wants someone to reach about a misbehaving sender: the site itself.
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origin.startsWith("https:") ? origin : "mailto:push@localhost" })}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign, utf8(unsigned));
    return `vapid t=${unsigned}.${b64url(signature)}, k=${publicKey}`;
  }

  const devicesOf = async (id: string): Promise<Device[]> => (await Promise.all((await files.list(`push/devices/${id}/`)).map((path) => read<Device>(path)))).filter((d): d is Device => !!d?.endpoint).sort((a, b) => a.created - b.created);
  const idOf = async (endpoint: string) => b64url(await crypto.subtle.digest("SHA-256", utf8(endpoint))).slice(0, 22);

  /** Sends one device a note. "gone" when the push service says the subscription has ended, which takes the device away. */
  async function deliver(owner: string, device: Device, note: PushNote, origin: string): Promise<"sent" | "gone" | string> {
    const endpoint = known(device.endpoint);
    if (!endpoint) return "its push service isn't one this site sends to";
    try {
      const body = await encrypt(device.keys, JSON.stringify(note));
      const tag = note.tag ? b64url(await crypto.subtle.digest("SHA-256", utf8(note.tag))).slice(0, 32) : undefined;
      const answer = await send(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: await authorization(endpoint, origin), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(TTL), urgency: "normal", ...(tag ? { topic: tag } : {}) },
        body,
      });
      if (answer.status === 404 || answer.status === 410) {
        await files.remove(`push/devices/${owner}/${device.id}.json`);
        return "gone";
      }
      return answer.status >= 200 && answer.status < 300 ? "sent" : `its push service answered ${answer.status}`;
    } catch (error) {
      return `its push service couldn't be reached (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  /**
   * Sends a note to every device of each person. Answers how many devices got it, how many people have none,
   * and what went wrong with the rest, so whoever asked can say.
   */
  async function sendTo(users: string[], note: PushNote, origin: string): Promise<{ sent: number; devices: number; people: number; reached: number; problems: string[] }> {
    const said: PushNote = { title: String(note.title).slice(0, 120), ...(note.body ? { body: String(note.body).slice(0, 400) } : {}), ...(note.tag ? { tag: String(note.tag).slice(0, 100) } : {}), url: String(note.url).slice(0, 500), ...(note.app ? { app: String(note.app).slice(0, 300) } : {}), ...(note.always ? { always: true } : {}) };
    if (JSON.stringify(said).length > MAX_PAYLOAD) throw new Error("That notification is too long to send");
    const out = { sent: 0, devices: 0, people: users.length, reached: 0, problems: [] as string[] };
    const day = new Date().toISOString().slice(0, 10);
    for (const id of [...new Set(users)]) {
      const devices = await devicesOf(id);
      if (!devices.length) continue;
      const count = await serial(async () => {
        const kept = await read<{ day: string; sent: number }>(`push/sent/${id}.json`);
        const sent = kept?.day === day ? kept.sent : 0;
        if (sent >= PER_DAY) return null;
        await write(`push/sent/${id}.json`, { day, sent: sent + 1 });
        return sent + 1;
      });
      if (count === null) {
        out.problems.push(`someone has had the ${PER_DAY} notifications a person is sent in a day`);
        continue;
      }
      out.devices += devices.length;
      const results = await Promise.all(devices.map((device) => deliver(id, device, said, origin)));
      const sent = results.filter((r) => r === "sent").length;
      out.sent += sent;
      if (sent) out.reached++;
      for (const r of results) if (r !== "sent" && r !== "gone") out.problems.push(r);
    }
    return out;
  }

  return {
    sendTo,
    /** The server's public key, as a page gives it to the browser to subscribe. */
    key: async () => (await vapid()).publicKey,

    /** Answers the routes, or gives undefined for any other request. `body` is a POST's, already read and checked to be from this site. */
    async handle(request: Request, url: URL, body?: Record<string, unknown>): Promise<Response | undefined> {
      if (!/^\/auth\/push(\/remove|\/test)?$/.test(url.pathname)) return undefined;
      const me = await user(request);
      if (!me) return json({ error: "Sign in to get notifications on this device" }, 401);
      const listed = async () => ({ key: (await vapid()).publicKey, devices: (await devicesOf(me.id)).map(({ id, label, created }) => ({ id, label, created })) });
      if (request.method === "GET") {
        if (url.pathname !== "/auth/push") return undefined;
        // A browser asks whether its own subscription (?endpoint=) is one of the person's devices: `here` is that device's id.
        const mine = url.searchParams.get("endpoint");
        const here = mine ? await idOf(mine) : "";
        const all = await listed();
        return json({ ...all, ...(here && all.devices.some((d) => d.id === here) ? { here } : {}) });
      }
      if (!body) return undefined;

      if (url.pathname === "/auth/push") {
        const s = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
        const { p256dh, auth } = s?.keys ?? {};
        if (!s || typeof s.endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" || !B64.test(p256dh) || !B64.test(auth) || bytesIn(p256dh) !== 65 || bytesIn(auth) !== 16)
          return json({ error: "That isn't a push subscription. Turn notifications on from your account page, in the browser you want them in." }, 400);
        const endpoint = known(s.endpoint);
        if (!endpoint) {
          let host = "it";
          try {
            host = new URL(s.endpoint).host;
          } catch {}
          return json({ error: `This browser's push service (${host}) isn't one this site sends to. Whoever runs the site can allow it with the PUSH_HOSTS setting.` }, 400);
        }
        const id = await idOf(s.endpoint);
        const existing = await devicesOf(me.id);
        if (!existing.some((d) => d.id === id) && existing.length >= MAX_DEVICES) return json({ error: `You get notifications on ${MAX_DEVICES} devices already. Take one away first.` }, 400);
        const label = String(body.label ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60) || "A browser";
        await write(`push/devices/${me.id}/${id}.json`, { id, endpoint: s.endpoint, keys: { p256dh, auth }, label, created: existing.find((d) => d.id === id)?.created ?? Date.now() } satisfies Device);
        return json({ ok: true, id, ...(await listed()) });
      }
      if (url.pathname === "/auth/push/remove") {
        const id = typeof body.id === "string" && B64.test(body.id) ? body.id : typeof body.endpoint === "string" ? await idOf(body.endpoint) : "";
        if (!id || !(await read<Device>(`push/devices/${me.id}/${id}.json`))) return json({ error: "You have no such device" }, 404);
        await files.remove(`push/devices/${me.id}/${id}.json`);
        return json({ ok: true, ...(await listed()) });
      }
      // A test, to see one arrives: only to the person's own devices.
      if (!(await devicesOf(me.id)).length) return json({ error: "No device of yours gets notifications yet. Turn them on first, on this device." }, 409);
      const result = await sendTo([me.id], { title: `Notifications from ${url.host} reach this device`, body: `Hello ${me.name}. Apps in your spaces can tell you things here, even with every tab closed.`, tag: "push-test", url: "/account/", always: true }, url.origin);
      if (!result.sent) return json({ error: `The test wasn't sent: ${result.problems[0] ?? "the device's subscription has ended. Turn notifications on again"}.`, ...result }, 502);
      return json({ ok: true, ...result });
    },
  };
}
