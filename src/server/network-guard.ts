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
import { BlockList, connect, createServer, isIP } from "node:net";
import { constants } from "node:os";

const blocked = new BlockList();
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
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** An IPv6 address that holds an IPv4 one (::ffff:127.0.0.1, or ::ffff:7f00:1), as that IPv4 address. */
function mapped(address: string): string | undefined {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether an IP address is on a private, local or reserved network. */
export function isPrivate(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const v4 = mapped(ip);
  if (v4) return blocked.check(v4, "ipv4");
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true;
}

class PrivateAddress extends Error {
  code = "EPRIVATE";
  constructor(where: string) {
    super(`A server plugin can't reach ${where}: it is on the server's own network`);
  }
}

const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");
const all = (host: string) => new Promise<LookupAddress[]>((done) => lookup(host, { all: true }, (error, list) => done(error ? [] : list)));

/** Locks a handle's connect method to `guarded`, so nothing in this process can connect without it. */
function lock(proto: any, name: string, guarded: (original: Function) => Function) {
  const original = proto[name];
  if (typeof original !== "function") return;
  Object.defineProperty(proto, name, { value: guarded(original), writable: false, configurable: false });
}

/** Puts the guard on this process's connections. Called once, before the plugin's code runs. */
export async function guardNetwork(allow: string[] = []): Promise<void> {
  const names = new Set(allow.map(bare));
  // The private addresses a connection may go to: the allowed hosts', as written or looked up.
  const addresses = new Set<string>();
  for (const name of names) for (const ip of isIP(name) ? [name] : (await all(name)).map((a) => a.address)) addresses.add(ip);
  const refused = (ip: string) => isPrivate(ip) && !addresses.has(bare(ip));

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
      function (this: unknown, request: unknown, address: string, ...rest: unknown[]) {
        return refused(address) ? EACCES : original.call(this, request, address, ...rest);
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
      const named = names.has(bare(host));
      if (named) for (const a of list) addresses.add(a.address);
      // By name, only the allowed names may go inside (the handles' check is by address).
      const inside = !named && list.find((a) => isPrivate(a.address));
      if (inside) return done(new PrivateAddress(`${host} (${inside.address})`));
      if (options.all) return done(null, list);
      done(null, list[0].address, list[0].family);
    });
  self[KEY] = new Agent({ connect: { lookup: guarded } });

  /** Refuses a URL whose host is a literal private IP, before the request. */
  const check = (url: URL) => {
    const host = bare(url.hostname);
    if (!names.has(host) && isIP(host) && refused(host)) throw new PrivateAddress(url.host);
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
