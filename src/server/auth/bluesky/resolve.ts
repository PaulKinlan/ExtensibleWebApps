// Finding who someone is on the AT Protocol (Bluesky's network), and which
// server signs them in. Nobody's account lives at bsky.social as such:
//
//   handle (alice.example.com)  --DNS TXT _atproto, or https://<handle>/.well-known/atproto-did-->  DID
//   DID (did:plc:… or did:web:…)  --plc.directory, or https://<host>/.well-known/did.json-->  DID document
//   DID document  --its #atproto_pds service-->  their PDS (the server that keeps their data)
//   PDS  --/.well-known/oauth-protected-resource-->  the authorization server that signs them in
//   authorization server  --/.well-known/oauth-authorization-server-->  its endpoints
//
// A handle is only theirs if the DID document names it back (alsoKnownAs: at://<handle>).
//
// Every URL here comes from someone's input or from a document someone else
// wrote, so each fetch is guarded: HTTPS only, no IP addresses or local names,
// no redirects, a time limit, and a size limit.
// See https://atproto.com/specs/handle, /did and /oauth.

export interface Settings {
  /** The PLC directory, which answers for did:plc. */
  plc: string;
  /** A DNS-over-HTTPS server that answers JSON, for a handle's TXT record. */
  dns: string;
  /** A server that answers com.atproto.identity.resolveHandle, to ask instead of DNS and HTTPS. */
  resolver?: string;
  /** For the server checks only: lets http:// and this machine's addresses through. */
  insecure: boolean;
  fetch: typeof fetch;
}

/** What an authorization server says about itself, as much as sign-in uses. */
export interface ServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
}

export interface Account {
  did: string;
  /** Their handle, if their DID document names it and it points back at them. */
  handle?: string;
  pds: string;
}

const HANDLE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
// TLDs a handle may not use (https://atproto.com/specs/handle).
const NOT_HANDLES = /\.(alt|arpa|example|internal|invalid|local|localhost|onion)$/;
export const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(%3A[0-9]{1,5})?)$/;
const LIMIT = 100 * 1024;
const TIMEOUT = 8_000;

export const isHandle = (text: string) => text.length <= 253 && HANDLE.test(text) && !NOT_HANDLES.test(text);

/** A URL that's safe to ask: HTTPS, a public name (not an IP address or a local name), no password. */
export function safeUrl(url: string, settings: Settings): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url.slice(0, 100)}`);
  }
  if (settings.insecure) {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`Not a web address: ${parsed.href}`);
    return parsed;
  }
  // "localhost." is localhost: names are checked without a trailing dot.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  const local = host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host) || !host.includes(".") || /\.(localhost|local|internal|arpa|home|lan|corp|intranet)$/.test(host);
  if (parsed.protocol !== "https:" || local || parsed.username || parsed.password) throw new Error(`Won't ask ${parsed.origin}: only public HTTPS servers`);
  return parsed;
}

/** GET a URL that answers JSON (or text), guarded as above. */
export async function get(url: string, settings: Settings, accept = "application/json"): Promise<string> {
  const target = safeUrl(url, settings);
  const answer = await settings.fetch(target.href, { redirect: "manual", headers: { accept }, signal: AbortSignal.timeout(TIMEOUT) });
  if (answer.status !== 200) throw new Error(`${target.origin} answered ${answer.status}`);
  return capped(answer);
}

export const getJson = async <T>(url: string, settings: Settings): Promise<T> => {
  const value = JSON.parse(await get(url, settings)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${new URL(url).origin} didn't answer with an object`);
  return value as T;
};

/** A response's body as text, up to LIMIT bytes. */
export async function capped(answer: Response): Promise<string> {
  if (Number(answer.headers.get("content-length") ?? 0) > LIMIT) throw new Error("Too big");
  const reader = answer.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMIT) {
      await reader.cancel();
      throw new Error("Too big");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) all.set(chunk, (at += chunk.byteLength) - chunk.byteLength);
  return new TextDecoder().decode(all);
}

