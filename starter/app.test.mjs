// In-memory tests for the starter app (`npm test` runs `extensible-app test`):
// boots the kernel against memory storage, runs main.js in a worker thread,
// and checks adding, ticking off and removing items without a browser.

import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "extensible-web-apps/test";

const APP_DIR = dirname(fileURLToPath(import.meta.url));

test("adds, ticks off and removes items", async () => {
  const app = await createTestHarness(APP_DIR);
  try {
    assert.match(app.html("main"), /Nothing yet/);

    const first = await app.put("my-app-items", { title: "Passport" });
    const second = await app.put("my-app-items", { title: "Adapter" });
    assert.equal(first.ok && second.ok, true);

    // Undone items sort alphabetically.
    assert.deepEqual(
      app.view("main").data.items.map((i) => i.title),
      ["Adapter", "Passport"],
    );

    // Ticking "Adapter" marks it done and moves it after undone items.
    await app.act("my-app", `done:${second.id}`, true);
    assert.deepEqual(
      app.view("main").data.items.map((i) => [i.title, Boolean(i.done)]),
      [
        ["Passport", false],
        ["Adapter", true],
      ],
    );
    assert.match(app.html("main"), /data-done/);

    // Removing both items returns the view to its empty state.
    await app.act("my-app", `remove:${first.id}`);
    await app.act("my-app", `remove:${second.id}`);
    assert.equal((await app.list("my-app-items")).length, 0);
    assert.match(app.html("main"), /Nothing yet/);
  } finally {
    await app.close();
  }
});
