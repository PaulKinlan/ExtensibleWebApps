// What an <svg> or <canvas> in a plugin's view may not do: run code, carry
// HTML, link, load from anywhere, or reach outside the view. A plugin
// installed on the workbench draws an HTML view that tries each (the same
// sanitiser cleans templates; demos/doodle shows what does get through).
export default async function ({ a, check }) {
  const html = `<svg class="probe" viewBox="0 0 10 10" onload="window.__svgRan = 1">
    <defs><linearGradient id="g"><stop offset="0" stop-color="red"></stop></linearGradient></defs>
    <rect class="ok" width="5" height="5" fill="url(#g)" stroke="url(https://example.com/s.svg#a)" onclick="window.__svgRan = 1"></rect>
    <rect class="escaped" width="5" height="5" fill="u\\\\72l(https://example.com/x)"></rect>
    <use class="near" href="#g"></use><use class="far" href="https://example.com/sprite.svg#i"></use><use class="xlink" xlink:href="#g"></use>
    <script>window.__svgRan = 1</script>
    <foreignObject width="5" height="5"><p class="smuggled">HTML</p></foreignObject>
    <a href="javascript:window.__svgRan=1"><text class="linked">x</text></a>
    <image href="https://example.com/x.png"></image><feImage href="https://example.com/x.png"></feImage>
    <animate attributeName="href" to="javascript:window.__svgRan=1"></animate><set attributeName="fill" to="red"></set>
    <style>rect { fill: url(https://example.com/x.png) }</style>
    <text class="said" x="0" y="9">Said <tspan>it</tspan></text>
  </svg>
  <canvas class="nameless" width="10" height="10"></canvas>
  <canvas id="big" class="big" width="100000" height="-4"></canvas>
  <img class="queried" src="/app-icon.svg?x=1" alt=""><img class="server" src="/auth/me" alt=""><img class="relative" src="app-icon.svg" alt=""><img class="root" src="/app-icon.svg" alt="">`;
  const source = `export const manifest = { id: "svg-probe", name: "SVG probe", permissions: ["ui"] };
export default (ctx) => ctx.ui.render("status", "probe", { type: "html", html: ${JSON.stringify(html)} });`;
  const installed = await a.evaluate((s) => window.__host.command("install", s), source);
  const drawn = await a.waitForSelector('[data-key^="svg-probe:"] svg.probe', { state: "attached", timeout: 8000 }).then(() => true, () => false);
  const seen = await a.evaluate(() => {
    const view = document.querySelector('[data-key^="svg-probe:"]');
    const svg = view.querySelector("svg.probe");
    const ok = svg.querySelector("rect.ok");
    return {
      tags: [...svg.querySelectorAll("*")].map((e) => e.localName),
      handlers: [...view.querySelectorAll("*")].some((e) => [...e.attributes].some((x) => x.name.startsWith("on"))),
      fill: ok?.getAttribute("fill"),
      stroke: ok?.getAttribute("stroke"),
      escaped: svg.querySelector("rect.escaped")?.getAttribute("fill") ?? null,
      near: svg.querySelector("use.near")?.getAttribute("href"),
      far: svg.querySelector("use.far")?.getAttribute("href") ?? null,
      xlink: svg.querySelector("use.xlink")?.attributes.length,
      said: svg.querySelector("text.said")?.textContent,
      // A plugin that isn't tab-scoped can't draw: its canvases say so instead.
      canvases: view.querySelectorAll("canvas").length,
      notes: view.textContent.match(/need scope|needs an id/g)?.length ?? 0,
      imgs: ["queried", "server", "relative", "root"].map((c) => view.querySelector(`img.${c}`)?.getAttribute("src") ?? null),
      ran: window.__svgRan ?? null,
    };
  });
  check("an <svg> in a view keeps shapes, text and gradients, and drops script, foreignObject, links, images, animation and <style> with their content", installed?.ok && drawn && seen.tags.join() === "defs,linearGradient,stop,rect,rect,use,use,use,text,tspan" && seen.said === "Said it" && seen.ran === null && !seen.handlers, JSON.stringify(seen));
  check("in an <svg>, url() and href may only name an #id in the view, and a CSS escape can't spell one", /--g\)$/.test(seen.fill ?? "") && seen.stroke === null && seen.escaped === null && /--g$/.test(seen.near ?? "") && seen.far === null && seen.xlink === 1, JSON.stringify(seen));
  check("a canvas from a plugin that isn't tab-scoped, or with no id, isn't handed out", seen.canvases === 0 && seen.notes === 2, JSON.stringify(seen));
  check("a picture in a view drawn from code may come from the site's root, with no ?query, and not from a server address", seen.imgs.join() === `,,,${new URL("/app-icon.svg", await a.evaluate(() => location.href)).href}`, JSON.stringify(seen.imgs));
  await a.evaluate(() => window.__host.command("uninstall", "svg-probe")).catch(() => {});
}