/** A handle's DID: from a resolver if one is set, else DNS first, then HTTPS. */
export async function resolveHandle(handle: string, settings: Settings): Promise<string> {
  if (!isHandle(handle)) throw new Error(`${handle} isn't a handle`);
  if (settings.resolver) {
    const { did } = await getJson<{ did?: unknown }>(`${settings.resolver}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, settings).catch(() => ({ did: null }));
    if (typeof did !== "string" || !DID.test(did)) throw new Error(`No account has the handle ${handle}`);
    return did;
  }
  // Both start at once; DNS's answer wins, and doesn't wait for HTTPS.
  const https = viaHttps(handle, settings).catch(() => null);
  const did = (await viaDns(handle, settings).catch(() => null)) || (await https);
  if (!did) throw new Error(`No account has the handle ${handle}`);
  return did;
}

/** The handle's _atproto TXT record, which says did=<did>: exactly one, or none counts. */
async function viaDns(handle: string, settings: Settings): Promise<string | null> {
  const url = new URL(settings.dns);
  url.searchParams.set("name", `_atproto.${handle}`);
  url.searchParams.set("type", "TXT");
  const { Answer = [] } = JSON.parse(await get(url.href, settings, "application/dns-json")) as { Answer?: { type: number; data: string }[] };
  const dids = Answer.filter((a) => a.type === 16)
    // TXT data comes quoted, sometimes as more than one string.
    .map((a) => String(a.data).replace(/" ?"/g, "").replace(/^"|"$/g, ""))
    .filter((t) => t.startsWith("did="))
    .map((t) => t.slice(4));
  return dids.length === 1 && DID.test(dids[0]) ? dids[0] : null;
}

/** https://<handle>/.well-known/atproto-did, a DID on its own. */
async function viaHttps(handle: string, settings: Settings): Promise<string | null> {
  const did = (await get(`https://${handle}/.well-known/atproto-did`, settings, "text/plain")).split("\n")[0].trim();
  return DID.test(did) ? did : null;
}

interface DidDocument {
  id?: unknown;
  alsoKnownAs?: unknown;
  service?: { id?: unknown; type?: unknown; serviceEndpoint?: unknown }[];
}

/** A DID's document: who they are, and where their data is. */
export async function account(did: string, settings: Settings): Promise<Account> {
  if (!DID.test(did)) throw new Error(`${did.slice(0, 100)} isn't a DID`);
  const url = did.startsWith("did:plc:") ? `${settings.plc}/${did}` : `https://${decodeURIComponent(did.slice("did:web:".length))}/.well-known/did.json`;
  const doc = await getJson<DidDocument>(url, settings);
  if (doc.id !== did) throw new Error(`The document for ${did} is someone else's`);
  const service = (Array.isArray(doc.service) ? doc.service : []).find((s) => typeof s?.id === "string" && s.id.endsWith("#atproto_pds") && s.type === "AtprotoPersonalDataServer");
  if (typeof service?.serviceEndpoint !== "string") throw new Error(`${did} has no data server`);
  const pds = safeUrl(service.serviceEndpoint, settings).origin;
  const named = (Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : []).find((a): a is string => typeof a === "string" && a.startsWith("at://"));
  return { did, pds, handle: named?.slice("at://".length).toLowerCase() };
}

/** Their handle, only if it points back at their DID. */
export async function checkedHandle(found: Account, settings: Settings): Promise<string | undefined> {
  if (!found.handle || !isHandle(found.handle)) return undefined;
  return (await resolveHandle(found.handle, settings).catch(() => null)) === found.did ? found.handle : undefined;
}

/** The authorization server a PDS (or an entryway such as bsky.social) uses: its issuer URL. */
export async function issuerOf(server: string, settings: Settings): Promise<string> {
  const { authorization_servers: servers } = await getJson<{ authorization_servers?: unknown }>(`${server}/.well-known/oauth-protected-resource`, settings);
  const issuer = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof issuer !== "string") throw new Error(`${server} doesn't say who signs its people in`);
  return safeUrl(issuer, settings).origin;
}

/** An authorization server's endpoints, checked: it names itself, and does what atproto sign-in needs. */
export async function serverMeta(issuer: string, settings: Settings): Promise<ServerMeta> {
  const meta = await getJson<Record<string, unknown>>(`${issuer}/.well-known/oauth-authorization-server`, settings);
  if (meta.issuer !== issuer) throw new Error(`${issuer} calls itself something else`);
  const algs = meta.dpop_signing_alg_values_supported;
  if (!Array.isArray(algs) || !algs.includes("ES256")) throw new Error(`${issuer} doesn't take the DPoP proofs this server makes`);
  if (Array.isArray(meta.scopes_supported) && !meta.scopes_supported.includes("atproto")) throw new Error(`${issuer} isn't an atproto sign-in server`);
  for (const key of ["authorization_endpoint", "token_endpoint", "pushed_authorization_request_endpoint"] as const) {
    if (typeof meta[key] !== "string") throw new Error(`${issuer} has no ${key}`);
    safeUrl(meta[key] as string, settings);
  }
  return meta as unknown as ServerMeta;
}
