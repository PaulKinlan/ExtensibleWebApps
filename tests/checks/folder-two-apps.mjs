// The folder service's one folder per app (std/folder/module.ts) when two
// apps link the same plugin: one copy of the plugin serves both. A call made
// while handling a click uses the folder of the app that was clicked in; a
// call that doesn't say which tab it is for fails, rather than guess and
// read or write the other app's files.
//
// The two apps are made apps (sw/routes/made.js) written straight into the
// browser's private file system: /apps/fold-one/ and /apps/fold-two/, both
// linking /apps/fold-one/shared.js.

const page = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/platform/host.css"><script type="module" src="/platform/host.js"></script><link rel="plugin" href="/apps/fold-one/shared.js"></head><body><main><slot name="main"></slot></main></body></html>`;

const SHARED = `export const manifest = {
  id: "folder-two-apps",
  name: "Folder in two apps",
  version: "1.0.0",
  permissions: ["ui", "folder:read"],
  services: ["folder"],
};

export default function (ctx) {
  const tryIt = (p) => p.then((v) => "ok " + JSON.stringify(v), (e) => "no " + e.message);
  ctx.ui.render("main", "which", { type: "button", label: "Which folder", action: "which" });
  ctx.ui.onEvent(async (action, value) => {
    const here = ctx.traced();
    const traced = await tryIt(here.call("folder", "list"));
    // After an await the click's trace is gone: this call doesn't say which tab it is for.
    const untraced = await tryIt(ctx.call("folder", "list"));
    here.log("which " + JSON.stringify({ traced, untraced }));
  });
}
`;

export default async function ({ check, openTab, URL }) {
  const one = await openTab(URL);
  // The apps, and a file in each app's private folder (.folders/<app with ~ for />), so a listing says whose it is.
  await one.evaluate(
    async ([pages, shared]) => {
      const root = await navigator.storage.getDirectory();
      const write = async (path, body) => {
        const parts = path.split("/");
        let dir = root;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
        const out = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await out.write(body);
        await out.close();
      };
      await write("made/apps/fold-one/app.html", pages[0]);
      await write("made/apps/fold-one/shared.js", shared);
      await write("made/apps/fold-two/app.html", pages[1]);
      await write(".folders/apps~fold-one/one.md", "one");
      await write(".folders/apps~fold-two/two.md", "two");
    },
    [[page("Fold one"), page("Fold two")], SHARED],
  );
  await one.goto(`${URL}apps/fold-one/`);
  const two = await openTab(`${URL}apps/fold-two/`);
  const button = '[data-key="folder-two-apps:which"] button';
  const ready = await Promise.all([one, two].map((p) => p.waitForSelector(button, { timeout: 15000 }).then(() => true, () => false)));
  check("two made apps that link the same plugin both show it", ready.every(Boolean), JSON.stringify(ready));
  if (!ready.every(Boolean)) return;

  const which = async (tab) => {
    const before = await tab.evaluate(() => window.__host.traces.filter((e) => e.plugin === "folder-two-apps" && e.detail?.startsWith("which ")).length);
    await tab.click(button);
    const detail = await tab
      .waitForFunction((n) => window.__host.traces.filter((e) => e.plugin === "folder-two-apps" && e.detail?.startsWith("which ")).at(n)?.detail, before, { timeout: 8000 })
      .then((h) => h.jsonValue(), () => "");
    try {
      return JSON.parse(String(detail).slice(6));
    } catch {
      return { traced: "", untraced: String(detail) };
    }
  };
  const fromOne = await which(one);
  const fromTwo = await which(two);
  check("a call made while handling a click uses the folder of the app clicked in", fromOne.traced === 'ok ["one.md"]' && fromTwo.traced === 'ok ["two.md"]', `${fromOne.traced} / ${fromTwo.traced}`);
  check("a call that doesn't say which app it is for fails while both are open, naming both", /^no .*more than one app.*apps\/fold-one.*apps\/fold-two|^no .*more than one app.*apps\/fold-two.*apps\/fold-one/.test(fromOne.untraced), fromOne.untraced);

  // With one of the apps closed there is no question: the call uses the app still open.
  await two.close();
  await one.waitForTimeout(500);
  const alone = await which(one);
  check("with only one of the apps open, a call that doesn't say uses that app's folder", alone.untraced === 'ok ["one.md"]', alone.untraced);
  await one.close();
}
