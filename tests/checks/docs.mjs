// The docs at /docs/ (docs/app.html and docs/docs.js): the Markdown in docs/,
// drawn by <ui-markdown>, with links between pages as screens, links to code
// sent to GitHub, and ```mermaid blocks drawn as diagrams.
//
// It runs in a browser context of its own, so its pages stay out of the other checks.
export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const shown = 'ui-markdown[sets-title]';
  const contents = 'ui-markdown[compact]';
  const drawn = (selector, timeout = 10000) => page.waitForFunction((s) => document.querySelector(s)?.shadowRoot?.querySelector("article h1, article a, .missing"), selector, { timeout }).then(() => true, () => false);
  const inside = (selector, fn) => page.$eval(selector, fn);

  await page.goto(`${URL}docs/`);
  check("the docs' first page draws from docs/README.md", await drawn(shown), await page.title());
  check("the docs list their pages", await drawn(contents) && (await inside(contents, (e) => e.shadowRoot.querySelectorAll("a").length)) > 10);
  const links = await inside(shown, (e) => [...e.shadowRoot.querySelectorAll("a")].map((a) => a.getAttribute("href")));
  check("a link to another page of the docs becomes a screen", links.includes("/docs/guide/how-an-app-works") && links.includes("/docs/guide/"), links.join(", "));
  check("a link to code goes to GitHub", links.includes("https://github.com/PaulKinlan/ExtensibleWebApps/blob/main/docs/docs.js"));
  check("a link from the site's root stays on the site", links.includes("/"));

  // Following a link moves to the page without loading it again, and draws its diagram.
  await page.evaluate(() => (window.__docsLoaded = true));
  await page.click(`${contents} >> a[href="/docs/guide/how-an-app-works"]`);
  const moved = await page.waitForFunction(() => document.title.startsWith("How an app works"), null, { timeout: 8000 }).then(() => true, () => false);
  check("following a link in the contents shows that page, without loading the page again", moved && (await page.evaluate(() => window.__docsLoaded === true)), page.url());
  check("the page being read is marked in the contents", await page.waitForFunction((s) => document.querySelector(s)?.shadowRoot?.querySelector('a[aria-current="page"]')?.textContent === "How an app works", contents, { timeout: 3000 }).then(() => true, () => false));
  const diagram = await page.waitForFunction((s) => document.querySelector(s)?.shadowRoot?.querySelector("figure.diagram svg"), shown, { timeout: 15000 }).then(() => true, () => false);
  check("a ```mermaid block is drawn as a diagram", diagram);

  // An address straight to a page, and one with no page.
  await page.goto(`${URL}docs/guide/agents`);
  check("an address of a page opens it", await drawn(shown) && (await page.title()).startsWith("Agents"), await page.title());
  await page.goto(`${URL}docs/no-such-page`);
  check("an address with no page says so", await drawn(shown) && (await inside(shown, (e) => !!e.shadowRoot.querySelector(".missing"))));

  // Every diagram on the pages that have them draws, rather than showing Mermaid's error.
  const failed = [];
  for (const path of ["architecture", "security", "permissions"]) {
    await page.goto(`${URL}docs/${path}`);
    await drawn(shown);
    const ok = await page
      .waitForFunction((s) => { const r = document.querySelector(s).shadowRoot; const all = r.querySelectorAll("figure.diagram"); return all.length && [...all].every((f) => f.querySelector("svg, .diagram-error")); }, shown, { timeout: 15000 })
      .then(() => inside(shown, (e) => !e.shadowRoot.querySelector(".diagram-error")), () => false);
    if (!ok) failed.push(path);
  }
  check("the diagrams in the architecture, security and permissions pages draw", !failed.length, failed.join(", "));

  // Raw HTML in a Markdown file is shown as text, never run.
  const raw = await page.evaluate(async () => {
    const { parse } = await import("/elements/markdown.js");
    const div = document.createElement("div");
    div.append(parse('<img src=x onerror="window.ran = 1">\n\n[x](javascript:alert(1))', { link: (h) => (h.startsWith("javascript:") ? "" : h), image: (s) => s, code: () => undefined }));
    return { img: !!div.querySelector("img"), text: div.textContent, href: div.querySelector("a")?.getAttribute("href") ?? null };
  });
  check("raw HTML in Markdown shows as text", !raw.img && raw.text.includes("<img src=x") && !raw.text.includes(")") && raw.href === null, JSON.stringify(raw));
  await own.close();
}
