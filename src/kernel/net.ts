// net.fetch: the kernel makes a web request for a plugin, to one host the
// plugin's manifest names (`network:api.anthropic.com`), and can put a secret
// into it (secrets.ts) without the plugin ever seeing the secret.
//
//   ctx.call("net", "fetch", {
//     url: "https://api.anthropic.com/v1/messages",
//     method: "POST",
//     headers: { "x-api-key": { secret: "anthropic" }, "content-type": "application/json" },
//     body: JSON.stringify(request),
//   })
//
// A header written as { secret: name } is filled in here, if the plugin has
// `secret:<name>` and the URL's host is one the secret was given for. The
// answer is { ok, status, headers, text }. Only https:, or http: to this
// computer (for a model served locally, such as Ollama).
//
// This is narrower than the `network` permission, which lets a plugin's own
// worker connect to any https: host: a plugin with only `network:<host>`
// reaches that host and nothing else.

import type { ServiceProvider } from "./remote";
import type { Secrets } from "./secrets";
import { env } from "./env";
import { grants } from "./gate";
import { record } from "./trace";

const MAX = 4_000_000;
// Ten minutes: a model that reasons before it answers can take several.
const TIMEOUT = 600_000;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Headers a plugin may not set: the browser's own, and ones that would change who is asking. */
const FORBIDDEN = /^(cookie|host|origin|referer|connection|content-length|proxy-.*|sec-.*)$/i;

/** The host a URL is for, as a capability names it: `api.example.com`, or `localhost:11434` with a port. */
export function hostOf(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function parse(input: unknown, onServer = false, allowPrivate: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error("net.fetch needs a full URL");
  }
  if (url.username || url.password) throw new Error("A URL with a user name or password isn't allowed; use a secret in a header");
  const bare = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowedLocal = !onServer || allowPrivate.some((h) => h.toLowerCase().replace(/^\[|\]$/g, "") === bare);
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL.has(url.hostname) && allowedLocal)) return url;
  throw new Error(onServer ? "On a server, net.fetch only reaches public https: addresses" : "net.fetch only reaches https: addresses, or http: on this computer");
}

/** Redacts every secret value in `redact` from `value`, preferring longer secrets first. */
function hideAll(value: string, redact: string[]): string {
  return redact.reduce((out, secretValue) => out.split(secretValue).join("[secret]"), value);
}

/**
 * Exact length (at most `maxSecretLength - 1`) of the longest suffix of `pending` that is a prefix of any secret
 * in `redact`, so split secrets never leak across chunk boundaries while normal SSE frames (`\n\n`) flush at once.
 */
function overlapHold(pending: string, redact: string[]): number {
  let hold = 0;
  for (const s of redact) {
    const maxK = Math.min(s.length - 1, pending.length);
    for (let k = maxK; k > hold; k--) {
      if (s.startsWith(pending.slice(pending.length - k))) {
        hold = k;
        break;
      }
    }
  }
  return hold;
}

/**
 * Redacts the safe prefix of `pending`, holding back any trailing characters that match a prefix of a secret in
 * `redact` (up to `maxSecretLength - 1`) so a secret split across TCP chunk boundaries can never leak.
 */
function redactWindow(pending: string, redact: string[], eof: boolean): { out: string; rest: string } {
  if (!redact.length) return { out: pending, rest: "" };
  if (eof) return { out: hideAll(pending, redact), rest: "" };
  const hold = overlapHold(pending, redact);
  if (pending.length <= hold) return { out: "", rest: pending };
  let out = "";
  let at = 0;
  while (at < pending.length - hold) {
    let bestIdx = -1;
    let bestLen = 0;
    for (const s of redact) {
      const i = pending.indexOf(s, at);
      if (i !== -1 && i < pending.length - hold && (bestIdx === -1 || i < bestIdx || (i === bestIdx && s.length > bestLen))) {
        bestIdx = i;
        bestLen = s.length;
      }
    }
    if (bestIdx === -1) {
      const cut = pending.length - hold;
      out += pending.slice(at, cut);
      at = cut;
      break;
    }
    out += pending.slice(at, bestIdx) + "[secret]";
    at = bestIdx + bestLen;
  }
  return { out, rest: pending.slice(at) };
}

/** The body as text, read a chunk at a time and stopped as soon as it passes MAX bytes. */
async function readText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX) {
      await reader.cancel().catch(() => {});
      throw new Error("The answer is over 4 MB");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Streams a response body chunk by chunk with overlap-buffered secret redaction, returning the full redacted text. */
async function streamText(
  response: Response,
  redact: string[],
  onChunk: (chunk: string, done: boolean) => void,
): Promise<string> {
  if (!response.body) {
    onChunk("", true);
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let pending = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX) {
      await reader.cancel().catch(() => {});
      throw new Error("The answer is over 4 MB");
    }
    const decoded = decoder.decode(value, { stream: true });
    if (!decoded) continue;
    pending += decoded;
    const { out, rest } = redactWindow(pending, redact, false);
    pending = rest;
    if (out) {
      full += out;
      onChunk(out, false);
    }
  }
  pending += decoder.decode();
  const { out } = redactWindow(pending, redact, true);
  if (out) {
    full += out;
    onChunk(out, false);
  }
  onChunk("", true);
  return full;
}

