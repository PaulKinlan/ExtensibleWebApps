// The contacts demo: a live search box, and a vCard import through review.
// The runner (tests/platform.test.mjs) opens demos/contacts/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, proof }) {
  const people = '[data-key="people:people"]';
  await page.fill(`${people} input[type=search]`, "priya");
  proof.search = await page.waitForFunction((sel) => document.querySelectorAll(`${sel} ul li`).length === 1 && !document.querySelector(`${sel} ui-table`), people, { timeout: 5000 }).then(() => true, () => false);
  // A pasted vCard becomes a contact once the person accepts the review card.
  await page.fill('[data-key="vcard-import:form"] textarea', "BEGIN:VCARD\nVERSION:3.0\nFN:Katherine Johnson\nEMAIL;TYPE=work:katherine@example.com\nBDAY:19180826\nEND:VCARD");
  await page.click('[data-key="vcard-import:form"] button[type=submit]');
  await page.click('[data-key^="review:"] >> text=Accept', { timeout: 8000 });
  proof.vcard = await page.waitForSelector('[data-key="vcard-import:form"] >> text=Added 1 of 1', { timeout: 8000 }).then(() => true, () => false);
  check("a search box with data-live redraws the plugin's own list", proof.search);
  check("a vCard import writes a contact after review", proof.vcard);
}
