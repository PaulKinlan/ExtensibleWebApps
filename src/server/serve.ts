// `npm run serve`: the platform on a Node machine. It serves the built site
// (dist/) as Cloudflare does, and runs a kernel for each space that a client
// joins, at ws://<host>/s/<space>/kernel. Each space's kernel is the browser's
// kernel, built for Node (.build/server/space.js), in a worker thread of its
// own, keeping its folder under <spaces>/<space>/.
//
// A client speaks the same messages a tab speaks to its kernel (hello,
// command, event, bye), as JSON. Only a space's members may join it: they
// sign in with a passkey at /auth/ (src/server/auth/accounts.ts).
//
//   node src/server/serve.ts [--port 8787] [--spaces .spaces] [--site dist] [--host 127.0.0.1]

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { MessageChannel, Worker } from "node:worker_threads";
import { nodeFiles } from "../seams/node.ts";
import { accounts } from "./auth/accounts.ts";
import { type Provider, providersFrom } from "./auth/providers.ts";
import { signed } from "./signed.ts";
import { type RouteRequest, type RouteResponse, routeRequest, routeResponse, spaceRoute, tooLarge } from "./routes.ts";
import { accept } from "./websocket.ts";

const SPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export interface Options {
  port: number;
  host: string;
  spaces: string;
  site: string;
  kernel: string;
  /** Other sites to sign in with (src/server/auth/providers.ts); run directly, they come from the environment. */
  providers?: Provider[];
  /** The address people reach this server at, such as https://example.com, when a proxy in front of it speaks HTTPS. */
  origin?: string;
  /**
   * Hosts on the server's own network that server plugins with `network` may reach anyway (a feed served on
   * this machine, in development), by name or IP as a URL writes them. Everything else private is refused
   * (src/server/network-guard.ts).
   */
  allowPrivate?: string[];
}

