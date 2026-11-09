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
// Names that resolve to a private address are left to Cloudflare's own
// egress, which only reaches the public internet; a Worker can't look a name
// up first. A deployment can let some hosts through anyway (`allow`, by host
// as written in the URL): the tests' server on 127.0.0.1, under wrangler dev.

import { WorkerEntrypoint } from "cloudflare:workers";

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

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
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

const refusal = (where: string) => new Error(`A server plugin can't reach ${where}: it is on the server's own network`);

/** The most redirects a request follows, as fetch does. */
const HOPS = 20;

export class NetworkGuard extends WorkerEntrypoint<unknown, { allow?: string[] }> {
  async fetch(request: Request): Promise<Response> {
    const allow = new Set((this.ctx.props?.allow ?? []).map((h) => h.toLowerCase()));
    const check = (url: URL) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`A server plugin can only fetch http: and https:, not ${url.protocol}`);
      if (!allow.has(url.hostname.toLowerCase()) && isOwnNetwork(url.hostname)) throw refusal(url.host);
    };
    // Each redirect is followed here, so each address it leads to is checked before it is asked.
    const follow = request.redirect !== "manual";
    let current = request;
    for (let hop = 0; ; hop++) {
      check(new URL(current.url));
      const answer = await fetch(current, { redirect: "manual" });
      const location = answer.headers.get("location");
      if (!follow || ![301, 302, 303, 307, 308].includes(answer.status) || !location) return answer;
      if (request.redirect === "error") throw new TypeError("A redirect was refused, as the request asked");
      if (hop >= HOPS) throw new TypeError("Too many redirects");
      const next = new URL(location, current.url);
      // 303, and 301 or 302 after a POST, go on as a GET with no body, as fetch does.
      const asGet = answer.status === 303 || ((answer.status === 301 || answer.status === 302) && current.method === "POST");
      current = new Request(next, asGet ? { method: current.method === "HEAD" ? "HEAD" : "GET", headers: current.headers, redirect: "manual" } : { method: current.method, headers: current.headers, body: current.body, redirect: "manual" });
    }
  }
}
