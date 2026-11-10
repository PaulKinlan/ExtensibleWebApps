// Making an app from a description (std/maker/): on /new/, the person asks
// for "a reading list with a Sunday reminder", and the app maker writes the
// page and its plugins, saved after one review card. Its first try has a bug
// that only shows as the app runs; the check finds it in the preview, and the
// agent saves a fix. A follow-up, "add a rating", changes the app through
// another card; an earlier version of a file can be put back. Then, with no
// model and no app maker anywhere, the app still runs in a tab of its own. A
// scripted model, added as the person's own plugin for /new/, stands in for
// theirs.

/** The scripted model. Sent as a plugin's source, so everything it needs is inside it. */
function model(ctx) {
  const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reading list</title>
  <link rel="stylesheet" href="/platform/host.css">
  <script type="module" src="/platform/host.js"></script>
  <link rel="plugin" href="books.js">
  <link rel="plugin" href="reminder.js">
</head>
<body>
  <header><h1>Reading list</h1></header>
  <main><slot name="notice"></slot><slot name="main"><p>Loading…</p></slot></main>
</body>
</html>`;
  const books = (rating) => `export const manifest = {
  id: "reading-list-books",
  name: "Books",
  description: "The books, with a form to add one and a table of them all.",
  version: "1.0.0",
  permissions: ["ui"],
  collections: {
    "reading-list-books": {
      title: "Books",
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title" },
          author: { type: "string" },
          shelf: { type: "string", enum: ["to read", "reading", "done"], default: "to read" },${rating ? '\n          rating: { type: "integer", minimum: 1, maximum: 5, title: "Rating" },' : ""}
        },
      },
    },
  },
};

export default function (ctx) {
  ctx.ui.views("books.html").render("main", "books", {});
}`;
  const booksHtml = (rating) => `<template id="books">
  <ui-card><h2>Add a book</h2><ui-form collection="reading-list-books" fields="title,author,shelf${rating ? ",rating" : ""}" submit="Add book"></ui-form></ui-card>
  <ui-table collection="reading-list-books" columns="title,author,shelf${rating ? ",rating" : ""}" sort="title" deletable empty="No books yet."></ui-table>
</template>`;
  // The first try calls a function by the wrong name: nothing a check of the files can see, only running it.
  const reminder = (typo) => `export const manifest = {
  id: "reading-list-reminder",
  name: "Sunday reminder",
  description: "Reminds you every Sunday to pick your next book.",
  version: "1.0.0",
  permissions: ["ui", "schedule"],
};

export default function (ctx) {
  const views = ctx.ui.views("reminder.html");
  const nextSunday = (from) => {
    const d = new Date(from);
    d.setHours(9, 0, 0, 0);
    d.setDate(d.getDate() + ((7 - from.getDay()) % 7 || (from.getHours() >= 9 ? 7 : 0)));
    return d;
  };
  const draw = () => {
    const now = new Date();
    views.render("notice", "reminder", { today: now.getDay() === 0, next: ${typo ? "nextSundy" : "nextSunday"}(now).toDateString() });
  };
  ctx.schedule.at("sunday", nextSunday(new Date()).getTime(), draw);
  draw();
}`;
  const reminderHtml = `<template id="reminder">
  <template if="today"><ui-card tone="accent"><p>It's Sunday: pick your next book.</p></ui-card></template>
  <template if="!today"><p class="next">Next reminder: Sunday, {{next}}</p></template>
