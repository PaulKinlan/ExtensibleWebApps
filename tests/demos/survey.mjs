// The survey demo outside a space: the builder works, says where answers are
// collected, and shows each survey's questions (tests/server/run.mjs checks
// the public form and the answers, on a space's server).
export default async function (page, { check, proof }) {
  const view = '[data-plugin="surveys"]';
  await page.waitForSelector(`${view} .survey`, { timeout: 8000 });
  proof.sample = await page.locator(`${view} .survey[key="sample-launch"] .results > li`).count();
  proof.note = await page.locator(`${view} .note`).count();
  proof.meters = await page.locator(`${view} .survey[key="sample-launch"] meter[aria-label]`).count();
  check("the survey builder shows the sample's questions, with a bar for each choice named for it, and offers a space for sharing in one line", proof.sample === 3 && proof.meters === 6 && proof.note === 1, JSON.stringify({ sample: proof.sample, meters: proof.meters, note: proof.note }));

  await page.fill(`${view} ui-form input[name=title]`, "Team offsite");
  await page.fill(`${view} ui-form textarea[name=questions]`, "Which month: May | June\nOne thing to try");
  await page.click(`${view} ui-form button[type=submit]`);
  proof.made = await page.waitForSelector(`${view} .survey:has-text("Team offsite") .bar:has-text("June")`, { timeout: 5000 }).then(() => true, () => false);
  check("a new survey's lines become questions, and a line with choices after a colon a multiple choice", proof.made);
}
