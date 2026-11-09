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
import { createServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { MessageChannel, Worker } from "node:worker_threads";
import type { Email } from "../seams/index.ts";
import { nodeFiles } from "../seams/node.ts";
import { smtpFromEnv } from "./smtp.ts";
import { accounts } from "./auth/accounts.ts";
import { type Provider, providersFrom } from "./auth/providers.ts";
import { signed } from "./signed.ts";
import { type Accounts, type Decision, frontDoor, type Knock, SPACE, unrouted } from "./front-door.ts";
import { type RouteRequest, type RouteResponse, routeRequest, routeResponse, tooLarge } from "./routes.ts";
import { exportSpace, importSpace, transferRoute } from "./transfer.ts";
import { accept } from "./websocket.ts";
import { MCP_TIMEOUT_MS, mcpAddress, mcpRequest, mcpResponse } from "./mcp.ts";

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
  /** How the server sends the mail server plugins send (src/server/smtp.ts); without it, mail stays in each space's outbox. */
  email?: Email;
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
    mail: async (message) => (options.email ? options.email.send(message) : null),
  });

  /** Spaces whose kernel is stopped while their folder is copied out or in, until it's done. */
  const paused = new Map<string, Promise<void>>();

  /** The space's kernel, started on first use. */
  const space = (name: string): Promise<Worker> => {
    // A space being copied out or in starts once that's done (src/server/transfer.ts).
    const pause = paused.get(name);
    if (pause) return pause.then(() => space(name));
    let started = spaces.get(name);
    if (!started) {
      started = new Promise<Worker>((ready, fail) => {
        const worker = new Worker(resolve(options.kernel), { workerData: { dir: join(resolve(options.spaces), name), origin: url, allowPrivate: options.allowPrivate ?? [], email: !!options.email } });
        worker.on("message", (m) => {
          if (m?.t === "ready") ready(worker);
          // The kernel asks about its members: their email addresses (the only ones its plugins may email) and names.
          // Mail the email module wrote to the outbox, to send.
          if (m?.t === "deliver" && options.email)
            void options.email.send(m.message).then(
              (value) => worker.postMessage({ t: m.t, id: m.id, value }),
              (error) => worker.postMessage({ t: m.t, id: m.id, value: { ok: false, error: String(error?.message ?? error) } }),
            );
          if (m?.t === "addresses" || m?.t === "members") {
            const asked: Promise<unknown> = m.t === "addresses" ? auth.addresses(name) : auth.members(name);
            void asked.then(
              (value) => worker.postMessage({ t: m.t, id: m.id, value }),
              () => worker.postMessage({ t: m.t, id: m.id, value: [] }),
            );
          }
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

  /** A space's folder, where its kernel keeps it. */
  const folderOf = (name: string) => nodeFiles(join(resolve(options.spaces), name, "files"));
  /**
   * Runs `work` on a space's folder with its kernel stopped, so nothing writes to it meanwhile: its clients are
   * disconnected (they connect again by themselves) and anything that needs the kernel waits. The kernel starts
   * again afterwards if it was running, or if `restart` says to. One at a time for each space.
   */
  const withKernelStopped = async <T>(name: string, work: () => Promise<T>, restart: (result: T | undefined) => boolean): Promise<T> => {
    if (paused.has(name)) throw new Error("The space is being copied: try again in a moment");
    let resume!: () => void;
    paused.set(name, new Promise<void>((done) => (resume = done)));
    const running = spaces.get(name);
    let result: T | undefined;
    try {
      if (running) {
        spaces.delete(name);
        for (const [socket, who] of clients) if (who.space === name) socket.close(1012, "The space is restarting");
        await (await running.catch(() => undefined))?.terminate();
      }
      return (result = await work());
    } finally {
      paused.delete(name);
      resume();
      if (running || restart(result)) void space(name).catch(() => {});
    }
  };

  /** Moving a space between hosts (src/server/transfer.ts): its copy out, or a copy in. False for any other request. */
  const transfer = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    // Only these two routes: anything else under /auth/ keeps its body for the accounts.
    if (!/^\/auth\/spaces\/[^/?]+\/(export|import)(\?|$)/.test(request.url ?? "")) return false;
    const url = `${options.origin?.replace(/\/$/, "") ?? `http://${request.headers.host ?? "localhost"}`}${request.url}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
    const answer = await transferRoute(new Request(url, { method: request.method, headers, body, duplex: "half" } as RequestInit), {
      role: async (req, name) => (await auth.member(req, name))?.role ?? null,
      // The kernel stops while the folder is read, so the copy is the folder at one moment.
      exportSpace: (name) => withKernelStopped(name, () => exportSpace(folderOf(name), name), () => false),
      async importSpace(name, copy) {
        // Refused before anything stops; checked again with the kernel stopped, in case it wrote meanwhile.
        if ((await folderOf(name).list("")).length) throw new Error("A copy only goes into an empty space: make a new space for it");
        // Started afterwards, so its server plugins and scheduled jobs run with no one connected.
        return withKernelStopped(name, () => importSpace(folderOf(name), copy), (done) => !!done);
      },
    });
    if (!answer) return false;
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
    return true;
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
  const ask = async (name: string, route: RouteRequest, timeout = 15_000): Promise<RouteResponse | null> => {
    const kernel = await space(name);
    const id = ++routed;
    const answer = (m: { t?: string; id?: number; result?: RouteResponse | null }) => m?.t === "routed" && m.id === id && done(m.result ?? null);
    let done!: (result: RouteResponse | null) => void;
    const result = new Promise<RouteResponse | null>((resolve) => (done = resolve));
    kernel.on("message", answer);
    kernel.postMessage({ t: "route", id, request: route });
    const timer = setTimeout(() => done({ status: 504, text: "The space didn't answer in time" }), timeout);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      kernel.off("message", answer);
    }
  };

  /** The front door's view of a request (src/server/front-door.ts). */
  const knock = (request: IncomingMessage, url: URL): Knock => ({
    method: request.method ?? "GET",
    url,
    origin: typeof request.headers.origin === "string" ? request.headers.origin : null,
    cookie: typeof request.headers.cookie === "string" ? request.headers.cookie : "",
    upgrade: request.headers.upgrade?.toLowerCase() === "websocket",
  });
  const door: Accounts = {
    exists: (space) => auth.exists(space),
    member: async (cookie, space) => (await auth.member(new Request("http://localhost/", { headers: { cookie } }), space))?.user.id ?? null,
  };
  /** Where a page or file request is addressed: this server's public origin, if it has one. */
  const addressOf = (request: IncomingMessage) => new URL(request.url ?? "/", options.origin ?? `http://${request.headers.host ?? "localhost"}`);

  /** A request to /s/<space>/<path> that a server plugin's route answers; false when none does. */
  const publicRoute = async (request: IncomingMessage, response: ServerResponse, at: { space: string; path: string }): Promise<boolean> => {
    const url = addressOf(request);
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

  /** An MCP request from a member's agent (src/server/mcp.ts): false when the address isn't one. */
  const mcp = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    // The front door has already found the space (src/server/front-door.ts).
    const url = addressOf(request);
    const at = mcpAddress(url);
    if (!at) return false;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
    const asked = await mcpRequest(new Request(url, { method: request.method, headers, body, duplex: "half" } as RequestInit), at, auth.agent);
    const answer = asked instanceof Response ? asked : mcpResponse(await ask(at.space, asked, MCP_TIMEOUT_MS));
    // A body refused before it was read (too big, or no key) is still on the connection: close it rather than reuse it.
    if (!request.complete) answer.headers.set("connection", "close");
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
    return true;
  };

  /** Sends what the door decided for a request that isn't the space's socket. */
  const answer = async (request: IncomingMessage, response: ServerResponse, decision: Decision): Promise<void> => {
    // Moving a space (src/server/transfer.ts) is under /auth/ too; anything else there is the accounts'.
    if (decision.door === "auth") return void ((await transfer(request, response)) || (await signIn(request, response)));
    if (decision.door === "route") {
      if (!(await mcp(request, response)) && !(await publicRoute(request, response, decision))) await answer(request, response, unrouted(request.method ?? "GET"));
      return;
    }
    if (decision.door === "asset") return file(request, response);
    // A join comes only on an upgrade (below), and the door refuses one over plain HTTP.
    const refused = decision.door === "refuse" ? decision : { status: 426, text: "Expected a WebSocket" };
    response.writeHead(refused.status, { "content-type": "text/plain; charset=utf-8" }).end(refused.text);
  };

  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = addressOf(request);
    } catch {
      return void response.writeHead(400).end();
    }
    void frontDoor(knock(request, url), door)
      .then((decision) => answer(request, response, decision))
      .catch((error) => {
        console.error(`${request.method} ${request.url}:`, error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });

  /** Open WebSockets, which server.close() would otherwise wait for. */
  const open = new Set<Duplex>();

  server.on("upgrade", async (request, raw: Duplex) => {
    let where: URL;
    try {
      // The Origin a browser sends is the host it reached, so that is what it's checked against.
      where = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      return void raw.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
    const decision = await frontDoor(knock(request, where), door).catch(() => ({ door: "refuse", status: 500, text: "" }) as const);
    if (decision.door !== "join") {
      const status = decision.door === "refuse" ? decision.status : 404;
      return void raw.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n\r\n`);
    }
    const { space: name, member } = decision;
    let kernel: Worker;
    try {
      kernel = await space(name);
    } catch {
      return void raw.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    }
    const socket = accept(request, raw);
    if (!socket) return;
    open.add(raw);
    clients.set(socket, { space: name, user: member });
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
        port1.postMessage(signed(JSON.parse(text), member));
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
  // A space whose plugins scheduled jobs (std/schedule/module.ts) starts now, so they run
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
    email: smtpFromEnv(process.env),
  });
  console.log(`Serving ${arg("site", "dist")} at ${url}; spaces at ${url.replace("http", "ws")}/s/<space>/kernel, kept in ${arg("spaces", ".spaces")}/`);
}
