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

  // A link to a heading on another page keeps its #, and the page scrolls there.
  await page.goto(`${URL}docs/guide/styling`);
  await drawn(shown);
  await page.click(`${shown} >> a[href="/docs/guide/views-and-templates#template-files"]`);
  const scrolled = await page
    .waitForFunction((s) => location.hash === "#template-files" && document.title.startsWith("Views") && document.querySelector(s)?.shadowRoot?.getElementById("template-files")?.getBoundingClientRect().top < 200, shown, { timeout: 8000 })
    .then(() => true, () => false);
  check("a link to a heading on another page goes to that heading", scrolled, page.url());

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
  const more = await page.evaluate(async () => {
    const { parse } = await import("/elements/markdown.js");
    const div = document.createElement("div");
    div.append(parse("one  \ntwo\n\n<https://example.com/a>", { link: () => "" }));
    return { br: !!div.querySelector("p br"), autolink: div.querySelectorAll("a").length };
  });
  check("two spaces at a line's end are a hard break", more.br);
  check("an autolink goes through the same check as any link", more.autolink === 0);

  // A plugin's attributes can't turn a link into script, and an image from another site isn't loaded.
  const hostile = await page.evaluate(async () => {
    const make = (src) => new Promise((resolve) => {
      const md = document.createElement("ui-markdown");
      md.setAttribute("repo", "javascript:alert(1)//");
      md.setAttribute("pages", "javascript:alert(2)");
      md.setAttribute("src", src);
      md.addEventListener("load", () => resolve(md), { once: true });
      document.body.append(md);
      setTimeout(() => resolve(md), 4000);
    });
    const found = await make("/docs/README.md");
    const missing = await make("/docs/not-here.md");
    const hrefs = [found, missing].flatMap((md) => [...md.shadowRoot.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""));
    found.remove();
    missing.remove();
    return { script: hrefs.filter((h) => /^\s*javascript:/i.test(h)), links: hrefs.length };
  });
  check("repo and pages can't make a javascript: link", hostile.links > 0 && !hostile.script.length, JSON.stringify(hostile));
  // An image from another site would be a request the plugin may not make: it shows as its words.
  await own.route("**/docs/test-remote-image.md", (route) => route.fulfill({ contentType: "text/markdown", body: "# Images\n\n![a cat](https://example.com/cat.png) ![ours](images/spike.png)" }));
  const remote = await page.evaluate(() => new Promise((resolve) => {
    const md = document.createElement("ui-markdown");
    md.setAttribute("src", "/docs/test-remote-image.md");
    md.addEventListener("load", () => {
      const srcs = [...md.shadowRoot.querySelectorAll("img")].map((i) => i.getAttribute("src"));
      resolve({ srcs, text: md.shadowRoot.textContent.includes("a cat") });
      md.remove();
    }, { once: true });
    document.body.append(md);
    setTimeout(() => resolve({ timeout: true }), 4000);
  }));
  check("an image from another site shows as its words; one from this site shows", remote.text && remote.srcs?.length === 1 && remote.srcs[0].endsWith("/docs/images/spike.png"), JSON.stringify(remote));

  check("raw HTML in Markdown shows as text", !raw.img && raw.text.includes("<img src=x") && !raw.text.includes(")") && raw.href === null, JSON.stringify(raw));
  await own.close();
}
