// @ts-check
// Two lines in an app's page that make it a place to open files, or to share
// to, once it is installed, without a manifest file of its own:
//
//   <meta name="file-handlers" content=".csv .tsv">
//   <meta name="share-target" content="title text url">
//
// The service worker puts them in the manifest it makes from the page
// (sw/routes/manifest.js), so an app made in the browser (which holds only
// app.html, plugins, templates, styles and agents) can have them too. Files
// open at the app's `open` screen, for the `launch` service; shares arrive
// at its `share` screen, for the `share` service (docs/guide/installing-and-
// files.md). The app maker refuses a page with a line these can't read
// (launchProblems, std/maker/module.ts), so a typo fails where it is made, not
// on someone's device later. The kernel loads this file only then.

import { tags } from "./made-page.js";

/** The kinds of file a `.ext` names. Anything else is written type/subtype:.ext. */
export const FILE_TYPES = /** @type {Record<string, string>} */ ({
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".vcf": "text/vcard",
  ".gpx": "application/gpx+xml",
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

const EXTENSION = /^\.[a-z0-9][a-z0-9+-]{0,15}$/i;
const MIME = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,63}$/i;
const SHARED = ["title", "text", "url"];
const MAX_TYPES = 20;

/**
 * The manifest's file_handlers from a file-handlers line: `.csv .tsv`, or `text/x-foo:.foo` for a kind of
 * file not in FILE_TYPES. Commas or spaces between them.
 * @param {string} content
 * @returns {{ value?: { action: string; accept: Record<string, string[]> }[]; problems: string[] }}
 */
export function fileHandlers(content) {
  /** @type {Record<string, string[]>} */
  const accept = {};
  const problems = [];
  const words = content.split(/[\s,]+/).filter(Boolean);
  if (!words.length) problems.push('file-handlers needs the kinds of file the app opens, such as content=".csv .tsv"');
  if (words.length > MAX_TYPES) problems.push(`file-handlers names at most ${MAX_TYPES} kinds of file`);
  for (const word of words.slice(0, MAX_TYPES)) {
    const colon = word.indexOf(":");
    const ext = (colon < 0 ? word : word.slice(colon + 1)).toLowerCase();
    const type = colon < 0 ? FILE_TYPES[ext] : word.slice(0, colon).toLowerCase();
    if (!EXTENSION.test(ext)) problems.push(`file-handlers: "${word}" isn't a file extension such as .csv`);
    else if (!type) problems.push(`file-handlers: the platform doesn't know what kind of file ${ext} is; write it as type/subtype:${ext}, such as text/plain:${ext}`);
    else if (!MIME.test(type)) problems.push(`file-handlers: "${type}" isn't a kind of file such as text/csv`);
    else (accept[type] ??= []).includes(ext) || accept[type].push(ext);
  }
  return problems.length ? { problems } : { value: [{ action: "open", accept }], problems };
}

/**
 * The manifest's share_target from a share-target line: which of title, text and url the app takes.
 * @param {string} content
 * @returns {{ value?: { action: string; method: string; params: Record<string, string> }; problems: string[] }}
 */
export function shareTarget(content) {
  const words = content.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const unknown = words.filter((w) => !SHARED.includes(w));
  if (!words.length || unknown.length) return { problems: [`share-target takes any of title, text and url, such as content="title text url"${unknown.length ? ` (not ${unknown.join(", ")})` : ""}`] };
  /** @type {Record<string, string>} */
  const params = {};
  for (const w of SHARED) if (words.includes(w)) params[w] = w;
  return { value: { action: "share", method: "GET", params }, problems: [] };
}

/**
 * What a page's two lines add to its manifest, and what is wrong with them.
 * @param {(name: string) => string | undefined} meta the content of the page's <meta name>, or undefined if it has none
 */
export function launchManifest(meta) {
  /** @type {Record<string, unknown>} */
  const manifest = {};
  const problems = [];
  const files = meta("file-handlers");
  if (files !== undefined) {
    const { value, problems: p } = fileHandlers(files);
    if (value) manifest.file_handlers = value;
    problems.push(...p);
  }
  const share = meta("share-target");
  if (share !== undefined) {
    const { value, problems: p } = shareTarget(share);
    if (value) manifest.share_target = value;
    problems.push(...p);
  }
  return { manifest, problems };
}

/**
 * What is wrong with the file-handlers and share-target lines in a page, with their line numbers.
 * @param {string} html
 */
export function launchProblems(html) {
  /** @type {{ line: number; message: string }[]} */
  const problems = [];
  for (const tag of tags(html).tags) {
    const which = tag.name === "meta" && !tag.closing ? (tag.attributes.name ?? "").toLowerCase() : "";
    if (which !== "file-handlers" && which !== "share-target") continue;
    for (const message of launchManifest((n) => (n === which ? (tag.attributes.content ?? "") : undefined)).problems) problems.push({ line: tag.line, message });
  }
  return problems;
}
