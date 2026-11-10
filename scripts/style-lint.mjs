// Reads the CSS a plugin or page wrote and notes what DESIGN.md asks it not to
// write: a colour given as a raw value, and a size written by hand where a
// token exists. It reads the files as written, so it needs no build and no
// browser.
//
//   npm run check -- --style             every app in demos/, with each note listed
//   npm run check demos/habits --style   one app
//   node scripts/style-lint.mjs std      any folder
//
// What it notes, in every <style> block of every .html file in the folder:
//   colour   #hex, rgb(), hsl(), oklch() and the like. Use a colour token
//            (--fg, --surface, --border, --accent, --danger, …) or mix them:
//            color-mix(in srgb, var(--accent) 20%, transparent).
//   size     px or rem in font-size, gap, padding, margin and border-radius.
//            Use --text-*, --space-* and --radius*.
//
// What it leaves alone:
//   - the fallback inside var(--token, fallback);
//   - anything under 4px (a hairline or a nudge is not a spacing decision) and
//     a border-radius of 999px or more (a pill);
//   - text in quotes and what url() points at;
//   - a custom property an app.html sets: a page is where a theme is written;
//   - a line that says why, in a comment: /* design-ok: the game's own palette */
//   - a whole file (every <style> in it) whose first <style> starts with /* design-ok-file: reason */
//
// A note never fails `npm run check`. tests/checks/style-lint.mjs holds each
// folder to the count in tests/style-baseline.json, so the number only goes down.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
const SIZED = /^(?:font-size|gap|row-gap|column-gap|border-radius|(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?)$/;
const TOKEN_FOR = (prop) => (prop === "font-size" ? "--text-*" : prop === "border-radius" ? "--radius, --radius-sm or --radius-lg" : "--space-*");

/** `value` without any var(…), so a fallback written inside one isn't read as the plugin's own choice. */
function withoutVars(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      for (; i < value.length; i++) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")" && --depth === 0) break;
      }
      out += "var()";
    } else out += value[i];
  }
  return out;
}

/**
 * The notes for one file's text.
 * @param {string} source the file, HTML with <style> blocks
 * @param {{ page?: boolean }} [options] page: an app.html, which may set custom properties to raw values
 * @returns {{ line: number; kind: "colour" | "size"; message: string }[]}
 */
export function lintSource(source, { page = false } = {}) {
  const notes = [];
  // An HTML comment that mentions <style> is not a stylesheet: blank the comments, keeping every offset.
  const html = source.replace(/<!--[^]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const blocks = [...html.matchAll(/<style\b[^>]*>([^]*?)<\/style>/g)];
  if (blocks.length && /^\s*\/\*\s*design-ok-file:/.test(blocks[0][1])) return notes;
  for (const block of blocks) {
    const css = block[1];
    const start = block.index + block[0].indexOf(css);
    const allowed = new Set();
    const lineOf = (offset) => source.slice(0, start + offset).split("\n").length;
    // Blank the comments, keeping every offset, and remember the lines that say why they are as they are.
    const plain = css.replace(/\/\*[^]*?\*\//g, (m, offset) => {
      if (/design-ok:/.test(m)) for (let l = lineOf(offset), end = lineOf(offset + m.length); l <= end; l++) allowed.add(l);
      return m.replace(/[^\n]/g, " ");
    });
    // A declaration ends at ; or }, which a selector (a:hover {) never does.
    for (const d of plain.matchAll(/(?<=^|[;{}\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
      const [, prop, raw] = d;
      const line = lineOf(d.index);
      if (allowed.has(line)) continue;
      if (page && prop.startsWith("--")) continue;
      // Not the plugin's choice of colour or size: a var() fallback, text in quotes, and what url() points at (url(#clip)).
      const value = withoutVars(raw).replace(/"[^"]*"|'[^']*'/g, '""').replace(/url\([^)]*\)/gi, "url()");
      const colour = value.match(COLOUR);
      if (colour) notes.push({ line, kind: "colour", message: `${prop}: ${raw.replace(/\s+/g, " ")}  is a raw colour; use a colour token, or color-mix() of them` });
      if (SIZED.test(prop)) {
        const fixed = [...value.matchAll(/(?<![\w.-])(-?\d*\.?\d+)(px|rem)\b/g)].filter((m) => {
          const px = Math.abs(Number(m[1])) * (m[2] === "rem" ? 16 : 1);
          return px >= 4 && !(prop === "border-radius" && px >= 999);
        });
        if (fixed.length) notes.push({ line, kind: "size", message: `${prop}: ${raw.replace(/\s+/g, " ")}  is a size written by hand; use ${TOKEN_FOR(prop)}` });
      }
    }
  }
  return notes;
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

/**
 * Every note for the .html files in a folder (or for one file).
 * @param {string} target
 * @returns {{ file: string; line: number; kind: "colour" | "size"; message: string }[]}
 */
export function lintStyles(target) {
  const path = resolve(target);
  if (!existsSync(path)) return [];
  const files = statSync(path).isDirectory() ? htmlFiles(path) : [path];
  return files.flatMap((file) => lintSource(readFileSync(file, "utf8"), { page: basename(file) === "app.html" }).map((n) => ({ file: relative(process.cwd(), file), ...n })));
}

/** "3 raw colours, 2 fixed sizes" */
export const tally = (notes) => {
  const colours = notes.filter((n) => n.kind === "colour").length;
  const sizes = notes.length - colours;
  return `${colours} raw colour${colours === 1 ? "" : "s"}, ${sizes} fixed size${sizes === 1 ? "" : "s"}`;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = process.argv.slice(2);
  if (!targets.length) console.log("usage: node scripts/style-lint.mjs <folder or file>…");
  for (const target of targets) {
    const notes = lintStyles(target);
    console.log(`${notes.length ? "·" : "✓"} ${target}  ${tally(notes)}`);
    for (const n of notes) console.log(`    ${n.file}:${n.line}  ${n.message}`);
  }
}
