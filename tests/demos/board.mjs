// The studio board: cards in columns, badges other plugins put in each card's
// room, a transform on the column headers, and a card's own screen.
// The runner (tests/platform.test.mjs) opens demos/board/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  // board.js is tab-scoped, so its view's key is studio@<tab>:board.
  const board = '[data-plugin="studio"][data-key$=":board"]';
  await page.waitForSelector(`${board} .column[data-column="doing"] .card`, { timeout: 8000 });
  proof.columns = await page.locator(`${board} .column`).count();
  check("the board draws a column per stage, with the sample cards", proof.columns === 5);

  // due.js and checklist.js fill the room each card leaves, from the slot's data.
  const icons = `${board} .card[data-id="card-icons"]`;
  proof.badges = await page.waitForSelector(`${icons} [data-plugin="due"] .due`, { timeout: 5000 }).then(() => page.locator(`${icons} slot [data-plugin]`).count(), () => 0);
  check("two plugins put badges in a card's room: when it's due, and its checklist", proof.badges === 2);

  // wip.js transforms the board's view: a gauge in the headers of the columns it limits.
  proof.gauge = await page.waitForSelector(`${board} .column[data-column="doing"] .column-head [data-plugin="wip"] .gauge`, { timeout: 5000 }).then((el) => el.textContent(), () => "");
  check("a transform adds a limit gauge to the board's column headers", /of 3/.test(proof.gauge), proof.gauge);

  // Adding a card is a form at the foot of each column.
  await page.fill(`${board} .column[data-column="next"] form.add input`, "Haptics for rain alerts");
  await page.press(`${board} .column[data-column="next"] form.add input`, "Enter");
  const added = `${board} .column[data-column="next"] .card >> text=Haptics for rain alerts`;
  proof.added = await page.waitForSelector(added, { timeout: 5000 }).then(() => true, () => false);
  check("a card added at the foot of a column lands in it", proof.added);

  // Moving a card on is a button on the card; the gauge follows.
  await page.click(`${board} .column[data-column="next"] .card:has-text("Haptics for rain alerts") button[aria-label="Move on a stage"]`, { force: true });
  proof.moved = await page.waitForSelector(`${board} .column[data-column="doing"] .card >> text=Haptics for rain alerts`, { timeout: 5000 }).then(() => true, () => false);
  proof.gaugeAfter = await page.waitForSelector(`${board} .column[data-column="doing"] [data-plugin="wip"] .gauge[data-full]`, { timeout: 5000 }).then((el) => el.textContent(), () => "");
  check("moving a card on puts it in the next column, and the gauge follows", proof.moved && /3 of 3/.test(proof.gaugeAfter), proof.gaugeAfter);

  // A card's screen: its own address, controls that save as they change, and the checklist in the room it leaves.
  await page.click(`${icons} .title a`);
  const card = '[data-plugin="studio"][data-key$=":card"]';
  await page.waitForSelector(`${card} .sheet`, { timeout: 5000 });
  proof.address = new URL(page.url()).pathname;
  // The host prefixes ids in a view with its plugin and tab, so find the label by what it shows.
  await page.click(`${card} .covers label:has(.swatch[data-cover="lagoon"])`);
  proof.cover = await page.waitForSelector(`${card} .hero[data-cover="lagoon"]`, { timeout: 5000 }).then(() => true, () => false);
  const steps = `${card} slot [data-plugin="checklist"] .checklist`;
  await page.check(`${steps} li:has-text("Reduced-motion stills") input`);
  proof.ticked = await page.waitForSelector(`${steps} h3 small >> text=3/4`, { timeout: 5000 }).then(() => true, () => false);
  check("a card opens on its own screen, saves a change at once, and ticks a step in the checklist's room", proof.address.endsWith("/card/card-icons") && proof.cover && proof.ticked, proof.address);
  await page.click(`${card} .hero a`);
  await page.waitForSelector(`${board} .column`, { timeout: 5000 });
}
