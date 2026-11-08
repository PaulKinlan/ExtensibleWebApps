// A fetch for Bluesky sign-in that won't reach this machine's own network.
// Every server it asks was named by someone else (a handle, a DID document, a
// PDS), and a public-looking name can resolve to 10.0.0.5 or 127.0.0.1, or
// change its answer between a check and the connection (DNS rebinding). So
// on Node, the connection itself looks the name up, and refuses unless every
// address is public: the address checked is the address connected to.
//
// On Cloudflare a Worker's fetch only reaches the public internet, so there
// it's the platform's fetch.

const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";

/** Whether an address is on the public internet (not loopback, private, link-local, shared, multicast or reserved). */
export function isPublicAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && Number(v4[3]) === 0))) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  if (!v6.includes(":")) return false;
  return !(v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith("::ffff:") || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:"));
}

export const guardedFetch = (isNode ? nodeFetch : (input, init) => fetch(input, init)) as typeof fetch;

/** fetch over node:https, whose lookup refuses private addresses. Enough of fetch for sign-in: no redirects, a string or form body. */
async function nodeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  // Named in variables, so a Worker's bundle never tries to include them.
  const [https, dns, stream] = await Promise.all(["node:https", "node:dns", "node:stream"].map((name) => import(/* @vite-ignore */ name)));
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "https:") throw new TypeError(`Only https: here, not ${url.protocol}`);
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = init.body === undefined || init.body === null ? undefined : String(init.body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lookup = (host: string, options: any, done: (...args: any[]) => void) =>
    dns.lookup(host, { ...options, all: true }, (error: Error | null, addresses: { address: string; family: number }[]) => {
      if (error) return done(error);
      if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) return done(new Error(`${host} isn't on the public internet`));
      return options?.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
    });
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, { method: init.method ?? "GET", headers, lookup, signal: init.signal ?? undefined }, (answer: { headers: Record<string, unknown>; statusCode?: number; resume(): void }) => {
      const out = new Headers();
      for (const [name, value] of Object.entries(answer.headers)) for (const v of ([] as unknown[]).concat(value ?? [])) out.append(name, String(v));
      const status = answer.statusCode ?? 502;
      const nobody = status === 204 || status === 304 || (init.method ?? "GET") === "HEAD";
      if (nobody) answer.resume();
      resolve(new Response(nobody ? null : (stream.Readable.toWeb(answer) as ReadableStream), { status, headers: out }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
