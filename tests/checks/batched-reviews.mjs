// Batched review cards (src/kernel/review.ts, src/kernel/review-batch.ts):
// when two or more changes from the same plugin and place wait at once, a
// grouped banner offers "Accept all N in <place>" and "Decline all N" above
// the individual diff cards, resolving every waiting write and logging each
// outcome. A single open review never loads or draws the batch banner, and
// each rendered banner revision binds an immutable snapshot of request IDs so
// late-arriving writes stay unapproved and used/stale tokens do nothing.

export default async function ({ a, check, plugin, pluginLog, traceHas }) {
  const before = await a.evaluate(() => window.__host.workers.size);
  try {
    await plugin(`export const manifest = {
  id: 'batch-shelf',
  name: 'Batch shelf',
  permissions: [],
  collections: {
    "batch-items": {
      title: 'Batch items',
      schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', title: 'Title' } } }
    }
  }
};
export default () => {};`);

    await plugin(`export const manifest = {
  id: 'batch-importer',
  name: 'Batch importer',
  permissions: ['ui', 'data:read:batch-items', 'data:write:batch-items']
};
export default (ctx) => {
  ctx.ui.render('devtools', 'controls', {
    type: 'stack',
    direction: 'row',
    children: [
      { type: 'button', label: 'Import one', action: 'one' },
      { type: 'button', label: 'Import three', action: 'three' },
      { type: 'button', label: 'Import two', action: 'two' },
      { type: 'button', label: 'Write w1', action: 'item:w1:One' },
      { type: 'button', label: 'Write w2', action: 'item:w2:Two' },
      { type: 'button', label: 'Write w3', action: 'item:w3:Three' },
      { type: 'button', label: 'Write w4', action: 'item:w4:Four' },
      { type: 'button', label: 'Write w5', action: 'item:w5:Five' },
      { type: 'button', label: 'Write w6', action: 'item:w6:Six' },
      { type: 'button', label: 'List items', action: 'list' },
    ],
  });
  let listSeq = 0;
  ctx.ui.onEvent(async (action) => {
    const put = (id, title) =>
      ctx.call('data', 'put', 'batch-items', { id, title }, 'Import ' + title).then(
        (r) => ({ id, ok: r.ok }),
        (e) => ({ id, ok: false, error: e.message }),
      );
    if (action === 'one') {
      const r = await put('one', 'Solo');
      ctx.log('batch-one ' + JSON.stringify(r));
    } else if (action === 'three') {
      const r = await Promise.all([put('a', 'Alpha'), put('b', 'Beta'), put('c', 'Gamma')]);
      const all = await ctx.call('data', 'list', 'batch-items');
      ctx.log('batch-three ' + JSON.stringify({ results: r, count: all.length, titles: all.map((x) => x.title).sort() }));
    } else if (action === 'two') {
      const r = await Promise.all([put('d', 'Delta'), put('e', 'Epsilon')]);
      const all = await ctx.call('data', 'list', 'batch-items');
      ctx.log('batch-two ' + JSON.stringify({ results: r, count: all.length }));
    } else if (action.startsWith('item:')) {
      const [, id, title] = action.split(':');
      const r = await put(id, title);
      ctx.log('batch-item-' + id + ' ' + JSON.stringify(r));
    } else if (action === 'list') {
      const n = ++listSeq;
      const all = await ctx.call('data', 'list', 'batch-items');
      ctx.log('batch-list-' + n + ' ' + JSON.stringify(all.map((x) => x.id).sort()));
    }
  });
};`);

    const controls = '#devtools [data-key="batch-importer:controls"]';
    const banner = '#review [data-key^="review-batch:"]';
    const cards = '#review [data-key^="review:"]';
    await a.waitForSelector(`${controls} button:has-text("Import one")`, { timeout: 5000 });

    // A single pending review shows only its individual card, never a batch banner.
    await a.click(`${controls} button:has-text("Import one")`);
    await a.waitForSelector(`${cards} >> text=Batch importer wants to change`, { timeout: 5000 });
    await a.waitForTimeout(150);
    check("a single pending review shows no batch banner", (await a.locator(banner).count()) === 0 && (await a.locator(cards).count()) === 1);
    await a.click(`${cards} button:has-text("Accept")`);
    const solo = JSON.parse((await pluginLog("batch-importer", "batch-one ")).slice("batch-one ".length));
    check("accepting the single review resolves its write", solo.ok === true, JSON.stringify(solo));

    const importerWrites = () =>
      a.evaluate(() => window.__host.command("changes").then((list) => list.filter((c) => c.kind === "write" && c.plugin === "batch-importer")));

    // Three concurrent writes to the same collection show the grouped banner alongside all three cards.
    const writesBeforeThree = (await importerWrites()).length;
    await a.click(`${controls} button:has-text("Import three")`);
    await a.waitForSelector(`${banner} button:has-text("Accept all 3 in data:batch-items")`, { timeout: 5000 });
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review:"]').length === 3, null, { timeout: 5000 });
    const layout = await a.evaluate(() => {
      const children = [...document.querySelectorAll("#review > [data-key]")].map((el) => el.dataset.key);
      const text = document.querySelector('#review [data-key^="review-batch:"]')?.textContent ?? "";
      return { children, text };
    });
    check(
      "concurrent writes from one plugin to one place render a grouped summary banner above the individual cards",
      layout.children.length === 4 && layout.children[0].startsWith("review-batch:") && layout.text.includes("Accept all 3 in data:batch-items") && layout.text.includes("Decline all 3"),
      JSON.stringify(layout),
    );

    await a.click(`${banner} button:has-text("Accept all 3 in data:batch-items")`);
    const three = JSON.parse((await pluginLog("batch-importer", "batch-three ")).slice("batch-three ".length));
    await a.waitForSelector('#review [data-key]', { state: "detached", timeout: 5000 });
    check(
      "clicking “Accept all” resolves every waiting write and removes both the banner and all individual cards",
      three.results.length === 3 && three.results.every((r) => r.ok) && three.count === 4 && JSON.stringify(three.titles) === JSON.stringify(["Alpha", "Beta", "Gamma", "Solo"]),
      JSON.stringify(three),
    );

    const loggedAccepts = (await importerWrites()).slice(writesBeforeThree).filter((c) => c.outcome === "allowed-once");
    check(
      "batch accept appends each write outcome to the change log and traces review:batch",
      loggedAccepts.length === 3 && (await traceHas(a, (e) => e.name === "review:batch" && e.plugin === "batch-importer" && /allowed-once \(3 in data:batch-items\)/.test(e.detail ?? ""))),
      JSON.stringify(loggedAccepts),
    );

    // Declining all rejects every pending promise and logs each rejection without writing.
    const writesBeforeTwo = (await importerWrites()).length;
    await a.click(`${controls} button:has-text("Import two")`);
    await a.waitForSelector(`${banner} button:has-text("Decline all 2")`, { timeout: 5000 });
    await a.click(`${banner} button:has-text("Decline all 2")`);
    const two = JSON.parse((await pluginLog("batch-importer", "batch-two ")).slice("batch-two ".length));
    await a.waitForSelector('#review [data-key]', { state: "detached", timeout: 5000 });
    const loggedDeclines = (await importerWrites()).slice(writesBeforeTwo).filter((c) => c.outcome === "rejected");
    check(
      "clicking “Decline all” rejects every waiting write, leaves the collection unchanged, and logs each rejection",
      two.results.length === 2 && two.results.every((r) => !r.ok && /declined/.test(r.error ?? "")) && two.count === 4 && loggedDeclines.length === 2,
      JSON.stringify({ two, loggedDeclines }),
    );

    const trigger = (action) =>
      a.evaluate((act) => {
        document.querySelector(`#devtools [data-key="batch-importer:controls"] button[data-action="${act}"]`)?.click();
      }, action);

    const dispatchReviewAction = (action) =>
      a.evaluate((act) => {
        const el = document.querySelector('#review [data-plugin="review"][data-key]');
        el?.dispatchEvent(new CustomEvent("ui-action", { bubbles: true, composed: true, detail: { action: act } }));
      }, action);

    const hasLog = (prefix) =>
      a.evaluate((p) => window.__host.traces.some((e) => e.plugin === "batch-importer" && e.detail?.startsWith(p)), prefix);

    // Regression (#4556299042): an earlier banner revision token settles ONLY the exact
    // snapshot of IDs shown when it was rendered, leaving a newly arrived 3rd write pending.
    await trigger("item:w1:One");
    await trigger("item:w2:Two");
    await a.waitForSelector(`${banner} button:has-text("Accept all 2 in data:batch-items")`, { timeout: 5000 });
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review:"]').length === 2, null, { timeout: 5000 });
    const t1 = await a.evaluate(() => ({
      accept: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="accept-batch:"]')?.getAttribute("data-action") ?? "",
      decline: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="decline-batch:"]')?.getAttribute("data-action") ?? "",
    }));

    // 3rd write arrives after the 2-item banner was rendered, rotating the banner to a new revision token t2.
    await trigger("item:w3:Three");
    await a.waitForSelector(`${banner} button:has-text("Accept all 3 in data:batch-items")`, { timeout: 5000 });
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review:"]').length === 3, null, { timeout: 5000 });
    const t2 = await a.evaluate(() => ({
      accept: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="accept-batch:"]')?.getAttribute("data-action") ?? "",
      decline: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="decline-batch:"]')?.getAttribute("data-action") ?? "",
    }));

    check(
      "each rendered batch banner allocates a fresh monotonic snapshot token",
      /^accept-batch:\d+$/.test(t1.accept) &&
        /^decline-batch:\d+$/.test(t1.decline) &&
        /^accept-batch:\d+$/.test(t2.accept) &&
        t2.accept !== t1.accept &&
        t2.decline !== t1.decline,
      JSON.stringify({ t1, t2 }),
    );

    // Firing the earlier t1 accept action settles ONLY w1 and w2 while w3 stays pending and unapproved.
    await dispatchReviewAction(t1.accept);
    const rW1 = JSON.parse((await pluginLog("batch-importer", "batch-item-w1 ")).slice("batch-item-w1 ".length));
    const rW2 = JSON.parse((await pluginLog("batch-importer", "batch-item-w2 ")).slice("batch-item-w2 ".length));
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review-batch:"]').length === 0 && document.querySelectorAll('#review [data-key^="review:"]').length === 1, null, { timeout: 5000 });
    await a.waitForTimeout(150);
    const w3SettledEarly = await hasLog("batch-item-w3 ");
    await trigger("list");
    const idsAfterT1 = JSON.parse((await pluginLog("batch-importer", "batch-list-1 ")).slice("batch-list-1 ".length));
    check(
      "accept-batch:<t1> settles only [w1, w2] and leaves newly arrived w3 pending and unapproved",
      rW1.ok === true &&
        rW2.ok === true &&
        !w3SettledEarly &&
        idsAfterT1.includes("w1") &&
        idsAfterT1.includes("w2") &&
        !idsAfterT1.includes("w3") &&
        (await a.locator(banner).count()) === 0 &&
        (await a.locator(cards).count()) === 1,
      JSON.stringify({ rW1, rW2, w3SettledEarly, idsAfterT1 }),
    );

    // Explicitly declining w3's individual card settles w3 now.
    await a.click(`${cards} button:has-text("Decline")`);
    const rW3 = JSON.parse((await pluginLog("batch-importer", "batch-item-w3 ")).slice("batch-item-w3 ".length));
    await a.waitForSelector('#review [data-key]', { state: "detached", timeout: 5000 });
    check("late-arriving w3 settles only when explicitly reviewed", rW3.ok === false && /declined/.test(rW3.error ?? ""), JSON.stringify(rW3));

    // Replaying used/stale tokens on a subsequent batch [w4, w5] does nothing; decline-batch:<t3> also snapshots IDs.
    await trigger("item:w4:Four");
    await trigger("item:w5:Five");
    await a.waitForSelector(`${banner} button:has-text("Accept all 2 in data:batch-items")`, { timeout: 5000 });
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review:"]').length === 2, null, { timeout: 5000 });
    const t3 = await a.evaluate(() => ({
      accept: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="accept-batch:"]')?.getAttribute("data-action") ?? "",
      decline: document.querySelector('#review [data-key^="review-batch:"] button[data-action^="decline-batch:"]')?.getAttribute("data-action") ?? "",
    }));

    for (const stale of [t1.accept, t1.decline, t2.accept, t2.decline]) await dispatchReviewAction(stale);
    await a.waitForTimeout(150);
    const w4OrW5SettledByStale = (await hasLog("batch-item-w4 ")) || (await hasLog("batch-item-w5 "));
    check(
      "replaying a used or superseded batch token on a subsequent batch does nothing",
      t3.accept !== t1.accept &&
        t3.accept !== t2.accept &&
        !w4OrW5SettledByStale &&
        (await a.locator(banner).count()) === 1 &&
        (await a.locator(cards).count()) === 2,
      JSON.stringify({ t3, w4OrW5SettledByStale }),
    );

    // Verify decline-batch:<t3> also settles only [w4, w5] when w6 arrives afterwards.
    await trigger("item:w6:Six");
    await a.waitForSelector(`${banner} button:has-text("Decline all 3")`, { timeout: 5000 });
    await dispatchReviewAction(t3.decline);
    const rW4 = JSON.parse((await pluginLog("batch-importer", "batch-item-w4 ")).slice("batch-item-w4 ".length));
    const rW5 = JSON.parse((await pluginLog("batch-importer", "batch-item-w5 ")).slice("batch-item-w5 ".length));
    await a.waitForFunction(() => document.querySelectorAll('#review [data-key^="review-batch:"]').length === 0 && document.querySelectorAll('#review [data-key^="review:"]').length === 1, null, { timeout: 5000 });
    const w6SettledEarly = await hasLog("batch-item-w6 ");
    await a.click(`${cards} button:has-text("Accept")`);
    const rW6 = JSON.parse((await pluginLog("batch-importer", "batch-item-w6 ")).slice("batch-item-w6 ".length));
    await a.waitForSelector('#review [data-key]', { state: "detached", timeout: 5000 });
    check(
      "decline-batch:<t3> settles only [w4, w5] and leaves newly arrived w6 pending until reviewed",
      !rW4.ok && !rW5.ok && !w6SettledEarly && rW6.ok === true,
      JSON.stringify({ rW4, rW5, w6SettledEarly, rW6 }),
    );
  } finally {
    for (const id of ["batch-importer", "batch-shelf"]) await a.evaluate((i) => window.__host.command("uninstall", i), id).catch(() => {});
    await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 }).catch(() => {});
  }
}
