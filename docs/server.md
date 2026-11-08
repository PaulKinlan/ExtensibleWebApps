# Servers (phase 2b)

The browser kernel is the source of truth on each device, and an app works with no server at all. Phase 2b adds an optional peer: the same kernel, running on a server, one per **space** (an app shared by a group of people). It syncs with each device, runs server plugins, and answers public routes. The design, with the questions still open, is in the [phase 2b design doc](https://claude.ai/artifact/RSBXjYMixAyeLy8msz6yFg).

It is built in steps, each its own pull request:

1. **Seams and conformance checks**: this step, described below.
2. **Kernel core**: the host-independent parts of `src/kernel/kernel.ts` behind an environment object, shared by a browser entry and a server entry.
3. **Node host**: `npm run serve`, a space kernel on the Node seams.
4. **Cloudflare host**: a Durable Object per space, on DO SQLite, R2, Dynamic Workers and alarms.
5. **Sign-in and spaces**: one OAuth provider, sessions, members.
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
