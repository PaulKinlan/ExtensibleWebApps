// @ts-check
// Draws Mermaid diagrams, for <ui-diagram> and the ```mermaid blocks in
// <ui-markdown>. Mermaid itself (vendor/mermaid/) is large, so it is added to
// the page only the first time a diagram is drawn.
//
// It runs with Mermaid's strict security level: the diagram's text can't
// add script, event handlers or links that run code, so a diagram from a
// plugin is as safe to draw as one from the docs.

/** @type {Promise<any> | undefined} */
let loading;
let count = 0;

/** Loads Mermaid once, from this site. */
function load() {
  loading ??= new Promise((resolve, reject) => {
    const ready = /** @type {any} */ (globalThis).mermaid;
    if (ready) return resolve(ready);
    const script = document.createElement("script");
    script.src = "/vendor/mermaid/mermaid.min.js";
    script.onload = () => resolve(/** @type {any} */ (globalThis).mermaid);
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Couldn't load Mermaid from /vendor/mermaid/"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Whether the page is dark: the person's setting on the page, or their system's. */
function dark() {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Draws `text` as a diagram into `target`, replacing what is there. On a
 * mistake in the diagram, shows its text and what Mermaid said instead.
 * @param {string} text
 * @param {Element} target
 * @param {string} [label] what the diagram shows, for people who can't see it
 */
export async function draw(text, target, label = "") {
  try {
    const mermaid = await load();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "neutral", fontFamily: "inherit" });
    const { svg } = await mermaid.render(`ui-diagram-${++count}`, text.trim());
    // Mermaid's strict level has already cleaned the SVG of script and handlers.
    target.innerHTML = svg;
    const drawn = target.querySelector("svg");
    if (drawn) {
      drawn.setAttribute("role", "img");
      if (label) drawn.setAttribute("aria-label", label);
      drawn.removeAttribute("height");
      drawn.style.maxWidth = "100%";
    }
  } catch (error) {
    const note = document.createElement("p");
    note.className = "diagram-error";
    note.textContent = `This diagram couldn't be drawn: ${error instanceof Error ? error.message : String(error)}`;
    const source = document.createElement("pre");
    source.textContent = text;
    target.replaceChildren(note, source);
  }
}
