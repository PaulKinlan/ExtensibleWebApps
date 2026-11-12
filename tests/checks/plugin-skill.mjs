// The skill that tells Claude Code how to write a plugin (.claude/skills/extensible-plugin/, explained in
// docs/guide/asking-an-agent.md) stays true to the platform it comes with:
//
//   - its worked example passes `npm run check` with nothing to fix, not even a style note;
//   - every doc it sends an agent to, every file it links, and every design token and ui-* element it
//     names is really in the platform, so a rename here fails until the skill is put right;
//   - a project made by create-extensible-app gets the skill, and the skill's example passes that
//     project's own check;
//   - the repo is a Claude Code plugin that loads it (.claude-plugin/).
//
// It needs no browser.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkApps } from "../../scripts/check.mjs";
import { makeProject, SKILL } from "../../scripts/create-app.mjs";
import { check as checkProject } from "../../scripts/extensible-app.mjs";

export default async function ({ check }) {
  const said = (app) => [...app.problems.map((p) => `${p.file}: ${p.message}`), ...app.style.map((n) => `${n.file}:${n.line} ${n.message}`)].join(" | ");

  const [example] = await checkApps([`${SKILL}/example`]);
  check("the skill's example passes npm run check, with no style notes", example.plugins.join() === "reading,reading-count" && !example.problems.length && !example.style.length, said(example));

  const every = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? every(join(folder, e.name)) : [join(folder, e.name)]));
  const files = every(SKILL);
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const [, front = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill) ?? [];
  const field = (name) => new RegExp(`^${name}: (.+)$`, "m").exec(front)?.[1] ?? "";
  // Claude reads the description to decide when to use the skill; other places that take skills allow 1024 characters and no angle brackets left open.
  check("the skill's frontmatter names it after its folder, with a description short enough everywhere skills are read", field("name") === SKILL.split("/").pop() && field("description").length > 80 && field("description").length <= 1024, `${field("name")}: ${field("description").length}`);
  check("the skill stays short: the guide and the API reference are where the detail is", body.split("\n").length < 300, String(body.split("\n").length));

  // What it sends an agent to read.
  const docs = [...new Set([...skill.matchAll(/`PLATFORM\/([\w./-]+)`/g)].map((m) => m[1]))];
  const guide = [...new Set([...body.matchAll(/\| `([\w-]+\.md)`/g), ...body.matchAll(/, `([\w-]+\.md)`/g)].map((m) => m[1]))];
  const lostDocs = [...docs.filter((path) => !existsSync(path)), ...guide.filter((page) => !existsSync(join("docs/guide", page))).map((page) => `docs/guide/${page}`)];
  check("every doc the skill sends an agent to is in the platform", docs.length > 4 && guide.length > 8 && !lostDocs.length, lostDocs.join(", "));
  const links = files.filter((f) => f.endsWith(".md")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\]\((?!https?:|#)([^)#]+)/g)].map((m) => resolve(dirname(f), m[1])));
  check("every file the skill links is in the skill", links.length > 1 && links.every((path) => existsSync(path)), links.filter((path) => !existsSync(path)).join(", "));
  const api = readFileSync("docs/api.md", "utf8");
  const headings = [...body.matchAll(/`(## [A-Z][\w ]+)`/g)].map((m) => m[1]);
  check("the sections of the API reference the skill says to search for are there", headings.length > 3 && headings.every((h) => api.includes(`\n${h}\n`)), headings.filter((h) => !api.includes(`\n${h}\n`)).join(", "));

  // What it names: the tokens and the elements, in the skill and in its example.
  const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const styles = readFileSync("src/host/styles.css", "utf8");
  const tokens = [...new Set([...text.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter((token) => token !== "--pct");
  const noToken = tokens.filter((token) => !new RegExp(`${token}\\s*:`).test(styles));
  check("every design token the skill names is one the platform's stylesheet sets", tokens.length > 10 && !noToken.length, noToken.join(", "));
  const elements = [...new Set([...text.matchAll(/\bui-[a-z]+\b(?![-*:])/g)].map((m) => m[0]))];
  const noElement = elements.filter((tag) => !existsSync(`elements/${tag}.html`));
  check("every ui-* element the skill names is one of the platform's", elements.length > 6 && !noElement.length, noElement.join(", "));

  // A project of your own gets it, and the example is right there too.
  const scratch = mkdtempSync(join(tmpdir(), "plugin-skill-"));
  try {
    const { folder } = makeProject(join(scratch, "book-club"));
    const copied = every(join(folder, SKILL)).map((f) => f.slice(folder.length + 1).split("\\").join("/")).sort();
    check("create-extensible-app puts the whole skill in the project, in a folder that is never served", copied.join() === files.map((f) => f.split("\\").join("/")).sort().join() && readFileSync(join(folder, SKILL, "SKILL.md"), "utf8") === skill && /extensible-plugin/.test(readFileSync(join(folder, "README.md"), "utf8")));
    // The example's two plugins, added to the project as the skill says: beside app.html, and linked from it.
    for (const file of ["reading.js", "reading.html", "reading-count.js"]) cpSync(join(folder, SKILL, "example", file), join(folder, file));
    cpSync(join(folder, SKILL, "example", "app.html"), join(folder, "app.html"));
    const inProject = await checkProject(folder);
    check("the example's plugins pass a project's own check", inProject.plugins.join() === "reading,reading-count" && !inProject.problems.length && !inProject.style.length, said(inProject));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // The repo as a Claude Code plugin: no version (so an install follows main), and its skills are this folder's.
  const plugin = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
  const market = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
  check(
    "the repo is a Claude Code plugin whose skills are .claude/skills/, listed by a marketplace in the same repo",
    [plugin.skills].flat().some((path) => resolve(path) === resolve(dirname(SKILL))) && plugin.version === undefined && !/claude|anthropic/i.test(plugin.name) && market.plugins?.length === 1 && market.plugins[0].name === plugin.name && market.plugins[0].source === "./" && !!market.owner?.name,
    JSON.stringify({ skills: plugin.skills, market: market.plugins }),
  );
}
