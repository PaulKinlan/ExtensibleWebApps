// What a server plugin with `network` may reach on Cloudflare: the public
// internet, as on Node (src/server/network-guard.ts). A Worker's own fetch
// can't reach a private network in production, but nothing checked that
// against the cases Node's guard refuses, and `wrangler dev` reaches this
// machine's. So a plugin's isolate sends every request through this
// entrypoint (its `globalOutbound`, src/server/cloudflare/worker.ts), and it
// refuses the same cases, with the same words, on both: a host that is
// localhost, an IP address on a private, local or reserved network (however
// it is written: the URL parser writes it one way), and a redirect to one.
//
// A name that resolves to a private address is refused too: a Worker can't
// look a name up as it connects, so the guard asks a resolver for the name's
// addresses before each request (names.ts), and refuses if any is inside. A
// deployment can let some hosts through anyway (`allow`, by host as written in
// the URL): the tests' server on 127.0.0.1, under wrangler dev.

import { WorkerEntrypoint } from "cloudflare:workers";
import { addressesOf } from "./names.ts";

/** Whether a host, as a URL's `hostname` writes it, is on the server's own network (or the machine itself). */
export function isOwnNetwork(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return privateV4(v4.slice(1).map(Number));
  if (!host.includes(":")) return false;
  // IPv6, as the URL parser writes it: lower case, the longest run of zeros as ::, an embedded IPv4 address in hex.
  const groups = expand(host);
  if (!groups) return true;
  const [a, b] = groups;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return true; // :: and ::1
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return privateV4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255]); // ::ffff:a.b.c.d
  if (a === 0x64 && b === 0xff9b) return true; // NAT64
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00; // unique local, link-local, multicast
}

function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

/** An IPv6 address's eight groups, or undefined. */
function expand(host: string): number[] | undefined {
  const [head, tail, more] = host.split("::");
  if (more !== undefined) return undefined;
  const part = (s: string | undefined) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const front = part(head);
  const back = part(tail);
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

/** Whether a host, as a URL's `hostname` writes it, is an IP address and not a name. */
const isAddress = (hostname: string) => hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * The first address on the server's own network that a name leads to, if any: asked of the resolver, since a
 * Worker can't look a name up itself (names.ts). Undefined for a name that only leads outside, and for an IP
 * address, which isOwnNetwork has already judged as written. Throws for a name with no address at all.
 */
export async function leadsInside(hostname: string, resolver?: string): Promise<string | undefined> {
  if (isAddress(hostname)) return undefined;
  const addresses = await addressesOf(hostname, resolver);
  // A name the resolver has no address for isn't asked: the request's own lookup might know one (a hosts file
  // under wrangler dev, a private zone), and that address would go unchecked.
  if (!addresses.length) throw new Error(`Couldn't find where ${hostname} leads, so it wasn't asked: it has no address`);
  return addresses.find((address) => isOwnNetwork(address.includes(":") ? `[${address}]` : address));
}

const refusal = (where: string) => new Error(`A server plugin can't reach ${where}: it is on the server's own network`);

/** The most redirects a request follows, as fetch does. */
const HOPS = 20;

/** A host as written in a URL or a setting, lower case and without brackets: [::1] and ::1 are the same. */
const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");

/** Headers that belong to the site they were sent to, so a redirect to another site doesn't carry them on (as fetch does). */
const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"];

export class NetworkGuard extends WorkerEntrypoint<unknown, { allow?: string[]; resolver?: string }> {
  async fetch(request: Request): Promise<Response> {
    const allow = new Set((this.ctx.props?.allow ?? []).map(bare));
    const resolver = this.ctx.props?.resolver;
    const check = async (url: URL) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`A server plugin can only fetch http: and https:, not ${url.protocol}`);
      if (allow.has(bare(url.hostname))) return;
      if (isOwnNetwork(url.hostname)) throw refusal(url.host);
      // A name is judged by where it leads, as Node's guard does (the address a connection goes to).
      const inside = await leadsInside(url.hostname, resolver);
      if (inside) throw refusal(`${url.host} (${inside})`);
    };
    // Each redirect is followed here, so each address it leads to is checked before it is asked.
    const follow = request.redirect !== "manual";
    // The body is read once, so a 307 or 308 can send it again.
    const body = request.body && follow ? await request.arrayBuffer() : request.body;
    let method = request.method;
    let headers = new Headers(request.headers);
    let url = new URL(request.url);
    let sent: ArrayBuffer | ReadableStream | null = body;
    for (let hop = 0; ; hop++) {
      await check(url);
      const answer = await fetch(new Request(url, { method, headers, body: sent, redirect: "manual" }));
      const location = answer.headers.get("location");
      if (!follow || ![301, 302, 303, 307, 308].includes(answer.status) || !location) return answer;
      if (request.redirect === "error") throw new TypeError("A redirect was refused, as the request asked");
      if (hop >= HOPS) throw new TypeError("Too many redirects");
      const next = new URL(location, url);
      // 303, and 301 or 302 after a POST, go on as a GET with no body, as fetch does.
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        sent = null;
        headers = new Headers(headers);
        for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
      }
      if (next.origin !== url.origin) {
        headers = new Headers(headers);
        for (const name of CREDENTIALS) headers.delete(name);
      }
      url = next;
    }
  }
}
