// The beat pad: pads that save, a Euclid menu that sets a row through the
// sequencer's own command, and a clock that plays and lights each step.
// The runner (tests/platform.test.mjs) opens demos/beats/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  const machine = '[data-plugin="sequencer"][data-key="sequencer:pads"]';
  await page.waitForSelector(`${machine} .pad`, { timeout: 8000 });
  proof.pads = await page.locator(`${machine} .pad`).count();
  check("the beat pad draws six rows of sixteen pads", proof.pads === 96);

  // A pad is a checkbox: ticking one saves it to the pattern.
  const clapRow = `${machine} .row[data-track="clap"]`;
  await page.check(`${clapRow} .pad >> nth=1`);
  proof.clap = await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.trim() === "2", `${clapRow} .track small`, { timeout: 5000 }).then(() => true, () => false);
  check("tapping a pad adds a hit to the row", proof.clap);

  // euclid.js fills the room beside each row's name, and sets a row by running sequencer/set-track.
  await page.selectOption(`${machine} .row[data-track="bell"] [data-plugin="euclid"] select`, "5");
  proof.euclid = await page
    .waitForFunction((sel) => [...document.querySelectorAll(sel)].map((p) => (p.checked ? "x" : ".")).join("") === "x...x..x..x..x..", `${machine} .row[data-track="bell"] .pad`, { timeout: 5000 })
    .then(() => true, () => false);
  check("the Euclid menu, another plugin, spreads 5 hits across a row through the sequencer's command", proof.euclid);

  // Playing: the clock lights a column each step and asks the audio service for each hit.
  // The audio service plays in whichever tab hosts the plugin workers, so count the calls the kernel traced.
  const played = () => page.evaluate(() => window.__host.traces.filter((e) => e.kind === "call" && e.name === "audio.play" && e.plugin === "sequencer").length);
  const before = await played();
  await page.click(`${machine} button.play`);
  await page.waitForTimeout(1200);
  proof.lit = await page.locator(`${machine} .pad[data-now]`).count();
  proof.played = (await played()) - before;
  await page.click(`${machine} button.play`);
  check("playing lights the sounding column and plays its hits", proof.lit === 6 && proof.played > 0, `${proof.lit} lit, ${proof.played} hits`);
}
