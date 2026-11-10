// What a server plugin with `network` may reach on a Node host: the public
// internet, and not the server's own network. Without this, a plugin that
// fetches an address a person typed (a feed reader's feed, a webhook) could
// be pointed at localhost, the machine's private network, or a cloud's
// metadata service, and read what's there. Cloudflare's Workers can't reach
// those anyway; on Node, the plugin's process is on the server's network.
//
// The check is made where every connection is finally made: the TCP handle
// that connects a socket to an address, after DNS, whatever opened it (fetch,
// its redirects, WebSocket, EventSource, or an undici Agent the plugin made
// itself). Unix sockets are refused outright. Those handles are locked, so a
// plugin can't put the unguarded ones back.
//
// On top of that, so a refusal says why: DNS answers are checked as they
// arrive, and an address written as a literal IP is checked before the
// request.
//
// A deployment can name hosts its server plugins may reach anyway (a feed on
// the same machine, in development): `allow`, by host name or IP as written
// in the URL. Where the handles check, by address, an allowed host's
// addresses are open whatever name leads there.

import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { connect, createServer } from "node:net";
import { constants } from "node:os";

// The guard runs in the same process as the plugin, after it has started. A
// plugin can replace built-ins for everyone (Set.prototype.has, a string or
// RegExp method, Function.prototype.call), so the checks below use none it
// can reach: copies taken when this module loads, before any plugin code,
// plain property reads, and typed arrays.
const call = Function.prototype.call;
const codeAt = call.bind(String.prototype.charCodeAt) as (s: string, i: number) => number;
const lower = call.bind(String.prototype.toLowerCase) as (s: string) => string;
const sliceOf = call.bind(String.prototype.slice) as (s: string, from: number, to: number) => string;
const reflectApply = Reflect.apply;
const defineProperty = Object.defineProperty;
const nullObject = Object.create.bind(Object, null) as () => Record<string, true>;
const Hextets = Uint16Array;

/** A hex digit's value, or -1. */
function hex(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** A dotted IPv4 address in s[from, to) as a number, or -1. */
function ipv4(s: string, from: number, to: number): number {
  let value = 0;
  let parts = 0;
  let i = from;
  while (parts < 4) {
    let part = 0;
    let digits = 0;
    while (i < to && codeAt(s, i) >= 48 && codeAt(s, i) <= 57) {
      if (digits === 1 && part === 0) return -1; // a leading zero
      part = part * 10 + codeAt(s, i) - 48;
      digits++;
      i++;
    }
    if (digits === 0 || digits > 3 || part > 255) return -1;
    value = value * 256 + part;
    parts++;
    if (parts < 4) {
      if (i >= to || codeAt(s, i) !== 46) return -1;
      i++;
    }
  }
  return i === to ? value : -1;
}

/**
 * An IP address as eight 16-bit groups (an IPv4 one as ::ffff:a.b.c.d), and
 * whether it was written as IPv4; undefined if it isn't an IP address.
 */
function parse(written: string): { groups: Uint16Array; four: boolean } | undefined {
  let from = 0;
  let to = written.length;
  if (to >= 2 && codeAt(written, 0) === 91 && codeAt(written, to - 1) === 93) {
    from = 1;
    to--;
  }
  for (let i = from; i < to; i++)
    if (codeAt(written, i) === 37) {
      to = i; // a zone, as in fe80::1%eth0
      break;
    }
  const groups = new Hextets(8);
  const v4 = ipv4(written, from, to);
  if (v4 >= 0) {
    groups[5] = 0xffff;
    groups[6] = v4 >>> 16;
    groups[7] = v4 & 0xffff;
    return { groups, four: true };
  }
  // IPv6: the groups before a ::, and after it.
  const head = new Hextets(8);
  const tail = new Hextets(8);
  let heads = 0;
  let tails = 0;
  let gap = false;
  let i = from;
  if (to - i >= 2 && codeAt(written, i) === 58 && codeAt(written, i + 1) === 58) {
    gap = true;
    i += 2;
  } else if (i < to && codeAt(written, i) === 58) return undefined;
  while (i < to) {
    if ((gap ? tails : heads) >= 8) return undefined;
    let j = i;
    let value = 0;
    while (j < to && hex(codeAt(written, j)) >= 0) value = value * 16 + hex(codeAt(written, j++));
    if (j < to && codeAt(written, j) === 46) {
      // A dotted IPv4 address as the last two groups.
      const last = ipv4(written, i, to);
      if (last < 0 || (gap ? tails : heads) > 6) return undefined;
      if (gap) {
        tail[tails++] = last >>> 16;
        tail[tails++] = last & 0xffff;
      } else {
        head[heads++] = last >>> 16;
        head[heads++] = last & 0xffff;
      }
      i = to;
      break;
    }
    if (j === i || j - i > 4) return undefined;
    if (gap) tail[tails++] = value;
    else head[heads++] = value;
    i = j;
    if (i === to) break;
    if (codeAt(written, i) !== 58) return undefined;
    i++;
    if (i < to && codeAt(written, i) === 58) {
      if (gap) return undefined;
      gap = true;
      i++;
    } else if (i === to) return undefined;
  }
  if (gap ? heads + tails > 7 : heads !== 8) return undefined;
  for (let k = 0; k < heads; k++) groups[k] = head[k];
  for (let k = 0; k < tails; k++) groups[8 - tails + k] = tail[k];
  return { groups, four: false };
}

/** Whether the first `bits` bits of two addresses are the same. */
function within(groups: Uint16Array, net: Uint16Array, bits: number): boolean {
  for (let g = 0; g < 8 && bits > 0; g++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((groups[g] & mask) !== (net[g] & mask)) return false;
  }
  return true;
}

/** Private, local and reserved networks, as [groups, prefix length]; IPv4 ones as ::ffff:a.b.c.d/(96 + n). */
const blocked: [Uint16Array, number][] = [];
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const) {
  const ip = parse(net)!;
  blocked[blocked.length] = [ip.groups, ip.four ? 96 + prefix : prefix];
}
const BLOCKED = blocked.length;

