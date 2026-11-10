// Where a name leads, on Cloudflare. A Worker has no DNS lookup of its own,
// and its fetch looks a name up out of sight, so the network guard
// (network-guard.ts) and the feed reader couldn't tell a public-looking name
// that points at 10.0.0.5 or 127.0.0.1 from any other, as Node's guard does by
// the address a connection goes to (src/server/network-guard.ts). This asks a
// DNS-over-HTTPS resolver for the name's addresses first, so such a name is
// refused here too, with the same words.
//
// It is a check before the request, not the connection itself: the request
// that follows looks the name up again, and a name can answer differently the
// second time. Cloudflare's own egress, which reaches only the public
// internet, is what stands behind that; this makes the two hosts refuse the
// same cases, and covers `wrangler dev`, whose fetch does reach this machine.
//
// The resolver is Cloudflare's (RESOLVER) unless the deployment names another
// with the DNS_RESOLVER variable (the server checks name a stand-in on this
// machine). A name that can't be looked up at all, or has no address, isn't
// asked: not knowing where it leads is a refusal, not a pass.

/** The resolver asked when the deployment names none: Cloudflare's, as JSON. */
export const RESOLVER = "https://cloudflare-dns.com/dns-query";

/** How long a name's answer is kept, and how many names. */
const FRESH = 60_000;
const REMEMBERED = 500;
const TIMEOUT = 5_000;

/** A and AAAA records, by their DNS type numbers. */
const TYPES = { A: 1, AAAA: 28 } as const;

const remembered = new Map<string, { at: number; addresses: string[] }>();

/** The resolver a deployment's DNS_RESOLVER setting names, or Cloudflare's when it has none. A setting that isn't an http(s) address is an error. */
export function resolverFrom(setting: string | undefined): string {
  if (setting === undefined || setting === "") return RESOLVER;
  let url: URL | undefined;
  try {
    url = new URL(setting);
  } catch {}
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) throw new Error(`DNS_RESOLVER must be the address of a DNS-over-HTTPS resolver, such as ${RESOLVER}, not ${JSON.stringify(setting)}`);
  return url.href;
}

/**
 * Every address a name has now (A and AAAA), as the resolver writes them; none if the name doesn't exist.
 * Throws when the resolver can't say, so the caller doesn't go on without knowing.
 */
export async function addressesOf(name: string, resolver: string = RESOLVER): Promise<string[]> {
  const host = name.toLowerCase().replace(/\.$/, "");
  const key = `${resolver} ${host}`;
  const kept = remembered.get(key);
  if (kept && Date.now() - kept.at < FRESH) return kept.addresses;
  const one = async (type: keyof typeof TYPES): Promise<string[]> => {
    const answer = await fetch(`${resolver}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!answer.ok) throw new Error(`the resolver answered ${answer.status}`);
    const said = (await answer.json()) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
    // 0 is an answer (which may be empty), 3 is "no such name": anything else is the resolver failing.
    if (said.Status !== 0 && said.Status !== 3) throw new Error(`the resolver couldn't look it up (status ${String(said.Status)})`);
    return (Array.isArray(said.Answer) ? said.Answer : []).filter((record) => record?.type === TYPES[type] && typeof record.data === "string").map((record) => String(record.data));
  };
  let addresses: string[];
  try {
    addresses = (await Promise.all([one("A"), one("AAAA")])).flat();
  } catch (error) {
    throw new Error(`Couldn't find where ${host} leads, so it wasn't asked: ${error instanceof Error ? error.message : String(error)}`);
  }
  remembered.delete(key);
  remembered.set(key, { at: Date.now(), addresses });
  while (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value!);
  return addresses;
}
