# Installing an app, offline, and opening files with it

Every app on the platform can be installed from the browser, opens with no network once it has been opened, and can be where a kind of file opens.

## Installable, with no work

The host links each app's page to `manifest.webmanifest` in its folder ([`src/host/install.ts`](../../src/host/install.ts)). If the folder has that file, it is the app's manifest. If not, the service worker makes one from the page ([`sw/routes/manifest.js`](../../sw/routes/manifest.js)):

| From the page | In the manifest |
| --- | --- |
| `<title>` (the part before a ` · `) | `name`, and `short_name` (its first word if it is over 12 characters) |
| `<meta name="short-name">` | `short_name`, the name under the installed app's icon, when the title's first word isn't right |
| `<meta name="description">` | `description` |
| `<meta name="theme-color">` | `theme_color` |
| `<link rel="icon">` | the icon (else the platform's, [`/app-icon.svg`](../../public/app-icon.svg)) |
| the app's folder | `id`, `start_url` and `scope`: an app opened in a space installs in that space |

So `demos/habits/` installs as "Habits", and an app made in the browser at `/apps/tally/` installs as itself too. The link goes in once the service worker controls the page: on a very first visit there is nothing at that address yet.

Two more lines in the page make the app a place to open files or share to, with no manifest file ([`sw/launch-meta.js`](../../sw/launch-meta.js)):

| From the page | In the manifest |
| --- | --- |
| `<meta name="file-handlers" content=".csv .tsv">` | `file_handlers`, opening those files at the app's `open` screen. A kind of file the platform doesn't know is written `type/subtype:.ext`, such as `application/x-logbook:.logbook` |
| `<meta name="share-target" content="title text url">` | `share_target`, taking the fields named at the app's `share` screen |

An app made in the browser holds only its page, plugins, templates and styles, so these lines are how it does either. The page checks for made apps refuse a line the manifest couldn't use (an extension it doesn't know, a field that isn't title, text or url), so the mistake shows when the app is made, not when someone installs it.

Write your own `manifest.webmanifest` when the app needs more than that: shortcuts, screenshots, a share target that takes files. The reading list has one.

## Offline

The service worker ([`sw.js`](../../sw.js)) keeps every file it serves, so an app that has been opened once opens again with no network: its page, the platform, its plugins and their templates. Data is in the browser already. A space's own data syncs when the network is back ([spaces](spaces-and-servers.md)).

## Opening files with an app

An installed app can be where a kind of file opens: "Open with Reading list" on an ebook. Its manifest names the screen they open at, and the types:

```json
"file_handlers": [
  { "action": "open", "accept": { "application/pdf": [".pdf"], "application/epub+zip": [".epub"] } }
]
```

The app opens at its `open` screen and the browser hands the page the files. A plugin with the `launch` permission (and `services: ["launch"]`) hears `launch:received` and takes them, once:

```js
ctx.on("launch:received", receive);
await receive(); // opening the file may have started the app

async function receive() {
  for (const file of await ctx.call("launch", "take")) {
    // { name, type, size, lastModified, text? }: text for a text file of at most 5 MB
  }
}
```

Taking them moves the tab back to the app's own address, so a reload doesn't open them again. [`demos/reading-list/book-files.js`](../../demos/reading-list/book-files.js) adds each ebook as a book to read. Sharing a page to an app works the same way, with the `share` service and `share_target`.

## The page's policy

Every page is sent with a policy ([`public/_headers`](../../public/_headers)), so a mistake in a page or a plugin can't become script:

- **Scripts only from the site's files.** No inline `<script>`: put it in a file next to the page.
- **Trusted Types.** Markup, script text and script addresses reach the page only through named policies. Plugins never see this: their views are copied into the page element by element ([`src/host/sanitize.ts`](../../src/host/sanitize.ts)). Code on the page that sets `innerHTML` from a string is refused; build elements, or use a policy named in the header ([`src/host/trusted.ts`](../../src/host/trusted.ts)).
- **Permissions-Policy.** Device features no app uses (camera, location, USB, payments…) are off.

The test run fails on any page that breaks it ([`tests/policy-watch.mjs`](../../tests/policy-watch.mjs)), and on a page or platform file over the [performance budget](../../tests/perf-budget.json) ([`tests/checks/perf-budget.mjs`](../../tests/checks/perf-budget.mjs)).