/** Starts the server; resolves once it is listening, with a way to stop it. */
export async function serve(options: Options): Promise<{ url: string; stop(): Promise<void> }> {
  const site = resolve(options.site);
  const spaces = new Map<string, Promise<Worker>>();
  const rules = headerRules(join(site, "_headers"));
  // Accounts sit beside the spaces, in a folder no space's name can match.
  /** Each open client's space and member, so someone who leaves a space is let go at once. */
  const clients = new Map<{ close(code?: number, reason?: string): void }, { space: string; user: string }>();
  const auth = accounts(nodeFiles(join(resolve(options.spaces), "_accounts")), options.providers ?? [], {
    left(space, user) {
      for (const [socket, who] of clients) if (who.space === space && who.user === user) socket.close(4403, "You're no longer in this space");
    },
  });

  /** The space's kernel, started on first use. */
  const space = (name: string): Promise<Worker> => {
    let started = spaces.get(name);
    if (!started) {
      started = new Promise<Worker>((ready, fail) => {
        const worker = new Worker(resolve(options.kernel), { workerData: { dir: join(resolve(options.spaces), name), origin: url, allowPrivate: options.allowPrivate ?? [] } });
        worker.on("message", (m) => {
          if (m?.t === "ready") ready(worker);
          // The kernel asks for its members' email addresses, the only ones its plugins may email.
          if (m?.t === "addresses")
            void auth.addresses(name).then(
              (addresses) => worker.postMessage({ t: "addresses", id: m.id, addresses }),
              () => worker.postMessage({ t: "addresses", id: m.id, addresses: [] }),
            );
        });
        worker.on("error", (error) => {
          console.error(`Space ${name}:`, error);
          spaces.delete(name);
          fail(error);
        });
        worker.on("exit", () => spaces.delete(name));
      });
      spaces.set(name, started);
    }
    return started;
  };

  /** A file of the built site, as Cloudflare's static assets answer: a folder's index.html, else 404.html. */
  const file = (request: IncomingMessage, response: ServerResponse) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    } catch {
      return void response.writeHead(400).end();
    }
    let full = resolve(site, `.${path}`);
    if (full !== site && !full.startsWith(site + sep)) return void response.writeHead(400).end();
    if (existsSync(full) && statSync(full).isDirectory()) full = join(full, "index.html");
    let status = 200;
    if (!existsSync(full)) {
      full = join(site, "404.html");
      status = 404;
      if (!existsSync(full)) return void response.writeHead(404).end("Not found");
    }
    const headers: Record<string, string> = { "content-type": TYPES[extname(full)] ?? "application/octet-stream" };
    // The site's _headers apply here as on Cloudflare: plugin workers take their policy from them.
    for (const rule of rules) if (rule.path.test(path)) Object.assign(headers, rule.headers);
    response.writeHead(status, headers);
    createReadStream(full).pipe(response);
  };

  /** A request under /auth/, as the web's Request, answered with the accounts' Response. */
  const signIn = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) return void response.writeHead(413).end();
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks);
    const answer = await auth.handle(new Request(`${options.origin?.replace(/\/$/, "") ?? `http://${request.headers.host ?? "localhost"}`}${request.url}`, { method: request.method, headers, body }));
    if (!answer) return void response.writeHead(404).end();
    // Each cookie its own header: joined into one, the browser would read only the first.
    const out: Record<string, string | string[]> = Object.fromEntries([...answer.headers].filter(([name]) => name !== "set-cookie"));
    const cookies = answer.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    response.writeHead(answer.status, out);
    response.end(Buffer.from(await answer.arrayBuffer()));
  };

  let routed = 0;
  /** Asks a space's kernel to answer a public route (src/server/routes.ts): null if no plugin has it. */
  const ask = async (name: string, route: RouteRequest): Promise<RouteResponse | null> => {
    const kernel = await space(name);
    const id = ++routed;
    const answer = (m: { t?: string; id?: number; result?: RouteResponse | null }) => m?.t === "routed" && m.id === id && done(m.result ?? null);
    let done!: (result: RouteResponse | null) => void;
    const result = new Promise<RouteResponse | null>((resolve) => (done = resolve));
    kernel.on("message", answer);
    kernel.postMessage({ t: "route", id, request: route });
    const timer = setTimeout(() => done({ status: 504, text: "The space didn't answer in time" }), 15_000);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      kernel.off("message", answer);
    }
  };

  /** A request to /s/<space>/<path> that a server plugin's route answers; false when none does. */
  const publicRoute = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", options.origin ?? `http://${request.headers.host ?? "localhost"}`);
    const at = spaceRoute(url);
    if (!at || !SPACE.test(at.space) || !(await auth.exists(at.space))) return false;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
    const route = await routeRequest(new Request(url, { method: request.method, headers, body, duplex: "half" } as RequestInit), at.path);
    let answer = route ? null : tooLarge();
    if (route) {
      const result = await ask(at.space, route);
      if (!result) return false;
      answer = routeResponse(result, url, at.space);
    }
    response.writeHead(answer!.status, Object.fromEntries(answer!.headers));
    response.end(request.method === "HEAD" ? undefined : Buffer.from(await answer!.arrayBuffer()));
    return true;
  };

  const server = createServer((request, response) => {
    if (request.url?.startsWith("/auth/")) {
      return void signIn(request, response).catch((error) => {
        console.error("Sign-in:", error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    }
    if (request.url?.startsWith("/s/")) {
      return void publicRoute(request, response)
        .then((answered) => {
          if (answered) return;
          if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end();
          file(request, response);
        })
        .catch((error) => {
          console.error("Route:", error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end();
    file(request, response);
  });

  /** Open WebSockets, which server.close() would otherwise wait for. */
  const open = new Set<Duplex>();

  server.on("upgrade", async (request, raw: Duplex) => {
    let match: RegExpExecArray | null;
    try {
      match = /^\/s\/([^/]+)\/kernel$/.exec(new URL(request.url ?? "/", "http://x").pathname);
    } catch {
      return void raw.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
    if (!match || !SPACE.test(match[1])) return void raw.end("HTTP/1.1 404 Not Found\r\n\r\n");
    // A page on another site may open a WebSocket here (they aren't bound by CORS), so a browser's
    // client must come from this server's own pages. A client that isn't a browser sends no Origin.
    if (!sameOrigin(request.headers.origin, request.headers.host)) return void raw.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    // Only the space's members may join it.
    const cookie = typeof request.headers.cookie === "string" ? request.headers.cookie : "";
    const member = await auth.member(new Request("http://localhost/", { headers: { cookie } }), match[1]).catch(() => null);
    if (!member) return void raw.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    let kernel: Worker;
    try {
      kernel = await space(match[1]);
    } catch {
      return void raw.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    }
    const socket = accept(request, raw);
    if (!socket) return;
    open.add(raw);
    clients.set(socket, { space: match[1], user: member.user.id });
    raw.on("close", () => {
      open.delete(raw);
      clients.delete(socket);
    });
    // One port per client, as a tab gets one; messages cross as JSON.
    const { port1, port2 } = new MessageChannel();
    kernel.postMessage({ t: "connect", port: port2 }, [port2]);
    port1.on("message", (data) => {
      try {
        socket.send(JSON.stringify(data));
      } catch {
        // Something that isn't JSON (a canvas, a port) has no meaning to a remote client.
      }
    });
    socket.onMessage = (text) => {
      try {
        // The kernel learns who this client is from its hello, which only the server may say.
        port1.postMessage(signed(JSON.parse(text), member.user.id));
      } catch {
        socket.close(1007, "JSON only");
      }
    };
    socket.onClose = () => {
      port1.postMessage({ t: "bye" });
      port1.close();
    };
  });

  await new Promise<void>((ready) => server.listen(options.port, options.host, ready));
  const address = server.address();
  const url = `http://${options.host}:${typeof address === "object" && address ? address.port : options.port}`;
  // A space whose plugins scheduled jobs (src/kernel/services/schedule.ts) starts now, so they run
  // with no one connected.
  for (const name of existsSync(resolve(options.spaces)) ? readdirSync(resolve(options.spaces)) : []) {
    if (!SPACE.test(name)) continue;
    try {
      const jobs = JSON.parse(readFileSync(join(resolve(options.spaces), name, "files", "schedule", "jobs.json"), "utf8"));
      if (Array.isArray(jobs) && jobs.length) void space(name).catch(() => {});
    } catch {
      // No jobs.
    }
  }
  return {
    url,
    async stop() {
      server.closeAllConnections();
      for (const raw of open) raw.destroy();
      await new Promise((done) => server.close(done));
      for (const started of spaces.values()) await (await started.catch(() => undefined))?.terminate();
    },
  };
}

/**
 * The rules of a Cloudflare `_headers` file: a path (where `*` matches anything) on a line of its
 * own, then its headers, indented, one `Name: value` to a line. No file, no rules.
 */
export function headerRules(file: string): { path: RegExp; headers: Record<string, string> }[] {
  if (!existsSync(file)) return [];
  const rules: { path: RegExp; headers: Record<string, string> }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      rules.push({ path: new RegExp(`^${pattern}$`), headers: {} });
    } else if (rules.length) {
      const at = line.indexOf(":");
      if (at > 0) rules[rules.length - 1].headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return rules;
}

/** Whether a WebSocket's Origin, if it sent one, is this server (as the client reached it). */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Run directly: read the options and start.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const { url } = await serve({
    port: Number(arg("port", "8787")),
    host: arg("host", "127.0.0.1"),
    spaces: arg("spaces", ".spaces"),
    site: arg("site", "dist"),
    kernel: arg("kernel", ".build/server/space.js"),
    providers: providersFrom(process.env),
    origin: arg("origin", process.env.PUBLIC_ORIGIN ?? "") || undefined,
    allowPrivate: arg("allow-private", process.env.ALLOW_PRIVATE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  });
  console.log(`Serving ${arg("site", "dist")} at ${url}; spaces at ${url.replace("http", "ws")}/s/<space>/kernel, kept in ${arg("spaces", ".spaces")}/`);
}
