// The service worker (sw.js): an app's folder address serves its app.html, and
// a plugin's routes answer requests (the reading list's books.json and add-book).
export default async function ({ a, check, openTab, URL, traceHas }) {
  // ready never settles if the worker fails to install, so the wait is bounded.
  const ready = await a.evaluate(() => Promise.race([navigator.serviceWorker.ready.then((r) => !!r.active), new Promise((resolve) => setTimeout(() => resolve(false), 8000))])).catch(() => false);
  check("the platform's service worker starts", ready);

  // The folder's own address is the app.
  const page = await openTab(`${URL}demos/reading-list/`);
  const drawn = await page.waitForSelector('[data-key="library:books"] ui-table >> text=Dune', { timeout: 8000 }).then(() => true, () => false);
  check("an app's folder address serves its app.html", drawn && (await page.evaluate(() => !!navigator.serviceWorker.controller)));

  // A plugin's GET route answers with JSON.
  const books = await page.evaluate(() => fetch("books.json").then((r) => r.json())).catch((e) => String(e));
  check("a plugin's route answers a request: books.json lists the books", Array.isArray(books) && books.some((b) => b.title === "Dune"), JSON.stringify(books).slice(0, 200));

  // A form post reaches the plugin, which adds the book and sends the page back to the app.
  const posted = await page.evaluate(() => fetch("add-book", { method: "POST", body: new URLSearchParams({ title: "Kindred", author: "Octavia E. Butler" }) }).then((r) => ({ status: r.status, url: r.url })));
  const after = await page.evaluate(() => fetch("books.json").then((r) => r.json()));
  check("a form posted to a plugin's route runs it and redirects back to the app", posted.url.endsWith("/demos/reading-list/") && after.some((b) => b.title === "Kindred"), JSON.stringify(posted));

  // A refused write comes back as the plugin's error, not a redirect.
  const refused = await page.evaluate(() => fetch("add-book", { method: "POST", body: new URLSearchParams({ title: "" }) }).then((r) => r.status));
  check("a route's own error status reaches the page", refused === 400, String(refused));

  // A field named like an Object method is just a field.
  const odd = await page.evaluate(() => fetch("add-book", { method: "POST", body: new URLSearchParams({ title: "Parable of the Sower", constructor: "x", toString: "y" }) }).then((r) => r.url));
  check("form fields named constructor or toString don't break a route", odd.endsWith("/demos/reading-list/"), odd);

  // Another site's form can't post to a plugin's route: 127.0.0.1 is another origin than localhost.
  const other = await openTab(URL.replace("localhost", "127.0.0.1"));
  await other.evaluate((action) => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = action;
    form.innerHTML = '<input name="title" value="Forged">';
    document.body.append(form);
    form.submit();
  }, `${URL}demos/reading-list/add-book`);
  await other.waitForURL(/add-book/, { timeout: 5000 }).catch(() => {});
  const forged = await other.evaluate(() => document.body.innerText).catch((e) => String(e));
  const kept = await page.evaluate(() => fetch("books.json").then((r) => r.json()));
  check("another site's form posting to a plugin's route is refused", /Only a page on this site/.test(forged) && !kept.some((b) => b.title === "Forged"), forged.slice(0, 100));
  await other.close();

  // A path no plugin answers goes on to the network as before.
  const plain = await page.evaluate(() => fetch("library.js").then((r) => r.ok && r.headers.get("Content-Type")));
  check("a request no route claims goes to the network unchanged", /javascript/.test(String(plain)), String(plain));
  await page.close();

  // Routes need the routes permission, and a plugin no app links has no folder to answer for.
  await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'router-nope', name: 'No permission', permissions: [] };\nexport default (ctx) => { ctx.routes.add('GET', 'x.json', () => ({ json: 1 })); };"));
  await a.evaluate(() => window.__host.command("install", "export const manifest = { id: 'router-loose', name: 'Not linked', permissions: ['routes'] };\nexport default (ctx) => { ctx.routes.add('GET', 'x.json', () => ({ json: 1 })); };"));
  await a.waitForFunction(() => window.__host.traces.some((e) => e.name === "route:refused" && e.plugin?.startsWith("router-loose")), null, { timeout: 5000 }).catch(() => {});
  const denied = await traceHas(a, (e) => e.kind === "denied" && e.name === "routes" && e.plugin?.startsWith("router-nope"));
  const loose = await traceHas(a, (e) => e.name === "route:refused" && e.plugin?.startsWith("router-loose"));
  check("a route needs the routes permission, and a plugin linked from an app", denied && loose);
  for (const id of ["router-nope", "router-loose"]) await a.evaluate((id) => window.__host.command("uninstall", id), id);
}
