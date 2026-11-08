// `npm run serve`: the platform on a Node machine. It serves the built site
// (dist/) as Cloudflare does, and runs a kernel for each space that a client
// joins, at ws://<host>/s/<space>/kernel. Each space's kernel is the browser's
// kernel, built for Node (.build/server/space.js), in a worker thread of its
// own, keeping its folder under <spaces>/<space>/.
//
// A client speaks the same messages a tab speaks to its kernel (hello,
// command, event, bye), as JSON. Sign-in comes later (step 5 of
// docs/server.md), so for now the server listens only on this machine.
//
//   node src/server/serve.ts [--port 8787] [--spaces .spaces] [--site dist] [--host 127.0.0.1]

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
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
}

/** Starts the server; resolves once it is listening, with a way to stop it. */
export async function serve(options: Options): Promise<{ url: string; stop(): Promise<void> }> {
  const site = resolve(options.site);
  const spaces = new Map<string, Promise<Worker>>();

  /** The space's kernel, started on first use. */
  const space = (name: string): Promise<Worker> => {
    let started = spaces.get(name);
    if (!started) {
      started = new Promise<Worker>((ready, fail) => {
        const worker = new Worker(resolve(options.kernel), { workerData: { dir: join(resolve(options.spaces), name), origin: url } });
        worker.on("message", (m) => m?.t === "ready" && ready(worker));
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
    response.writeHead(status, { "content-type": TYPES[extname(full)] ?? "application/octet-stream" });
    createReadStream(full).pipe(response);
  };

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end();
    file(request, response);
  });

  server.on("upgrade", async (request, raw) => {
    const match = /^\/s\/([^/]+)\/kernel$/.exec(new URL(request.url ?? "/", "http://x").pathname);
    if (!match || !SPACE.test(match[1])) return void raw.end("HTTP/1.1 404 Not Found\r\n\r\n");
    let kernel: Worker;
    try {
      kernel = await space(match[1]);
    } catch {
      return void raw.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    }
    const socket = accept(request, raw);
    if (!socket) return;
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
        port1.postMessage(JSON.parse(text));
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
  return {
    url,
    async stop() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      for (const started of spaces.values()) await (await started.catch(() => undefined))?.terminate();
    },
  };
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
  });
  console.log(`Serving ${arg("site", "dist")} at ${url}; spaces at ${url.replace("http", "ws")}/s/<space>/kernel, kept in ${arg("spaces", ".spaces")}/`);
}