</template>`;
  const files = [
    { name: "app.html", text: PAGE },
    { name: "books.js", text: books(false) },
    { name: "books.html", text: booksHtml(false) },
    { name: "reminder.js", text: reminder(true) },
    { name: "reminder.html", text: reminderHtml },
  ];

  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "fake-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", async (request) => {
    if (request.provider !== "fake-model") return;
    const last = request.messages.at(-1);
    const first = String(request.messages[0].content);
    const usage = { input: 10, output: 2 };
    const tools = request.messages.filter((m) => m.role === "tool").map((m) => m.name);
    const call = (name, args) => ({ text: "", toolCalls: [{ id: `c${request.messages.length}`, name, args }], stop: "tool", usage });
    ctx.log("model-asked " + JSON.stringify({ system: request.system.slice(0, 40), tools: request.tools.map((t) => t.name).sort(), last: last.role === "tool" ? { name: last.name, content: String(last.content).slice(0, 600) } : null }));
    if (!request.system.startsWith("You make small web apps")) return { text: "Nothing to do.", stop: "end", usage };
    if (first.includes("Sunday reminder")) {
      if (!last.name) return call("maker_list", {});
      if (last.name === "maker_list") return call("maker_save", { app: "reading-list", files, note: "A reading list, and a reminder every Sunday" });
      if (last.name === "maker_save" && tools.filter((t) => t === "maker_check").length === 0) return call("maker_check", { app: "reading-list" });
      if (last.name === "maker_check" && !String(last.content).includes('"ok":true')) {
        return call("maker_save", { app: "reading-list", files: [{ name: "reminder.js", text: reminder(false) }], note: "Fix the reminder: it called nextSundy" });
      }
      if (last.name === "maker_save") return call("maker_check", { app: "reading-list" });
      return { text: `Made it: /apps/reading-list/. The check said: ${String(last.content).slice(0, 200)}`, stop: "end", usage };
    }
    if (first.includes("add a rating")) {
      if (!last.name) return call("maker_read", { app: "reading-list", file: "books.js" });
      if (last.name === "maker_read") return call("maker_save", { app: "reading-list", files: [{ name: "books.js", text: books(true) }, { name: "books.html", text: booksHtml(true) }], note: "A rating from 1 to 5 for each book" });
      return { text: `Added a rating. ${String(last.content).slice(0, 120)}`, stop: "end", usage };
    }
    if (first.includes("a page with a script")) {
      if (!last.name) return call("maker_save", { app: "sneaky", files: [{ name: "app.html", text: PAGE.replace("</head>", "<script>alert(1)</script></head>") }] });
      return { text: `Saving answered: ${String(last.content).slice(0, 300)}`, stop: "end", usage };
    }
    return { text: "Nothing to do.", stop: "end", usage };
  });
}
const MODEL = `export const manifest = { id: "fake-model", name: "Scripted model", permissions: ["provide:llm"] };\nexport default ${model.toString()};`;

export default async function ({ check, openTab, context, URL }) {
  const page = await openTab(`${URL}new/`);
  const review = '[data-key^="review:"]';
  const make = '[data-key^="your-apps@"][data-key$=":make"]';
  const yours = '[data-key^="your-apps@"][data-key$=":apps"]';
  const seen = (selector, timeout = 10000, on = page) => on.waitForSelector(selector, { timeout }).then(() => true, () => false);
  const accept = async (text) => {
    const card = await seen(`${review} >> text=${text}`, 15000);
    if (card) await page.click(`${review} >> text="Accept"`);
    return card;
  };
  const preview = () => page.frameLocator(`${yours} ui-preview >> iframe`);
  const inPreview = (selector, timeout = 15000) => preview().locator(selector).first().waitFor({ timeout }).then(() => true, () => false);
  const ask = async (text, target = "") => {
    await page.selectOption(`${make} select[name="app"]`, target);
    await page.fill(`${make} textarea[name="text"]`, text);
    await page.click(`${make} button[type="submit"]`);
  };
  try {
    await page.waitForSelector(`${make} textarea`, { timeout: 10000 });
    await page.evaluate((data) => window.__host.command("user:add", { app: "new", files: [{ name: "fake-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "new", id: "fake-model" }));
    await page.waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:ready" && e.plugin?.startsWith("fake-model")), null, { timeout: 10000 }).catch(() => {});

    // Make it.
    await ask("A reading list with a Sunday reminder");
    check("making an app shows every file on one review card first", await accept("makes Reading list, at /apps/reading-list/, with app.html, books.js, books.html, reminder.js, reminder.html"));
    // The review card is on screen as soon as the maker asks to save, but the trace reaches the page in batches, so
    // the model's turns may not be here yet: wait for the maker's first turn before reading what it was offered.
    await page
      .waitForFunction(() => window.__host.traces.some((e) => e.plugin === "fake-model" && e.detail?.startsWith('model-asked {"system":"You make small web apps')), null, { timeout: 10000 })
      .catch(() => {});
    const turns = await page.evaluate(() => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked")).map((e) => JSON.parse(e.detail.slice(12))));
    const tools = turns.find((t) => t.system.startsWith("You make small web apps"))?.tools ?? [];
    check("the app maker's tools are the maker's, not the data's or the authoring service's", ["maker_check", "maker_list", "maker_read", "maker_save"].every((t) => tools.includes(t)) && !tools.some((t) => /^(data_(list|get|put|delete)|authoring_)/.test(t)), tools.join(" ") || `no maker turn in the trace (${turns.length} model turns)`);
    check("the app maker sees the bug only running the app shows, and saves a fix after a second card", await accept("changes reminder.js"));
    check("the app maker says where the app is", await seen(`${make} >> text=Made it: /apps/reading-list/`, 20000));
    // The trace reaches the page in batches, so the chat can say "Made it" before the last model turn's trace is here: wait for both checks.
    const checks = () =>
      window.__host.traces
        .filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked"))
        .map((e) => JSON.parse(e.detail.slice(12)).last)
        .filter((l) => l?.name === "maker_check")
        .map((l) => l.content);
    await page
      .waitForFunction(() => window.__host.traces.filter((e) => e.plugin === "fake-model" && e.detail?.includes('"name":"maker_check"')).length >= 2, null, { timeout: 5000 })
      .catch(() => {});
    const checked = await page.evaluate(checks);
    check("the first check ran the app in the preview and named the failing file", /"ran":true/.test(checked[0] ?? "") && /reminder\.js/.test(checked[0] ?? "") && /nextSundy/.test(checked[0] ?? ""), (checked[0] ?? "no check").slice(0, 300));
    check("after the fix, the check passes", /"ok":true/.test(checked[1] ?? ""), (checked[1] ?? "no second check").slice(0, 300));
    check("the preview runs the app: the books form, from the collection's schema", await inPreview('[data-key="reading-list-books:books"] ui-form'));
    check("the preview runs the fixed reminder", await inPreview('[data-key="reading-list-reminder:reminder"] >> text=/Next reminder|It\'s Sunday/'));
    check("each file keeps its versions: the reminder has two", await seen(`${yours} li:has(code:text-is("reminder.js")) >> text=2 versions`));

    // Change it, with the app also open in a tab of its own.
    const other = await context.newPage();
    await other.goto(`${URL}apps/reading-list/`);
    const otherReady = await seen('[data-key="reading-list-books:books"] ui-form', 15000, other);
    await ask("add a rating", "reading-list");
    check("a follow-up change goes through a review card", await accept("your app Reading list: changes books.js, books.html"));
    const rated = await inPreview('[data-key="reading-list-books:books"] ui-form >> [name="rating"]', 20000);
    if (!rated && process.env.DEBUG_MAKER) console.log(await page.evaluate(() => window.__host.traces.filter((e) => /app:open|plugin:failed|refused|error/.test(e.name + e.kind)).slice(-15).map((e) => `${e.kind} ${e.name} ${e.plugin ?? ""} ${e.detail ?? ""}`).join("\n")), await preview().locator("body").innerHTML().catch((e) => String(e)));
    check("the change shows in the preview: a rating field", rated);
    check("another tab with the app open runs the new code without a reload", otherReady && (await seen('[data-key="reading-list-books:books"] ui-form >> [name="rating"]', 15000, other)));
    await other.close();

    // Go back to an earlier version.
    await page.click(`${yours} li:has(code:text-is("books.js")) button[data-action="history"]`);
    await page.click(`${yours} li:has(code:text-is("books.js")) button[data-action="restore:books.js:1"]`);
    check("putting an earlier version back is reviewed too", await accept("your app Reading list: restores an earlier books.js"));
    check("the restored version is the newest, so it can be undone the same way", (await seen(`${yours} li:has(code:text-is("books.js")) >> text=3 versions`)));

    // A page with a script of its own is refused before the person is asked.
    await ask("a page with a script");
    check("a page with a script of its own is refused, with the rule it broke", await seen(`${make} >> text=/only script a page may have/`, 15000));

    // The service worker won't serve such a page, even if it got into the folder some other way.
    await page.evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ["made", "apps", "planted"]) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle("app.html", { create: true })).createWritable();
      await w.write('<!doctype html><script type="module" src="/platform/host.js"></script><img src=x onerror="document.title=1">');
      await w.close();
    });
    const planted = await page.evaluate(async () => {
      const r = await fetch("/apps/planted/", { mode: "same-origin" });
      return `${r.status} ${await r.text()}`;
    });
    check("the service worker refuses a made page that breaks the rules", planted.startsWith("500") && /onerror/.test(planted), planted.slice(0, 120));

    // A repeated attribute can't sneak a second script past the rules: browsers keep the first value.
    const repeated = await page.evaluate(async () => {
      const { pageProblems } = await import("/sw/made-page.js");
      return pageProblems('<!doctype html><head><script type="module" src="payload.js" src="/platform/host.js"></script></head>').map((p) => p.message);
    });
    check("a page that names a script's src twice is refused", repeated.some((m) => /more than once/.test(m)), repeated.join(" | "));

    // With no model and no app maker running anywhere, the app still works on its own.
    await page.close();
    const alone = await context.newPage();
    await alone.goto(`${URL}apps/reading-list/`);
    await alone.waitForFunction(() => window.__host, null, { timeout: 10000 }).catch(() => {});
    check("with the model and the app maker gone, the made app runs on its own", await seen('[data-key="reading-list-books:books"] ui-form', 15000, alone));
    check("…with its reminder", await seen('[data-key="reading-list-reminder:reminder"]', 10000, alone));
    const running = await alone.evaluate(() => window.__host.command("plugins")).catch(() => null);
    const ids = JSON.stringify(running ?? "");
    check("nothing of the model or the app maker is running for it", !/fake-model|app-maker/.test(ids) || running === null, ids.slice(0, 200));
    const html = await alone.evaluate(() => document.documentElement.outerHTML);
    check("its page links no model and no agent", !/rel="agent"|\/std\/llm\//.test(html));
    await alone.close();
  } finally {
    if (!page.isClosed()) await page.close();
  }
}
