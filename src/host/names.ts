// How a person sees a part of the page: its label, heading or first words,
// and its id or tag. Arrange mode (arrange.ts) and Customize's Layout
// (bridges/customize.ts) name parts this way.

export function nameOf(el: Element): string {
  // Its own words: not what places or plugins' views added inside it.
  const copy = el.cloneNode(true) as Element;
  for (const added of copy.querySelectorAll(".place, slot, [data-plugin]")) added.remove();
  const words = (el.getAttribute("aria-label") ?? copy.querySelector("h1, h2, h3, h4")?.textContent ?? copy.textContent ?? "").trim().replace(/\s+/g, " ");
  const what = el.id ? `#${el.id}` : el.localName === "slot" ? `slot ${el.getAttribute("name")}` : el.localName;
  return words ? `“${words.length > 32 ? `${words.slice(0, 32)}…` : words}” (${what})` : what;
}
