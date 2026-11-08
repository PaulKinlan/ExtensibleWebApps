// Fetches a page on this site a moment before the person opens it: when the
// pointer rests on a link, or a finger presses it (speculation rules,
// "moderate"). Opening it then skips the wait for its HTML.
//
// Only prefetch, never prerender: a prerendered page would start its host,
// join the kernel and claim plugin workers for a tab the person may never
// open. Sign-in addresses are left out, and a link can opt out with
// data-no-prefetch. A page that writes its own rules keeps them.

export function speculate(): void {
  if (!HTMLScriptElement.supports?.("speculationrules")) return;
  if (document.querySelector('script[type="speculationrules"]')) return;
  const script = document.createElement("script");
  script.type = "speculationrules";
  script.textContent = JSON.stringify({
    prefetch: [
      {
        where: {
          and: [{ href_matches: "/*" }, { not: { href_matches: "/auth/*" } }, { not: { selector_matches: "[data-no-prefetch], [download], [target]" } }],
        },
        eagerness: "moderate",
      },
    ],
  });
  document.head.append(script);
}
