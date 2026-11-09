// File handlers and a share target from two lines in an app's page
// (sw/launch-meta.js), so an app made in the browser, which can't hold a
// manifest file, can be where files open and pages are shared to. Checked
// here without a browser: the manifest the service worker makes, and the
// checks the app maker runs to refuse a line it can't read.
import { fileHandlers, launchProblems, shareTarget } from "../../sw/launch-meta.js";
import { pageProblems } from "../../sw/made-page.js";
import { manifestFor } from "../../sw/routes/manifest.js";

const page = (head) => `<!doctype html><html><head><title>Logbook</title>${head}<script type="module" src="/platform/host.js"></script><link rel="plugin" href="log.js"></head><body><slot name="main"></slot></body></html>`;

export default async function ({ check }) {
  const lines = '<meta name="file-handlers" content=".csv .tsv, application/x-logbook:.logbook"><meta name="share-target" content="title url">';
  const made = manifestFor(page(lines), "/apps/logbook/");
  check(
    "<meta name=\"file-handlers\"> puts file_handlers in the manifest made from the page, opening at the app's open screen",
    JSON.stringify(made.file_handlers) === JSON.stringify([{ action: "open", accept: { "text/csv": [".csv"], "text/tab-separated-values": [".tsv"], "application/x-logbook": [".logbook"] } }]),
    JSON.stringify(made.file_handlers),
  );
  check(
    "<meta name=\"share-target\"> makes it a share target for the fields it names, at the app's share screen",
    JSON.stringify(made.share_target) === JSON.stringify({ action: "share", method: "GET", params: { title: "title", url: "url" } }),
    JSON.stringify(made.share_target),
  );
  const loose = manifestFor(page("<meta name = 'file-handlers' content = .csv><META NAME=share-target content=title>"), "/apps/logbook/");
  check("the lines are read as a browser reads them: any quotes, spaces around =, any case", loose.file_handlers?.[0]?.accept?.["text/csv"]?.[0] === ".csv" && loose.share_target?.params?.title === "title", JSON.stringify([loose.file_handlers, loose.share_target]));
  const plain = manifestFor(page(""), "/apps/logbook/");
  check("a page without the lines gets neither", !("file_handlers" in plain) && !("share_target" in plain), JSON.stringify(Object.keys(plain)));
  check("a made app's page may hold the two lines", pageProblems(page(lines)).length === 0 && launchProblems(page(lines)).length === 0, JSON.stringify([pageProblems(page(lines)), launchProblems(page(lines))]));

  // A line the manifest can't use fails where it is written, not on someone's device later.
  const unknown = launchProblems(page('<meta name="file-handlers" content=".wat">'));
  check("a file extension the platform doesn't know is refused, saying how to name its type", unknown.length === 1 && /type\/subtype:\.wat/.test(unknown[0].message), JSON.stringify(unknown));
  const badShare = launchProblems(page('<meta name="share-target" content="title files">'));
  check("a share target can only take title, text and url", badShare.length === 1 && /not files/.test(badShare[0].message), JSON.stringify(badShare));
  const empty = [fileHandlers("").problems.length, shareTarget(" ").problems.length];
  check("an empty line is refused too", empty.every((n) => n === 1), JSON.stringify(empty));
  check("and a manifest isn't given half a line", !("file_handlers" in manifestFor(page('<meta name="file-handlers" content=".csv .wat">'), "/apps/logbook/")));
}
