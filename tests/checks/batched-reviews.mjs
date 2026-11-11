// Batched review cards (src/kernel/review.ts, src/kernel/review-batch.ts):
// when two or more changes from the same plugin and place wait at once, a
// grouped banner offers "Accept all N in <place>" and "Decline all N" above
// the individual diff cards, resolving every waiting write and logging each
// outcome. A single open review never loads or draws the batch banner.

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
    ],
  });
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

    // Three concurrent writes to the same collection show the grouped banner alongside all three cards.
    const changesBeforeThree = (await a.evaluate(() => window.__host.command("changes"))).length;
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

    const changesAfterThree = (await a.evaluate(() => window.__host.command("changes"))).slice(changesBeforeThree);
    const loggedAccepts = changesAfterThree.filter((c) => c.kind === "write" && c.plugin === "batch-importer" && c.outcome === "allowed-once");
    check(
      "batch accept appends each write outcome to the change log and traces review:batch",
      loggedAccepts.length === 3 && (await traceHas(a, (e) => e.name === "review:batch" && e.plugin === "batch-importer" && /allowed-once \(3 in data:batch-items\)/.test(e.detail ?? ""))),
      JSON.stringify(loggedAccepts),
    );

    // Declining all rejects every pending promise and logs each rejection without writing.
    const changesBeforeTwo = (await a.evaluate(() => window.__host.command("changes"))).length;
    await a.click(`${controls} button:has-text("Import two")`);
    await a.waitForSelector(`${banner} button:has-text("Decline all 2")`, { timeout: 5000 });
    await a.click(`${banner} button:has-text("Decline all 2")`);
    const two = JSON.parse((await pluginLog("batch-importer", "batch-two ")).slice("batch-two ".length));
    await a.waitForSelector('#review [data-key]', { state: "detached", timeout: 5000 });
    const changesAfterTwo = (await a.evaluate(() => window.__host.command("changes"))).slice(changesBeforeTwo);
    const loggedDeclines = changesAfterTwo.filter((c) => c.kind === "write" && c.plugin === "batch-importer" && c.outcome === "rejected");
    check(
      "clicking “Decline all” rejects every waiting write, leaves the collection unchanged, and logs each rejection",
      two.results.length === 2 && two.results.every((r) => !r.ok && /declined/.test(r.error ?? "")) && two.count === 4 && loggedDeclines.length === 2,
      JSON.stringify({ two, loggedDeclines }),
    );
  } finally {
    for (const id of ["batch-importer", "batch-shelf"]) await a.evaluate((i) => window.__host.command("uninstall", i), id).catch(() => {});
    await a.waitForFunction((n) => window.__host.workers.size === n, before, { timeout: 5000 }).catch(() => {});
  }
}