export function net(
  secrets: Secrets,
  capsOf: (plugin: string) => Set<string>,
  emitChunk?: (plugin: string, value: { streamId: string; chunk: string; done: boolean }, trace?: string) => void,
): ServiceProvider {
  return {
    description: "Web requests the kernel makes for a plugin, to the hosts its manifest names. A header can hold a secret the plugin never sees.",
    methods: {
      fetch: {
        args: "({ url, method?, headers?, body?, streamId? })",
        returns: "{ ok, status, headers, text }",
        needs: "network:<host>",
        description: "Fetches `url` (https:, or http: on localhost) and returns the answer as text, up to 4 MB, within ten minutes (emitting incremental chunks on `net:chunk` to the caller when `streamId` is set). A header given as `{ secret: name }` is filled with that secret, if the plugin has `secret:<name>` and the host is one the secret is for.",
        params: [
          {
            name: "request",
            schema: {
              type: "object",
              properties: {
                url: { type: "string", description: "An https: address on a host the manifest names" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
                headers: { type: "object" },
                body: { type: "string" },
                streamId: { type: "string", description: "Optional id to receive incremental response chunks on net:chunk" },
              },
              required: ["url"],
            },
          },
        ],
      },
    },
    capability: (_method, args) => {
      const input = args[0] as { url?: unknown } | undefined;
      try {
        const where = env();
        return `network:${hostOf(parse(input?.url, where.kind === "server", where.allowPrivate))}`;
      } catch {
        return "network:?";
      }
    },
    call: async (plugin, method, args, dispatch) => {
      if (method !== "fetch") throw new Error(`net.${method} is not a method`);
      const input = (args[0] ?? {}) as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown; streamId?: unknown };
      if (input.streamId !== undefined && (typeof input.streamId !== "string" || input.streamId.length > 256)) {
        throw new Error("streamId is text up to 256 characters");
      }
      const streamId = typeof input.streamId === "string" && input.streamId.length > 0 ? input.streamId : undefined;
      const where = env();
      const url = parse(input.url, where.kind === "server", where.allowPrivate);
      const host = hostOf(url);
      const verb = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(verb)) throw new Error(`net.fetch doesn't send ${verb}`);
      await secrets.loaded;
      const headers = new Headers();
      const used: string[] = [];
      const redact: string[] = [];
      let usesManaged = false;
      let managedCap: number | undefined;
      for (const [name, value] of Object.entries((input.headers && typeof input.headers === "object" ? input.headers : {}) as Record<string, unknown>)) {
        if (FORBIDDEN.test(name)) throw new Error(`net.fetch can't set the ${name} header`);
        if (typeof value === "string") headers.set(name, value);
        else if (value && typeof value === "object" && typeof (value as { secret?: unknown }).secret === "string") {
          const wanted = (value as { secret: string }).secret;
          const prefix = typeof (value as { prefix?: unknown }).prefix === "string" ? (value as { prefix: string }).prefix.slice(0, 20) : "";
          if (!grants(capsOf(plugin), `secret:${wanted}`)) throw new Error(`Using the secret ${wanted} needs secret:${wanted}`);
          let secret: { value: string; hosts: string[] } | undefined = secrets.get(wanted);
          if (!secret) {
            const dep = await secrets.managed(wanted, plugin);
            if (dep) {
              secret = dep;
              usesManaged = true;
              if (dep.dailyCap !== undefined) managedCap = managedCap === undefined ? dep.dailyCap : Math.min(managedCap, dep.dailyCap);
            }
          }
          if (!secret) throw new Error(`The person hasn't given the secret ${wanted} yet; ask with secrets.request`);
          if (!secret.hosts.includes(host)) throw new Error(`The secret ${wanted} is only for ${secret.hosts.join(", ")}, not ${host}`);
          headers.set(name, prefix + secret.value);
          used.push(wanted);
          if (secret.value.length >= 4) redact.push(secret.value);
        } else throw new Error(`The ${name} header must be a string or { secret }`);
      }
      redact.sort((a, b) => b.length - a.length);
      const body = input.body === undefined || input.body === null ? undefined : String(input.body);
      if (body && body.length > MAX) throw new Error("The request body is over 4 MB");
      if (usesManaged) await secrets.countManaged(plugin, dispatch.trace, managedCap);
      const started = performance.now();
      const fetcher = where.fetch ?? fetch;
      const response = await fetcher(url, { method: verb, headers, body, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT) }).catch((error) => {
        throw new Error(`Couldn't reach ${host}: ${error instanceof Error ? error.message : error}`);
      });
      // An API that echoes the request back would hand the plugin its secret: take every secret used out of the answer.
      const hide = (value: string) => hideAll(value, redact);
      const text =
        streamId && response.ok
          ? await streamText(response, redact, (chunk, done) => emitChunk?.(plugin, { streamId, chunk, done }, dispatch.trace))
          : hide(await readText(response));
      record({ kind: "call", name: `net:${verb} ${host}`, plugin, trace: dispatch.trace, ms: Math.round(performance.now() - started), detail: `${response.status}${used.length ? `, with ${used.join(", ")}` : ""}` });
      return { ok: response.ok, status: response.status, headers: Object.fromEntries([...response.headers].map(([k, v]) => [k, hide(v)])), text };
    },
  };
}
