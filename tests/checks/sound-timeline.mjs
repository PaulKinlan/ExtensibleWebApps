// The sound editor's timeline (demos/audio-editor/timeline.js) and its
// folder. Two clips go in a mix as tracks; one is dragged along its lane on
// the canvas and turned down, after it is in the mix; the mix plays, and is
// kept as a clip the editor opens (a write the person allows on a card).
// Then a clip goes to the app's folder as a WAV and opens again from there.
export default async function ({ check, context, URL, errors }) {
  // A context of its own: an empty sound-clips collection, so the clip names are ours.
  const own = await context.browser().newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${URL}demos/audio-editor/app.html`);
    const editor = '[data-key^="sound-editor"]';
    const head = '[data-key^="sound-timeline"][data-key$="timeline-head"]';
    const tracks = '[data-key^="sound-timeline"][data-key$="timeline-tracks"]';
    const waitText = (selector, re, ms = 15000) =>
      page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ""), [selector, re.source], { timeout: ms }).then(() => true, () => false);
    const editorStatus = (re, ms) => waitText(`${editor} .status`, re, ms);
    const timelineStatus = (re, ms) => waitText(`${tracks} .status`, re, ms);

    await editorStatus(/Made Plucked phrase/);
    await page.click(`${editor} [data-action="new:drums"]`);
    await editorStatus(/Made Drum loop/);

    // A mix with both clips: the drums from the start, the phrase a second in.
    await page.click(`${head} [data-action="mix:new"]`);
    await timelineStatus(/Made Mix 1/);
    const add = async (name, at) => {
      const value = await page.locator(`${head} form.add select option`, { hasText: name }).first().getAttribute("value");
      await page.selectOption(`${head} form.add select`, value);
      await page.fill(`${head} form.add input[name="at"]`, String(at));
      await page.click(`${head} form.add button[type="submit"]`);
      await timelineStatus(new RegExp(`Added ${name}`));
    };
    await add("Drum loop", 0);
    await add("Plucked phrase", 1);
    const at = (name) => page.locator(`${tracks} li[data-track="${name}"]`).getAttribute("data-at").then(Number);
    check("timeline: clips go in a mix as tracks, each where it starts", (await page.locator(`${tracks} li.track`).count()) === 2 && (await at("Plucked phrase")) === 1);

    // Drag the phrase along its lane, on the canvas: it starts later.
    const canvas = page.locator('[data-plugin="sound-timeline"] canvas');
    const box = await canvas.boundingBox();
    // Lanes start 26 of 300 canvas pixels down, a third of the rest each (at least three lanes are drawn).
    const y = box.y + box.height * ((26 + ((300 - 26) / 3) * 1.5) / 300);
    const x = box.x + box.width * 0.2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width * 0.1, y, { steps: 5 });
    await page.mouse.up();
    await timelineStatus(/Moved Plucked phrase to/);
    const moved = await at("Plucked phrase");
    check("timeline: dragging a track along its lane moves it, after it is in the mix", moved > 1.3, `${moved} s`);

    // Turn the drums down, and mute and unmute them.
    await page.locator(`${tracks} li[data-track="Drum loop"] input[data-action^="track-gain:"]`).evaluate((el) => {
      el.value = "0.4";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const levelled = await page.waitForFunction((s) => document.querySelector(`${s} li[data-track="Drum loop"]`)?.dataset.gain === "0.4", tracks, { timeout: 5000 }).then(() => true, () => false);
    check("timeline: a track is re-levelled after it is in the mix", levelled && /40%/.test(await page.textContent(`${tracks} li[data-track="Drum loop"]`)));
    await page.click(`${tracks} li[data-track="Drum loop"] [data-action^="track-mute:"]`);
    await timelineStatus(/Drum loop muted/);
    check("timeline: a track can be muted", (await page.locator(`${tracks} li[data-track="Drum loop"][data-mute]`).count()) === 1);
    await page.click(`${tracks} li[data-track="Drum loop"] [data-action^="track-mute:"]`);
    await timelineStatus(/Drum loop back in/);

    // Play it: the tracks are mixed (audio.mix) then played.
    await page.click(`${head} [data-action="play-mix"]`);
    check("timeline: the mix plays", await timelineStatus(/Playing the mix/));
    await page.click(`${head} [data-action="play-mix"]`);

    // Keep it as a clip: a write to the editor's collection, which the person allows.
    await page.click(`${head} [data-action="bounce"]`);
    await page.click('[data-key^="review:"] >> text=Accept', { timeout: 10000 }).catch(() => {});
    const kept = await timelineStatus(/Kept Mix 1 as a clip/);
    const length = Number((await page.textContent(`${tracks} .status`)).match(/\(([\d.]+) s\)/)?.[1]);
    check("timeline: the mix is kept as a clip, as long as its tracks reach", kept && length > (await at("Plucked phrase")) + 3.5, `${length} s`);
    const option = await page.locator(`${editor} select[data-action="open-clip"] option`, { hasText: "Mix 1" }).first().getAttribute("value").catch(() => null);
    if (option) await page.selectOption(`${editor} select[data-action="open-clip"]`, option);
    const opened = await page.waitForFunction((s) => document.querySelector(`${s} input[name="name"]`)?.value === "Mix 1", editor, { timeout: 8000 }).then(() => true, () => false);
    check("timeline: the editor opens the mix as a clip, in stereo", opened && (await page.locator(`${editor} [data-stereo]`).count()) === 1);

    // The folder: the clip goes to sounds/ as a WAV, and opens again from there.
    await page.click(`${editor} [data-action="folder-save"]`);
    const saved = await editorStatus(/Saved to .*sounds\/Mix 1\.wav/);
    check("folder: a clip is saved to the app's folder as a WAV", saved, await page.textContent(`${editor} .status`));
    const listed = await page.waitForSelector(`${editor} form[data-action="folder-open"] option[value="sounds/Mix 1.wav"]`, { state: "attached", timeout: 5000 }).then(() => true, () => false);
    const before = await page.textContent(`${editor} .part`);
    await page.click(`${editor} [data-action="new:pluck"]`);
    await editorStatus(/Made Plucked phrase/);
    await page.selectOption(`${editor} form[data-action="folder-open"] select`, "sounds/Mix 1.wav");
    await page.click(`${editor} form[data-action="folder-open"] button[type="submit"]`);
    const back = await editorStatus(/Opened sounds\/Mix 1\.wav/);
    const after = await page.textContent(`${editor} .part`);
    check("folder: the sounds in the folder are listed, and one opens again as it was saved", listed && back && before.match(/[\d.]+ s$/)?.[0] === after.match(/[\d.]+ s$/)?.[0] && (await page.locator(`${editor} [data-stereo]`).count()) === 1, `${before} → ${after}`);
  } finally {
    await own.close();
  }
}
