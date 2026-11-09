// A data folder from before the notes app was a plugin keeps its notes in
// notes.json at its top. The first time the notes plugin reads its
// collection, those notes come with it (src/kernel/legacy.ts), once.

import { watchErrors } from "../page-errors.mjs";

export default async function ({ check, context, URL, WORKBENCH, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "notes-carry-over");
  // A page on the same origin that starts no kernel, to put the old file in the origin's private folder first.
  await page.goto(`${URL}llms.txt`);
  const old = [
    { id: "old1", title: "Shopping", text: "Shopping\n\nEggs, milk", updated: Date.UTC(2026, 0, 2) },
    { id: "old2", title: "Ideas", text: "Ideas\n\nA plugin for everything", updated: Date.UTC(2026, 0, 3) },
    { id: "../bad", title: "Bad", text: "not carried over", updated: 1 },
  ];
  await page.evaluate(async (notes) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle("notes.json", { create: true })).createWritable();
    await file.write(JSON.stringify(notes));
    await file.close();
  }, old);

  await page.goto(WORKBENCH);
  await page.waitForFunction(() => window.__host);
  const listed = await page.waitForSelector('[data-key="notes:list"] >> text=Ideas', { timeout: 10000 }).then(() => true, () => false);
  const nav = await page.textContent('[data-key="notes:list"]').catch(() => "");
  check("notes kept in an old notes.json show in the notes plugin", listed && nav.includes("Shopping") && !nav.includes("Bad"), nav.replace(/\s+/g, " ").slice(0, 200));
  check("a folder with old notes isn't given the welcome note as well", !nav.includes("Welcome"));
  const opened = await page.click('[data-key="notes:list"] >> text=Shopping').then(() => page.waitForFunction(() => document.querySelector("textarea")?.value.includes("Eggs, milk"), null, { timeout: 5000 })).then(() => true, () => false);
  check("an old note opens with its text", opened);

  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle("collections");
    return JSON.parse(await (await (await folder.getFileHandle("notes.json")).getFile()).text());
  });
  check("the old notes are written to the notes collection, with their times", saved.old1?.updatedAt === new Date(Date.UTC(2026, 0, 2)).toISOString() && !!saved.old2 && Object.keys(saved).length === 2, Object.keys(saved).join(", "));
  await own.close();
}
