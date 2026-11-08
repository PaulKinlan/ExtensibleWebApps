// What a server plugin with `network` may reach on a Node host: the public
// internet, and not the server's own network. Without this, a plugin that
// fetches an address a person typed (a feed reader's feed, a webhook) could
// be pointed at localhost, the machine's private network, or a cloud's
// metadata service, and read what's there. Cloudflare's Workers can't reach
// those anyway; on Node, the plugin's process is on the server's network.
//
// Each connection is checked where it is made, against the address it is
// actually going to (after DNS), so a name that resolves somewhere private,
// or resolves differently the second time, is refused too. An address
// written as a literal IP is checked before the request; redirects are
// followed here, one at a time, so a public address can't redirect inside.
//
// A deployment can name hosts its server plugins may reach anyway (a feed on
// the same machine, in development): `allow`, by host name or IP as written
// in the URL.

import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";

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

/** Puts the guard on this process's fetch and WebSocket. Called once, before the plugin's code runs. */
export async function guardNetwork(allow: string[] = []): Promise<void> {
  const allowed = new Set(allow.map((h) => h.toLowerCase().replace(/^\[|\]$/g, "")));
  const self = globalThis as any;

  // Every connection fetch and WebSocket make goes through Node's built-in undici and its global
  // dispatcher. That dispatcher is replaced with one whose DNS lookup refuses private addresses.
  await fetch("data:,");
  const KEY = Symbol.for("undici.globalDispatcher.1");
  const Agent = self[KEY]?.constructor;
  if (typeof Agent !== "function") throw new Error("Couldn't guard the network: no dispatcher to replace");
  const guarded = (host: string, options: LookupOptions, done: (error: Error | null, address?: string | LookupAddress[], family?: number) => void) =>
    lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return done(error);
      const list = addresses as LookupAddress[];
      if (!allowed.has(host.toLowerCase())) {
        const inside = list.find((a) => isPrivate(a.address));
        if (inside) return done(new PrivateAddress(`${host} (${inside.address})`));
      }
      if (options.all) return done(null, list);
      done(null, list[0].address, list[0].family);
    });
  self[KEY] = new Agent({ connect: { lookup: guarded } });

  /** Refuses a URL whose host is a literal private IP (a literal isn't looked up, so the dispatcher wouldn't see it). */
  const check = (url: URL) => {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!allowed.has(host) && isIP(host) && isPrivate(host)) throw new PrivateAddress(url.host);
  };

  const fetchFrom = self.fetch.bind(self);
  self.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = new Request(input, init);
    // Redirects are followed here, each checked, unless the plugin asked to see them.
    const follow = request.redirect === "follow";
    let url = new URL(request.url);
    let next: Request = request;
    for (let hop = 0; hop <= 20; hop++) {
      check(url);
      const response: Response = await fetchFrom(next, { redirect: "manual" });
      const to = response.headers.get("location");
      const redirected = [301, 302, 303, 307, 308].includes(response.status) && !!to;
      if (redirected && request.redirect === "error") throw new TypeError(`${url.href} redirected, and redirects weren't allowed`);
      if (!follow || !redirected) return response;
      url = new URL(to!, url);
      const keepBody = response.status === 307 || response.status === 308;
      next = new Request(url, { method: keepBody ? request.method : request.method === "HEAD" ? "HEAD" : "GET", headers: request.headers, body: keepBody ? request.body : undefined, redirect: "manual" });
    }
    throw new TypeError("Too many redirects");
  };

  const Socket = self.WebSocket;
  if (typeof Socket === "function")
    self.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        check(new URL(url));
        super(url, protocols);
      }
    };
  // EventSource reconnects and redirects by itself, out of the guard's sight: a server plugin uses fetch.
  delete self.EventSource;
}