/** Whether an IP address is on a private, local or reserved network (anything that isn't an IP address is). */
export function isPrivate(address: string): boolean {
  const ip = typeof address === "string" ? parse(address) : undefined;
  if (!ip) return true;
  for (let k = 0; k < BLOCKED; k++) if (within(ip.groups, blocked[k][0], blocked[k][1])) return true;
  return false;
}

/** An address as a key, the same however it is written in its family (::1 and 0:0::1). */
function key(address: string): string | undefined {
  const ip = parse(address);
  if (!ip) return undefined;
  const g = ip.groups;
  return `${ip.four ? 4 : 6}:${g[0]}:${g[1]}:${g[2]}:${g[3]}:${g[4]}:${g[5]}:${g[6]}:${g[7]}`;
}

class PrivateAddress extends Error {
  code = "EPRIVATE";
  constructor(where: string) {
    super(`A server plugin can't reach ${where}: it is on the server's own network`);
  }
}

/** A host as written in a URL, lower case and without brackets. */
const bare = (host: string) => {
  const h = lower(host);
  return h.length >= 2 && codeAt(h, 0) === 91 && codeAt(h, h.length - 1) === 93 ? sliceOf(h, 1, h.length - 1) : h;
};
const all = (host: string) => new Promise<LookupAddress[]>((done) => lookup(host, { all: true }, (error, list) => done(error ? [] : list)));

/** Locks a handle's connect method to `guarded`, so nothing in this process can connect without it. */
function lock(proto: any, name: string, guarded: (original: Function) => Function) {
  const original = proto[name];
  if (typeof original !== "function") return;
  defineProperty(proto, name, { value: guarded(original), writable: false, configurable: false });
}

