// The sound editor, further: an effect's knobs tune what it renders with,
// another clip is laid over this one as a second track (audio.mix) to make
// a stereo clip, and a clip too long for the collection is kept by the
// audio service (audio.keep) and opens again from there.
export default async function ({ check, openTab, URL }) {
  const page = await openTab(`${URL}demos/audio-editor/app.html`);
  const view = '[data-key^="sound-editor"]';
  const status = () => page.locator(`${view} .status`).textContent();
  const waitStatus = (re, ms = 15000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-key^="sound-editor"] .status')?.textContent ?? ""), re.source, { timeout: ms }).then(() => true, () => false);
  await page.waitForSelector(`${view} [data-knob]`, { timeout: 10000 }).catch(() => {});
  const knobs = await page.locator(`${view} [data-knob]`).evaluateAll((els) => els.map((e) => e.dataset.knob));
  check("each effect that describes its options gets a knob for each", ["knob:echo:delay", "knob:lofi:bits", "knob:tremolo:rate"].every((k) => knobs.includes(k)), knobs.join());

  // Turn the echo's delay up: the editor keeps the value and shows it.
  await page.locator(`${view} [data-knob="knob:echo:delay"]`).evaluate((el) => {
    el.value = "0.6";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const shown = await page.waitForFunction(() => /0\.6 s/.test(document.querySelector('[data-key^="sound-editor"] [data-knob="knob:echo:delay"]')?.closest("label")?.textContent ?? ""), null, { timeout: 5000 }).then(() => true, () => false);
  check("turning a knob sets the effect's option, and the editor shows it", shown);

  // A drum loop, with the plucked phrase laid over it, panned left: the mix is stereo.
  await page.click(`${view} [data-action="new:drums"]`);
  await waitStatus(/Made Drum loop/);
  await page.locator(`${view} form.layer input[name="pan"]`).evaluate((el) => (el.value = "-1"));
  await page.locator(`${view} form.layer input[name="at"]`).fill("0.5");
  await page.click(`${view} form.layer button[type="submit"]`);
  const mixed = await waitStatus(/^Mixed in Plucked phrase/);
  check("laying another clip over this one mixes them (audio.mix) into a stereo clip", mixed && (await page.locator(`${view} [data-stereo]`).count()) === 1, await status());
  // An effect on a stereo clip runs on both sides.
  await page.click(`${view} [data-effect="tremolo"]`);
  check("an effect renders a stereo clip, each side through the chain", (await waitStatus(/^Tremolo$/)) && (await page.locator(`${view} [data-stereo]`).count()) === 1, await status());
  await page.click(`${view} [data-action="mono"]`);
  await waitStatus(/Mixed down/);
  check("a stereo clip mixes down to one channel", (await page.locator(`${view} [data-stereo]`).count()) === 0);

  // Laid 25 seconds in, the mix is too long for the collection: the audio service keeps it in the data folder.
  await page.locator(`${view} form.layer input[name="at"]`).fill("25");
  await page.click(`${view} form.layer button[type="submit"]`);
  await waitStatus(/^Mixed in .* at 25\.00 s/, 30000);
  const length = async () => Number((await page.locator(`${view} .part`).textContent()).match(/([\d.]+) s$/)?.[1]);
  const long = await length();
  check("a clip longer than the old 34 s limit is made, and kept outside the collection (Long clip)", long > 28 && (await page.locator(`${view} .badge >> text=Long clip`).count()) === 1, `${long} s`);
  // Open another clip and this one again: its sound comes back from the audio service.
  const select = page.locator(`${view} select[data-action="open-clip"]`);
  const ids = await select.locator("option").evaluateAll((os) => os.map((o) => ({ id: o.value, text: o.textContent })));
  const other = ids.find((o) => /Plucked/.test(o.text));
  const self = ids.find((o) => /Drum loop/.test(o.text));
  await select.selectOption(other.id);
  await page.waitForFunction(() => /Plucked/.test(document.querySelector('[data-key^="sound-editor"] input[name="name"]')?.value ?? ""), null, { timeout: 5000 }).catch(() => {});
  await select.selectOption(self.id);
  await page.waitForFunction(() => /Drum/.test(document.querySelector('[data-key^="sound-editor"] input[name="name"]')?.value ?? ""), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  check("a long clip opens again from where the audio service kept it", Math.abs((await length()) - long) < 0.05 && (await page.locator(`${view} ui-waveform`).getAttribute("peaks")).length > 100, `${await length()} s`);
  await page.close();
}
