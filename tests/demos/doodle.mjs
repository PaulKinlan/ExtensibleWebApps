// Doodle: a canvas and an SVG chart from one template. Drawing on the canvas
// (taps and drags reach the plugin's worker) adds bars to the chart, and the
// app's badge is a picture from another folder of the site (/app-icon.svg).
export default async function (page, { check, proof }) {
  const view = '[data-key^="doodle@"]';
  await page.waitForSelector(`${view} canvas[data-canvas]`, { timeout: 10000 });
  const canvas = await page.evaluate((sel) => {
    const el = document.querySelector(`${sel} canvas[data-canvas]`);
    window.__pad = el;
    let handed = false;
    try {
      el.getContext("2d");
    } catch {
      handed = true; // its drawing belongs to the plugin's worker now
    }
    return { handed, size: `${el.width}x${el.height}`, cls: el.className, label: el.getAttribute("aria-label") };
  }, view);
  check("a <canvas id> in a template goes to the plugin's worker, keeping its size, class and label", canvas.handed && canvas.size === "640x360" && canvas.cls === "pad" && /drawing pad/.test(canvas.label ?? ""), JSON.stringify(canvas));

  const box = await (await page.$(`${view} canvas[data-canvas]`)).boundingBox();
  const stroke = async (dx) => {
    await page.mouse.move(box.x + 40 + dx, box.y + 40);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + 40 + dx + i * 10, box.y + 40 + i * 10);
    await page.mouse.up();
  };
  await stroke(0);
  await page.click(`${view} button[data-value="Coral"]`);
  await stroke(120);
  await stroke(240);
  proof.doodleStrokes = await page.waitForSelector(`${view} figcaption >> text=3 strokes`, { timeout: 5000 }).then(() => true, () => false);
  const chart = await page.evaluate((sel) => {
    const svg = document.querySelector(`${sel} svg.chart`);
    return {
      ns: svg?.namespaceURI,
      heights: [...svg.querySelectorAll("rect.bar")].map((r) => r.getAttribute("height")),
      shine: svg.querySelector("rect.shine")?.getAttribute("fill"),
      gradient: svg.querySelector("linearGradient")?.id,
      same: document.querySelector(`${sel} canvas[data-canvas]`) === window.__pad,
    };
  }, view);
  check(
    "drawing on the canvas reaches the plugin, and its SVG chart grows a bar per colour from data, with the same canvas kept",
    proof.doodleStrokes && chart.ns === "http://www.w3.org/2000/svg" && chart.heights.join() === "50,100,0,0" && chart.same,
    JSON.stringify(chart),
  );
  check("a gradient in the chart is the plugin's own id, and url(#id) follows it", /--sheen$/.test(chart.gradient ?? "") && chart.shine === `url(#${chart.gradient})`, JSON.stringify(chart));
  const badge = await page
    .waitForFunction((sel) => document.querySelector(`${sel} img.badge`)?.naturalWidth > 0, view, { timeout: 5000 })
    .then(() => page.evaluate((sel) => new globalThis.URL(document.querySelector(`${sel} img.badge`).src).pathname, view), () => "");
  check("a template's picture can come from another folder of the site", badge === "/app-icon.svg", badge);
}
