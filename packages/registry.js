// The /packages/ page's search, filters, copy buttons and "Add to an app". The page is complete without it:
// every plugin is in the HTML (written by scripts/packages.mjs), and this only hides the ones
// that don't match. It builds no markup, so it needs nothing from the page's Trusted Types policy.

const find = document.getElementById("find");
const shown = document.querySelector(".shown");
const none = document.querySelector(".none");
const cards = [...document.querySelectorAll("li.card")];
const filters = [...document.querySelectorAll("[data-filter]")];
let filter = "all";

function apply() {
  const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
  let count = 0;
  for (const card of cards) {
    const text = card.dataset.search ?? "";
    const show = (filter === "all" || card.dataset.kind === filter) && words.every((w) => text.includes(w));
    card.hidden = !show;
    if (show) count++;
  }
  // A heading with nothing under it goes too, innermost first.
  for (const section of [...document.querySelectorAll("[data-section]")].reverse()) {
    section.hidden = !section.querySelector("li.card:not([hidden])");
  }
  shown.textContent = `${count} of ${cards.length} plugins and services`;
  none.hidden = count > 0;
  const url = new URL(location.href);
  if (find.value) url.searchParams.set("q", find.value);
  else url.searchParams.delete("q");
  if (filter !== "all") url.searchParams.set("kind", filter);
  else url.searchParams.delete("kind");
  history.replaceState(null, "", url);
}

function pick(name) {
  filter = filters.some((b) => b.dataset.filter === name) ? name : "all";
  for (const b of filters) b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
}

const params = new URLSearchParams(location.search);
find.value = params.get("q") ?? "";
pick(params.get("kind") ?? "all");
find.addEventListener("input", apply);
for (const b of filters) b.addEventListener("click", () => (pick(b.dataset.filter), apply()));
document.querySelector(".clear")?.addEventListener("click", () => ((find.value = ""), pick("all"), apply(), find.focus()));
if (find.value || filter !== "all") apply();

// "Add to an app": the list of apps is one popover for the whole page (the button opens it by itself). Each
// link in it is pointed at its app with #add=<id>, which the app's Customize answers by asking to add that
// plugin; the apps that link the plugin already are left out.
const addTo = document.getElementById("add-to");
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("button.add");
  if (!button || !addTo) return;
  const has = new Set((button.dataset.in ?? "").split(" ").filter(Boolean));
  addTo.querySelector(".what").textContent = button.dataset.name;
  for (const item of addTo.querySelectorAll("li[data-app]")) {
    item.hidden = has.has(item.dataset.app);
    const link = item.querySelector("a");
    link.hash = `add=${button.dataset.add}`;
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("button.copy");
  if (!button) return;
  const text = button.dataset.copy.startsWith("/") ? new URL(button.dataset.copy, location.origin).href : button.dataset.copy;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Couldn't copy";
  }
  setTimeout(() => (button.textContent = label), 1500);
});
