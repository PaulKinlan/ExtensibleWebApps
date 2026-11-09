// The sound editor: pick part of a clip on its waveform, edit it, and run it
// through effects that are each a plugin, rendered by the audio service.
export default async function (page, { check }) {
  const view = '[data-key^="sound-editor"]';
  const wave = page.locator(`${view} ui-waveform`);
  const status = () => page.locator('[data-key^="sound-editor"] .status').textContent();
  const peaks = () => wave.getAttribute("peaks");
  const length = async () => Number((await page.locator('[data-key^="sound-editor"] .part').textContent()).match(/([\d.]+) s$/)?.[1]);
  await page.waitForFunction(() => document.querySelectorAll('[data-key^="sound-editor"] [data-effect]').length >= 3, null, { timeout: 10000 }).catch(() => {});
  const offered = await page.locator("[data-effect]").evaluateAll((els) => els.map((e) => e.dataset.effect).sort());
  check("the editor offers each effect plugin that answers its hook", offered.join() === "echo,lofi,tremolo", offered.join());

  // Pick a part by dragging across the waveform.
  const box = await wave.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-key^="sound-editor"] ui-waveform')?.getAttribute("select") !== "0,0", null, { timeout: 5000 }).catch(() => {});
  const [from, to] = (await wave.getAttribute("select")).split(",").map(Number);
  check("dragging across the waveform picks a part, sent to the plugin", to - from > 0.5, `${from},${to}`);

  // An edit on the part, and undo.
  const before = await peaks();
  await page.click(`${view} [data-action="edit:reverse"]`);
  await page.waitForFunction((b) => document.querySelector('[data-key^="sound-editor"] ui-waveform').getAttribute("peaks") !== b, before, { timeout: 5000 }).catch(() => {});
  check("an edit changes the part picked", (await peaks()) !== before && /Reversed/.test(await status()));
  await page.click(`${view} [data-action="undo"]`);
  await page.waitForFunction((b) => document.querySelector('[data-key^="sound-editor"] ui-waveform').getAttribute("peaks") === b, before, { timeout: 5000 }).catch(() => {});
  const after = await peaks();
  check("undo puts it back", after === before);

  // An effect on the whole clip: the echo's tail makes it longer.
  await wave.evaluate((el) => el.shadowRoot.querySelector(".surface").focus());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector('[data-key^="sound-editor"] ui-waveform').getAttribute("select") === "0,0", null, { timeout: 5000 }).catch(() => {});
  const was = await length();
  await page.click(`${view} [data-effect="echo"]`);
  await page.waitForFunction(() => /^Echo$/.test(document.querySelector('[data-key^="sound-editor"] .status')?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  const now = await length();
  check("an effect renders the whole clip through its processor, with room for its tail", Math.abs(now - was - 1.5) < 0.05, `${was} → ${now} s`);

  // Play: the playhead runs.
  await page.click('[data-key^="sound-editor"] button[data-action="play"]');
  const playing = await page.waitForFunction(() => document.querySelector('[data-key^="sound-editor"] ui-waveform').getAttribute("playing"), null, { timeout: 5000 }).then(() => true, () => false);
  check("playing a clip runs the playhead", playing);
  await page.click('[data-key^="sound-editor"] button[data-action="play"]');
}
