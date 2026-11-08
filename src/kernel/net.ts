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

function parse(input: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error("net.fetch needs a full URL");
  }
  if (url.username || url.password) throw new Error("A URL with a user name or password isn't allowed; use a secret in a header");
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL.has(url.hostname))) return url;
  throw new Error("net.fetch only reaches https: addresses, or http: on this computer");
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

export function net(secrets: Secrets, capsOf: (plugin: string) => Set<string>): ServiceProvider {
  return {
    description: "Web requests the kernel makes for a plugin, to the hosts its manifest names. A header can hold a secret the plugin never sees.",
    methods: {
      fetch: {
        args: "({ url, method?, headers?, body? })",
        returns: "{ ok, status, headers, text }",
        needs: "network:<host>",
        description: "Fetches `url` (https:, or http: on localhost) and returns the answer as text, up to 4 MB, within two minutes. A header given as `{ secret: name }` is filled with that secret, if the plugin has `secret:<name>` and the host is one the secret is for.",
      },
    },
    capability: (_method, args) => {
      const input = args[0] as { url?: unknown } | undefined;
      try {
        return `network:${hostOf(parse(input?.url))}`;
      } catch {
        return "network:?";
      }
    },
    call: async (plugin, method, args, dispatch) => {
      if (method !== "fetch") throw new Error(`net.${method} is not a method`);
      const input = (args[0] ?? {}) as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
      const url = parse(input.url);
      const host = hostOf(url);
      const verb = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(verb)) throw new Error(`net.fetch doesn't send ${verb}`);
      await secrets.loaded;
      const headers = new Headers();
      const used: string[] = [];
      for (const [name, value] of Object.entries((input.headers && typeof input.headers === "object" ? input.headers : {}) as Record<string, unknown>)) {
        if (FORBIDDEN.test(name)) throw new Error(`net.fetch can't set the ${name} header`);
        if (typeof value === "string") headers.set(name, value);
        else if (value && typeof value === "object" && typeof (value as { secret?: unknown }).secret === "string") {
          const wanted = (value as { secret: string }).secret;
          const prefix = typeof (value as { prefix?: unknown }).prefix === "string" ? (value as { prefix: string }).prefix.slice(0, 20) : "";
          if (!grants(capsOf(plugin), `secret:${wanted}`)) throw new Error(`Using the secret ${wanted} needs secret:${wanted}`);
          const secret = secrets.get(wanted);
          if (!secret) throw new Error(`The person hasn't given the secret ${wanted} yet; ask with secrets.request`);
          if (!secret.hosts.includes(host)) throw new Error(`The secret ${wanted} is only for ${secret.hosts.join(", ")}, not ${host}`);
          headers.set(name, prefix + secret.value);
          used.push(wanted);
        } else throw new Error(`The ${name} header must be a string or { secret }`);
      }
      const body = input.body === undefined || input.body === null ? undefined : String(input.body);
      if (body && body.length > MAX) throw new Error("The request body is over 4 MB");
      const started = performance.now();
      const response = await fetch(url, { method: verb, headers, body, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT) }).catch((error) => {
        throw new Error(`Couldn't reach ${host}: ${error instanceof Error ? error.message : error}`);
      });
      const text = await readText(response);
      // An API that echoes the request back would hand the plugin its secret: take every secret used out of the answer.
      const hide = (value: string) => used.reduce((out, name) => out.split(secrets.get(name)!.value).join("[secret]"), value);
      record({ kind: "call", name: `net:${verb} ${host}`, plugin, trace: dispatch.trace, ms: Math.round(performance.now() - started), detail: `${response.status}${used.length ? `, with ${used.join(", ")}` : ""}` });
      return { ok: response.ok, status: response.status, headers: Object.fromEntries([...response.headers].map(([k, v]) => [k, hide(v)])), text: hide(text) };
    },
  };
}
