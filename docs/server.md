# Servers (phase 2b)

The browser kernel is the source of truth on each device, and an app works with no server at all. Phase 2b adds an optional peer: the same kernel, running on a server, one per **space** (an app shared by a group of people). It syncs with each device, runs server plugins, and answers public routes. The design, with the questions still open, is in the [phase 2b design doc](https://claude.ai/artifact/RSBXjYMixAyeLy8msz6yFg).

It is built in steps, each its own pull request:

1. **Seams and conformance checks**: this step, described below.
2. **Kernel core**: the host-independent parts of `src/kernel/kernel.ts` behind an environment object, shared by a browser entry and a server entry. The store keeps its folder through the `files` seam (`src/seams/opfs.ts` in the browser), and `kernel.ts` reads what differs between hosts (who connects, its origin, its folder, where its errors go) from `src/kernel/env.ts`, which `src/kernel/browser.ts` sets in the browser.
3. **Node host**: `npm run serve`, a space kernel on the Node seams (described below).
4. **Cloudflare host**: a Durable Object per space, with its kernel in a Dynamic Worker of its own (described below). R2 for large files and alarms for the schedule come with the features that need them.
5. **Sign-in and spaces**: passkeys first (described below), then GitHub and other OAuth providers as configuration; sessions and members. A space holds people and data (collections and plugins), and any app can open in it.
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

Options: `node src/server/serve.ts --port 8787 --host 127.0.0.1 --spaces .spaces --site dist`. [`tests/server/run.mjs`](../tests/server/run.mjs) checks it (`npm run test:server`, or `node tests/server/run.mjs node` for this host only), and `npm test` runs those checks too.

## The Cloudflare host

The same site and the same spaces run on Cloudflare: `wrangler.jsonc` points at a Worker, [`src/server/cloudflare/worker.ts`](../src/server/cloudflare/worker.ts), alongside the static assets.

- **Files that exist are served as static assets**, as before. Anything else gets `404.html`.
- **`/s/<space>/kernel` goes to that space's Durable Object, `Space`.** It is the space's supervisor: it holds the clients' WebSockets.
- **The kernel runs in a Dynamic Worker.** The supervisor loads the kernel, built by `npm run build:cloudflare` from [`src/server/cloudflare/kernel.ts`](../src/server/cloudflare/kernel.ts), as a [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) under the space's own id. That gives each space an isolate of its own, as a worker thread does on Node.
- **The kernel's storage is a facet.** The supervisor runs the kernel as a [facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), which has its own SQLite database. That database is the space's folder, through the `files` seam in [`src/seams/durable.ts`](../src/seams/durable.ts).

Two things are different from Node:

- **Messages cross by RPC.** Each client is a call to `join` with a function that sends to its socket, then `deliver` for each message and `leave` at the end. Inside the kernel, each client is still a `MessagePort`, as a tab is.
- **Timers wait while the kernel loads.** Cloudflare runs a module's top level outside any request, where timers aren't allowed, so the timers the kernel sets while loading (the trace's batches, say) start once it has loaded.

`npx wrangler dev` runs all of this on this machine, with no account. [`tests/server/run.mjs`](../tests/server/run.mjs) runs the same checks against Node and against `wrangler dev`. The Durable Object's files seam also passes the seams' conformance checks, on Node's SQLite.

## Sign-in

People sign in with a **passkey**: a key their phone or computer makes for this site and unlocks with a face, a fingerprint or a screen lock. There is no password to remember, reuse or leak. Try it at [`/account/`](/account/) on either host.

- **One module, both hosts.** [`src/server/auth/accounts.ts`](../src/server/auth/accounts.ts) answers every route under `/auth/` with the web's `Request` and `Response`. It keeps accounts on the `files` seam: in `<spaces>/_accounts/` on Node, and in a Durable Object of its own, `Accounts`, on Cloudflare.
- **Passkeys are checked with WebCrypto alone.** [`src/server/auth/webauthn.ts`](../src/server/auth/webauthn.ts) reads what the authenticator sends (a little CBOR), and checks the challenge, the page's origin, the site, and the signature. It accepts ES256, Ed25519 and RS256 keys. It asks for no attestation, so it doesn't care who made the authenticator. No dependency is added.
- **The browser and the server speak WebAuthn's JSON.** The page passes the server's options to `PublicKeyCredential.parseCreationOptionsFromJSON`, and sends back `credential.toJSON()`.
- **A session is a cookie.** It holds a random token that is `HttpOnly` and `SameSite=Lax` (and `Secure` over HTTPS). The server keeps only the token's hash. Every `POST` must come from the site's own origin.

| Route | What it does |
| --- | --- |
| `POST /auth/register/options` | Options for a new passkey. With `{ name }`, it's for a new account; for someone signed in, it's one more passkey on their account. |
| `POST /auth/register` | Checks the new passkey, keeps its public key, and signs in. |
| `POST /auth/signin/options` | Options for signing in with any passkey this site knows. |
| `POST /auth/signin` | Checks the signature (and that the passkey's counter went up, if it keeps one), and signs in. |
| `GET /auth/me` | Who is signed in, or 401. |
| `POST /auth/signout` | Ends this session. |

Signing in doesn't open spaces yet. Spaces with members and invites come next (5b), and production keeps spaces closed until then. After that come GitHub and other providers, as configuration (5c).

[`tests/server/authenticator.mjs`](../tests/server/authenticator.mjs) is a passkey authenticator in software. The server checks use it on both hosts, and also try a used challenge, another page's origin, another site's passkey, a counter that went back, and a forged signature. [`tests/checks/signin.mjs`](../tests/checks/signin.mjs) signs up, out and in on `/account/` in Chromium, with its virtual authenticator.
