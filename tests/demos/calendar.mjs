// The calendar demo: nested template loops, a plugin stylesheet, and live views.
// The runner (tests/platform.test.mjs) opens demos/calendar/app.html, checks every
// plugin it links draws, then calls this with that page and the shared helpers.
export default async function (page, { check, openTab, URL, proof }) {
  // The contacts app hasn't run yet, so the agenda has no contacts to read, and says so.
  proof.noContacts = await page.waitForSelector('[data-key="agenda:agenda"] >> text=Open the Contacts app once', { timeout: 5000 }).then(() => true, () => false);
  // The month grid is two nested template loops: a row per week, seven days each.
  proof.grid = await page.evaluate(() => [...document.querySelectorAll('[data-key="month:grid"] tbody tr')].map((tr) => tr.children.length));
  // month.html's own <style> lays out its grid, and reaches nothing outside the month plugin's views.
  proof.styled = await page.evaluate(() => {
    const grid = document.querySelector('[data-key="month:grid"]');
    const outside = document.body.appendChild(Object.assign(document.createElement("table"), { className: "month" }));
    const style = (el) => el && getComputedStyle(el);
    const result = {
      plugin: grid?.dataset.plugin,
      layout: style(grid?.querySelector(".month"))?.tableLayout,
      other: style(grid?.querySelector("td[data-other]"))?.opacity,
      own: style(grid?.querySelector("td:not([data-other])"))?.opacity,
      outside: style(outside)?.tableLayout,
    };
    // A plugin's CSS can't reach the entry that holds the containment, even with :scope.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('@layer plugins { @scope ([data-plugin="month"] > *) { :scope { position: fixed; } } }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    result.entry = [style(grid).position, style(grid).contain];
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    outside.remove();
    return result;
  });
  // The agenda is a live view: when the contacts app first runs, in another tab, the birthdays appear here without a reload.
  proof.quietRead = await page.evaluate(() => !window.__host.traces.some((e) => /No collection named contacts/.test(e.detail ?? "")));
  const contactsTab = await openTab(`${URL}demos/contacts/app.html`);
  proof.liveBirthday = await page.waitForSelector('[data-key="agenda:agenda"] >> text=Priya Shah', { timeout: 8000 }).then(() => true, () => false);
  await contactsTab.close({ runBeforeUnload: true });
  // The month moves with its own state: refresh() draws it again.
  const title = await page.textContent('[data-key="month:grid"] h2');
  await page.click('[data-key="month:grid"] button[aria-label="Next month"]');
  proof.nextMonth = await page.waitForFunction((t) => document.querySelector('[data-key="month:grid"] h2')?.textContent !== t, title, { timeout: 5000 }).then(() => true, () => false);
  check("a month grid from nested template loops has seven days in every week", proof.grid?.length >= 4 && proof.grid.every((n) => n === 7), JSON.stringify(proof.grid));
  check("a plugin's own stylesheet styles its views, by class, and nothing else on the page", proof.styled?.plugin === "month" && proof.styled.layout === "fixed" && proof.styled.other === "0.6" && proof.styled.own === "1" && proof.styled.outside !== "fixed" && proof.styled.entry[0] !== "fixed" && proof.styled.entry[1] === "layout paint", JSON.stringify(proof.styled));
  check("reading a collection that doesn't exist yet gives an empty list, not an error", proof.quietRead);
  check("a live view fills in when a collection it reads first appears, from another app's tab", proof.liveBirthday);
  check("a live view draws again on refresh() after the plugin's own state changes", proof.nextMonth);
}

// After every demo has run, the contacts app has too.
export async function after({ check, openTab, URL, proof }) {
  // The calendar reads the contacts app's collection, though no contacts plugin is running now.
  const calendar = await openTab(`${URL}demos/calendar/app.html`);
  const birthday = await calendar.waitForSelector('[data-key="agenda:agenda"] >> text=Priya Shah', { timeout: 8000 }).then(() => true, () => false);
  await calendar.close({ runBeforeUnload: true });
  check("one app reads another app's collection while that app is closed", proof.noContacts && birthday, `before contacts ran: ${proof.noContacts}, after: ${birthday}`);
}