/** Puts the guard on this process's connections. Called once, before the plugin's code runs. */
export async function guardNetwork(allow: string[] = []): Promise<void> {
  // Plain objects with no prototype, read and written as properties, not Sets a plugin can change.
  const names = nullObject();
  // The private addresses a connection may go to: the allowed hosts', as written or looked up.
  const addresses = nullObject();
  const open = (address: string) => {
    const k = key(address);
    if (k) addresses[k] = true;
  };
  for (const host of allow) {
    const name = bare(host);
    names[name] = true;
    if (key(name)) open(name);
    else for (const a of await all(name)) open(a.address);
  }
  const refused = (ip: unknown) => typeof ip !== "string" || (isPrivate(ip) && addresses[key(ip) ?? ""] !== true);

  // The handles every TCP and Unix socket connects through. A refused connect fails as EACCES.
  const EACCES = -constants.errno.EACCES;
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const TCP = (server as any)._handle.constructor;
  server.close();
  const pipe = connect({ path: "\0guard" }).on("error", () => {});
  const Pipe = (pipe as any)._handle?.constructor;
  pipe.destroy();
  for (const name of ["connect", "connect6"])
    lock(TCP.prototype, name, (original) =>
      function (this: unknown, _request: unknown, address: unknown) {
        // arguments, not a spread: a spread uses an iterator a plugin can replace.
        return refused(address) ? EACCES : reflectApply(original, this, arguments);
      },
    );
  if (Pipe) lock(Pipe.prototype, "connect", () => () => EACCES);

  // So a refusal says why. fetch and WebSocket go through undici's global dispatcher, whose DNS lookup
  // is replaced with one that refuses private answers by name.
  const self = globalThis as any;
  await fetch("data:,");
  const KEY = Symbol.for("undici.globalDispatcher.1");
  const Agent = self[KEY]?.constructor;
  if (typeof Agent !== "function") throw new Error("Couldn't guard the network: no dispatcher to replace");
  const guarded = (host: string, options: LookupOptions, done: (error: Error | null, address?: string | LookupAddress[], family?: number) => void) =>
    lookup(host, { ...options, all: true }, (error, found) => {
      if (error) return done(error);
      const list = found as LookupAddress[];
      const named = names[bare(host)] === true;
      // By name, only the allowed names may go inside (the handles' check is by address).
      let inside: LookupAddress | undefined;
      for (let k = 0; k < list.length; k++)
        if (named) open(list[k].address);
        else if (!inside && isPrivate(list[k].address)) inside = list[k];
      if (inside) return done(new PrivateAddress(`${host} (${inside.address})`));
      if (options.all) return done(null, list);
      done(null, list[0].address, list[0].family);
    });
  self[KEY] = new Agent({ connect: { lookup: guarded } });

  /** Refuses a URL whose host is a literal private IP, before the request. */
  const check = (url: URL) => {
    const host = bare(url.hostname);
    if (names[host] !== true && key(host) && refused(host)) throw new PrivateAddress(url.host);
  };

  const fetchFrom = self.fetch.bind(self);
  self.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    check(new URL(input instanceof Request ? input.url : input));
    try {
      return await fetchFrom(input, init);
    } catch (error: any) {
      // A redirect to a literal private IP is refused by the TCP handle: say so as plainly.
      const cause = error?.cause;
      if (cause?.code === "EACCES" && typeof cause.address === "string" && isPrivate(cause.address))
        throw new TypeError("fetch failed", { cause: new PrivateAddress(`${cause.address}${cause.port ? `:${cause.port}` : ""}`) });
      throw error;
    }
  };

  const Socket = self.WebSocket;
  if (typeof Socket === "function")
    self.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        check(new URL(url));
        super(url, protocols);
      }
    };
}

/**
 * A fetch function for the space kernel's own net.fetch on Node (space-env.ts) that refuses private, loopback,
 * link-local and metadata addresses after DNS, while leaving the thread's global fetch intact for reading its own site.
 */
export function makeGuardedFetch(allow: string[] = []): typeof globalThis.fetch {
  const allowed = new Set(allow.map(bare));
  let dispatcher: unknown;
  const ensure = async () => {
    if (dispatcher) return dispatcher;
    await fetch("data:,");
    const Agent = (globalThis as any)[Symbol.for("undici.globalDispatcher.1")]?.constructor;
    if (typeof Agent !== "function") throw new Error("Couldn't guard net.fetch: no dispatcher available");
    const guarded = (host: string, options: LookupOptions, done: (error: Error | null, address?: string | LookupAddress[], family?: number) => void) =>
      lookup(host, { ...options, all: true }, (error, found) => {
        if (error) return done(error);
        const list = found as LookupAddress[];
        if (!allowed.has(bare(host))) {
          const inside = list.find((a) => isPrivate(a.address));
          if (inside) return done(new PrivateAddress(`${host} (${inside.address})`));
        }
        if (options.all) return done(null, list);
        done(null, list[0].address, list[0].family);
      });
    dispatcher = new Agent({ connect: { lookup: guarded } });
    return dispatcher;
  };
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = bare(url.hostname);
    if (!allowed.has(host) && key(host) && isPrivate(host)) throw new PrivateAddress(url.host);
    return fetch(input, { ...init, dispatcher: await ensure() } as RequestInit);
  };
}
