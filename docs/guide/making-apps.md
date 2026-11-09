# Making an app by describing it

A person types the app they want, "a reading list with a Sunday reminder",
and gets one that works: an `app.html` and its plugins, like any app in
[`demos/`](../../demos/), that they can open, change, add their own plugins
to, and switch parts of off. The site's page for this is
[`/new/`](../../site/new/app.html). It is built from three standard pieces in
[`std/maker/`](../../std/maker/), which any app can link:

| Piece | What it does |
| --- | --- |
| [`app-maker.agent.md`](../../std/maker/app-maker.agent.md) | The agent. It reads what the person wrote, plans a small app (one plugin per job, each with its template), writes every file, checks the app and fixes what fails. Its only rights are `apps:make`, `apps:read` and `bus:ask`, so its tools are the maker service and a question to the person. |
| [`module.ts`](../../std/maker/module.ts) | The `maker` kernel module: the `maker` service, which keeps the person's apps in their data folder, saves files only after a review, keeps each file's versions, and checks an app. |
| [`your-apps.js`](../../std/maker/your-apps.js) | The box to describe an app (or a change to one), what the agent is doing, the person's apps, a live preview of the one picked (`<ui-preview>`), and each file's history. |

```mermaid
sequenceDiagram
    participant P as The person
    participant Y as your-apps.js
    participant A as The app maker
    participant M as maker service
    participant V as The preview

    P->>Y: "A reading list with a Sunday reminder"
    Y->>A: bus.send, waits for the answer
    A->>M: maker.save(app, every file)
    M->>P: one review card: every file, in full
    P-->>M: Accept
    M-->>A: saved, and what the checks of the files found
    A->>M: maker.check(app)
    M->>V: open the app again (maker:check)
    V-->>M: what failed as it ran, from the trace
    M-->>A: problems, by file
    A->>M: maker.save(the fix), another card
    A-->>Y: "Made it: /apps/reading-list/"
```

## Where a made app lives

A made app is kept on the person's device, in their data folder at
`made/apps/<name>/`, and the service worker serves it at `/apps/<name>/`
([`sw/routes/made.js`](../../sw/routes/made.js)). `made` is one of the
platform's folders, so no plugin can write there; only the maker service
can, after the person accepts.

Its page was written by a model, so it may be layout and nothing else
([`sw/made-page.js`](../../sw/made-page.js)): the platform's script and
stylesheet, a `<title>`, slots, plain HTML, a `<style>`, and `<link
rel="plugin">` lines to files on this site. No other script, no `on…=`
handlers, no frames, no `javascript:` links. The maker refuses a page that
breaks a rule, saying which and where, before the person is asked; the
service worker checks it again before it serves it, and sends a policy under
which no inline script runs. The app's code is in its plugins, which run in
workers with the permissions they ask for, like any app's.

Saving a changed plugin replaces the copy that is running, in place, so
every tab with the app open restarts it with the new code; the preview also
opens again by itself. A plugin whose id changed, or whose new code won't
start, is stopped instead, and the check says why.

A made app links only its own files and the standard plugins it chose, never
the model or the app maker. Switch both off, or close `/new/`, and it keeps
working. It may also link a package from the [plugin
registry](plugin-registry.md), such as `/packages/clock/clock.js`, and call
the service it provides; the checks count it.

## Taking it to a folder, and back

A made app lives on the device that made it, until the person saves it to a
folder. **Save to a folder** in Your apps (`maker.saveToFolder(app)`) writes
a copy of its files into a folder they pick on their disk. **Open from a
folder** (`maker.openFolder(app?)`) reads `app.html` and the plugins,
templates, styles and agents beside it from a folder they pick, and saves
them as a made app, named after the folder, after one review card like any
save; other files are left out. So an app goes to another device by way of a
folder (a synced drive, a USB stick, a git repository), and a saved copy is a
plain app folder that `npm run check` reads in a checkout, as it reads the
demos. Both need a click first, since the browser opens its folder picker
only right after one ([`src/host/bridges/maker.ts`](../../src/host/bridges/maker.ts)),
and a browser with no `showDirectoryPicker` says so.

## Sharing it with a space

An app made in a space, at `/s/<space>/new/`, is kept in the space's folder on
the device that made it and served at `/s/<space>/apps/<name>/`. **Share with
the space** (`maker.share(app)`, after a review card) sends a copy of its files
to the space ([`std/spaces/made-apps.ts`](../../std/spaces/made-apps.ts)),
which keeps them and never runs them.

Every other member then sees it in their Your apps, under **Shared in this
space**, with who shared it. It runs for them only once they press **Accept**
and accept its files on a review card, the same card any save shows
(`maker.accept(app)`); then it is a made app on their device like any other,
with its own history. When the sharer changes it and shares it again, each
member sees **new version**, and the change reaches them the same way: a card
that shows what changed, before anything runs. `maker.shared()` lists the
space's apps and how each stands on this device.

**Stop sharing** (`maker.unshare(app)`) takes it off the space's list. Members
who accepted it keep their copy. An app made outside a space, at `/new/` on
the same device, is listed in the space's Your apps under **Your apps outside
this space**: **Copy into this space** (`maker.copyIn(app)`) saves a copy of it
there after the usual review, and then it can be shared. From another device,
it goes in through a folder: **Save to a folder** at `/new/`, then **Open from
a folder** at `/s/<space>/new/`.

## Saving, versions and going back

`maker.save(app, files, note)` writes several files at once, after one
review card that shows every changed file in full, before and after. The card
never offers "Always allow": each save is new code. A change too big for one
card to show whole is refused, and the app maker saves it in smaller parts. The
first save of an app must hold its `app.html`. Each file keeps its last 50
versions, with who saved each and why: `maker.history(app, file)` lists them
and `maker.version(app, file, n)` reads one. `maker.restore(app, file, n)`
puts one back, after a review; it becomes the newest version, so a restore
can be undone the same way. Your apps lists every file with its versions and
a "Put this back" button on each.

## Checks

`maker.check(app)` runs the same checks `npm run check` makes on an app in a
checkout: they are one module, [`checks.js`](../../std/maker/checks.js), which
each runs with the kernel's own manifest reader, gate, HTML allowlist and API
reference, reading the files from the disk or from the data folder. The
maker reads the files elsewhere on the site that the app links too, so a
service a standard plugin or a registry package provides counts, and a link
to one the site hasn't got is found. They check the page's rules,
every linked file there, manifests that read, unique ids that no other
running plugin has, collections no other plugin owns, every `ctx` call
allowed by the plugin's permissions, templates that exist and use the
allowlist, and a slot for everything a plugin draws.

Then it asks for the app to be opened again (the `maker:check` hook; the
preview in Your apps reloads) and reads the trace for what failed as it ran:
a plugin that didn't start, an error it threw, a permission it was refused.
Each problem names the file to fix. If the app isn't open anywhere, `ran` is
false and only the files were checked.

## Adding it to another app

```html
<link rel="agent" href="/std/maker/app-maker.agent.md">
<link rel="plugin" href="/std/maker/your-apps.js">
<link rel="plugin" href="/std/llm/anthropic.js">
<link rel="plugin" href="/std/board.js">
…
<slot name="make"></slot>
<slot name="apps"></slot>
<slot name="board"></slot>
```
