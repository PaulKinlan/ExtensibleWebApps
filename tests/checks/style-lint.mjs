// The style notes (scripts/style-lint.mjs) only go down. Each folder of apps,
// plugins and elements is held to the number of raw colours and hand-written
// sizes it had when tests/style-baseline.json was last lowered; a folder that
// isn't listed there (a new app) is held to none. DESIGN.md says what to write
// instead, and how to say that a value is what it is on purpose.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lintSource, lintStyles, tally } from "../../scripts/style-lint.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default async function ({ check }) {
  const kinds = (css, options) => lintSource(`<style>\n${css}\n</style>`, options).map((n) => `${n.kind}:${n.line}`).join(" ");
  const cases = [
    ["a raw colour", ".a { color: #fff; }", "colour:2"],
    ["a colour function in a shadow", ".a { box-shadow: 0 1px 2px rgb(0 0 0 / 0.2); }", "colour:2"],
    ["a size written by hand", ".a {\n  padding: 12px 0;\n  font-size: 0.8rem }", "size:3 size:4"],
    ["tokens", ".a { color: var(--fg); padding: var(--space-3) 0; background: color-mix(in srgb, var(--accent) 20%, transparent); }", ""],
    ["a fallback inside var()", ".a { height: var(--control, 38px); color: var(--action-fg, var(--bg, #fff)); padding: var(--space-2, 8px); }", ""],
    ["a hairline, a nudge and a pill", ".a { margin: 1px 0 2px; border-radius: 999px; gap: 0; }", ""],
    ["an id or a pseudo-class in a selector", "#fff000:hover, .a:not(#bed) { color: var(--fg); }", ""],
    ["a line that says why", ".a { color: #fc0; /* design-ok: the game's own gold */ }", ""],
    ["a size the tokens don't cover", ".a { width: 240px; height: 12rem; }", ""],
  ];
  const wrong = cases.filter(([, css, want]) => kinds(css) !== want).map(([name, css]) => `${name}: ${kinds(css) || "nothing"}`);
  if (kinds(":root { --bg: #101010; }", { page: true }) !== "") wrong.push("a page setting a token");
  if (kinds(".a { --mine: #101010; }") !== "colour:2") wrong.push("a plugin setting a property to a raw colour");
  if (lintSource("<style>/* design-ok-file: a game */\n.a { color: #fff }</style>").length) wrong.push("a file that says why");
  check("the style lint notes raw colours and hand-written sizes, and leaves tokens, fallbacks and explained lines alone", wrong.length === 0, wrong.join("; "));

  const baseline = JSON.parse(readFileSync(new URL("../style-baseline.json", import.meta.url), "utf8")).folders;
  const demos = readdirSync(`${ROOT}demos`).filter((name) => existsSync(`${ROOT}demos/${name}/app.html`)).map((name) => `demos/${name}`);
  const over = [];
  let total = 0;
  for (const folder of [...demos, "std", "account", "elements"]) {
    const notes = lintStyles(`${ROOT}${folder}`);
    total += notes.length;
    const allowed = baseline[folder] ?? 0;
    if (notes.length > allowed) over.push(`${folder} has ${notes.length} (${tally(notes)}), ${allowed} allowed: run \`node scripts/style-lint.mjs ${folder}\` and use the tokens in DESIGN.md`);
  }
  check(`no folder has more raw colours or hand-written sizes than its baseline (${total} left to clean)`, over.length === 0, over.join("; "));
}
