# Servers (phase 2b)

The browser kernel is the source of truth on each device, and an app works with no server at all. Phase 2b adds an optional peer: the same kernel, running on a server, one per **space** (an app shared by a group of people). It syncs with each device, runs server plugins, and answers public routes. The design, with the questions still open, is in the [phase 2b design doc](https://claude.ai/artifact/RSBXjYMixAyeLy8msz6yFg).

It is built in steps, each its own pull request:

1. **Seams and conformance checks**: this step, described below.
2. **Kernel core**: the host-independent parts of `src/kernel/kernel.ts` behind an environment object, shared by a browser entry and a server entry. The store keeps its folder through the `files` seam (`src/seams/opfs.ts` in the browser), and `kernel.ts` reads what differs between hosts (who connects, its origin, its folder, where its errors go) from `src/kernel/env.ts`, which `src/kernel/browser.ts` sets in the browser.
3. **Node host**: `npm run serve`, a space kernel on the Node seams (described below).
4. **Cloudflare host**: a Durable Object per space, on DO SQLite, R2, Dynamic Workers and alarms.
5. **Sign-in and spaces**: passkeys first, then GitHub and other OAuth providers as configuration; sessions and members. A space holds people and data (collections and plugins), and any app can open in it.
6. **Sync**: a tab joins a space, and still works offline.
7. **Server plugins**: `runs`, `http.route`, `schedule`, `email`, and `data:beforeWrite` on the server.
8. **Proof apps**: a survey builder and a feed reader.

## Seams

Everything a space kernel needs from the machine it runs on is a **seam**: one small interface in [`src/seams/index.ts`](../src/seams/index.ts). Each host provides every seam, and a space's config can mix providers. Plugins never see a seam. They call services through the gate, and the kernel calls the seams.

| Seam | What it does | Memory (tests) | Node | Cloudflare (step 4) |
| --- | --- | --- | --- | --- |
| `files` | The kernel's folder: plugins, their files, settings | a Map | a folder | DO SQLite, R2 for large files |
| `records` | Collections, versions, and the ordered change log | Maps | a SQLite file (`node:sqlite`) | DO SQLite |
| `schedule` | Wake the space later, even after a restart | timers | timers + `schedule.json` | DO alarms |
| `secrets` | Keys only the kernel reads | an object | an env file | Worker secrets |
| `email` | Send mail | written down | an outbox folder (SMTP later) | Cloudflare Email |

Two seams come with their hosts: `isolate` (where server plugins run) in step 3, and `auth` in step 5.

### Records and the change log

A space orders every change. `put(collection, id, value, base)` takes `base`, the version the writer last saw (0 means "it shouldn't exist yet"):

- If `base` is the current version, the write is accepted. It gets the next sequence number, which is also the record's new version.
- If it isn't, the write is refused as `{ ok: false, stale: true, current }`. The writer shows the newer record and keeps its own as a draft.
- `changes(since)` returns every accepted change after a sequence number, so a device that was offline catches up.

This is how sync works until 2c brings CRDTs for live editing.

### Checks every provider passes

[`tests/seams/run.mjs`](../tests/seams/run.mjs) runs the same checks against every provider: what is written reads back, paths (and links) can't leave the folder, stale writes are refused, the change log is complete and ordered, jobs run once, survive a restart and catch up once after one, a failing job doesn't stop the rest, and email refuses what isn't an address. Run them with `npm run test:seams`. `npm test` runs them too.

The seams live in `src/seams/`, beside the browser code rather than under `src/server/`, because the browser kernel uses them too: its folder moves onto the `files` seam when the kernel core is shared (step 2). Server code is TypeScript that Node runs as it is (Node strips the types), so there is no build step on the server either. Imports name their `.ts` files, and `tsconfig.server.json` checks the server and the seams with Node's types: `npm run typecheck` checks both halves.

## The Node host

`npm run serve` builds the site and a space's kernel, then serves both on this machine:

- The built site (`dist/`), the way Cloudflare's static assets serve it: a folder's `index.html`, and `404.html` for a path that isn't there.
- A kernel for each space a client joins, at `ws://127.0.0.1:8787/s/<space>/kernel`. Each one is the browser's kernel (`src/kernel/kernel.ts`), built for Node by Vite (`npm run build:server`, into `.build/server/space.js`) and started in a worker thread of its own. Its folder is `.spaces/<space>/`, through the Node `files` seam.

A client speaks the messages a tab speaks to its kernel (`hello`, `command`, `event`, `bye`), as JSON over the WebSocket ([`src/server/websocket.ts`](../src/server/websocket.ts) is the server's side, with no dependency). For example, after `hello`, `{ "t": "command", "id": 1, "name": "user:list", "arg": { "app": "demos/contacts" } }` answers with the plugins the space keeps for that app.

What isn't there yet:

- **Plugins don't run on the server.** On a server no client starts plugin workers. The `isolate` seam does that, with server plugins (step 7).
- **No sign-in.** The server listens only on `127.0.0.1` until sign-in and members arrive (step 5).
- **Tabs don't sync with a space yet.** That's step 6.

Options: `node src/server/serve.ts --port 8787 --host 127.0.0.1 --spaces .spaces --site dist`. [`tests/server/run.mjs`](../tests/server/run.mjs) checks it (`npm run test:server`), and `npm test` runs those checks too.
