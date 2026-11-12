# Spaces, and plugins on a server

Everything so far runs in one browser: the kernel keeps the data on the device, and an app needs no server at all. A **space** is how several people share an app's data, and how a plugin keeps working when nobody has the app open. This page shows how to use one as an app author. [Servers and spaces](../server.md) describes how it is built.

## Spaces and accounts

Every app works on your device straight away: no sign-in, no space. Its data stays on that device. The two words below only come in when you want more than that, and they mean different things:

- **Your account** is *who you are* on the site. You make one at [`/account/`](/account/) with a passkey (or GitHub or Bluesky, where the site turns them on).
- **A space** is *what you share*: a copy of an app's data for the people you invite, or just you on your phone and laptop. You need an account to make or join one.

So an app says it in one line, as an offer and never as a wall: *"To share this, or use it on another device, open it in a space."* The link goes to `/account/?app=<the app>`. The Feeds, Surveys and Household demos say it that way, and each works without a space first: Feeds reads feeds through the site's [feed reader](../server.md#the-feed-reader) until it is in a space. Glowfall together is the one that can't (it is the game for several people on one server), so it offers Glowfall on your own first.

## What a space is

A space is a named group of people and their data: collections and plugins. Any app can open in one. The same reading list is your own at `/demos/reading-list/`, and the family's at `/s/family/demos/reading-list/`.

```mermaid
flowchart LR
    subgraph Phone["Sam's phone"]
        K1["The family kernel<br/>(kernel:family)<br/>a copy of the data"]
    end
    subgraph Laptop["Alex's laptop"]
        K2["The family kernel<br/>a copy of the data"]
    end
    subgraph Server["The site's server"]
        S["The space's kernel<br/>orders every change,<br/>runs server plugins"]
        SP["collect.js<br/>runs: server"]
    end
    K1 <-->|sync, as Sam| S
    K2 <-->|sync, as Alex| S
    S <--> SP
    Web["Anyone, on the web"] -->|"/s/family/…/answer"| S
```

- **The same kernel, on each device and the server.** In a tab, a space gets a kernel of its own, a shared worker named after it (`kernel:family`), with its own folder on the device (`spaces/family/`). The space's server runs the same kernel code again ([`src/kernel/env.ts`](../../src/kernel/env.ts) says what differs). Your own kernel, outside any space, is untouched.
- **Each device keeps a copy** and works on it offline. The server orders every change, so all the copies agree, and a change based on an older version is kept as a draft rather than lost.
- **Only members join.** People sign in with a passkey (or a provider such as GitHub or Bluesky, where the site turns one on) at [`/account/`](/account/), make a space, and invite others with a link.

## Opening an app in a space

Nothing in the app changes. A plugin reads and writes its collections as before, and `data:changed:<collection>` fires for changes from other people's devices too, with `by`: the member's id, or `plugin:<id>` for a server plugin. A live view follows them like any write.

To show who that was, ask for the names: `await ctx.call("sync", "members")` gives `{ space, you, members: [{ id, name }] }`, each member with the name on their account and `you` the member this page is signed in as (it needs the `members` permission). The space sends the names when a page connects, and the page keeps them for when it's offline; `members:changed` says when they arrive or change. A plugin that stamps a record with who did something should use `you` rather than a name the person types: the space vouches for it. [`demos/household`](../../demos/household/) works this way.

### Who may change what

Each member of a space has a role, which its owner gives on [`/account/`](/account/): the **owner** and **editors** change what the space keeps, and a **reader** only sees it. An invite is for an editor or a reader, and the owner can change someone's role later. The space's server decides, so a reader's change is refused whatever their browser sends, and they are told who can make them an editor.

A plugin can say more about a collection it keeps, with `rules` beside the schema:

```js
collections: {
  chores: { title: "Chores", schema: { /* … */ }, rules: { remove: "author" } },
}
```

| Rule | Who it lets | Values |
| --- | --- | --- |
| `add` | add a record | `"editors"` (the default: anyone but a reader) or `"owner"` |
| `change` | change one | `"editors"`, `"author"` (whoever added it) or `"owner"` |
| `remove` | remove one | `"editors"`, `"author"` or `"owner"` |

The owner can always do all three, and so can the app's own server plugins. The space keeps who added each record itself, so a device can't claim to be the author. Rules that aren't written this way fail `npm run check`, and in a space they lock the collection to its owner until they are fixed, rather than letting everyone in. Only the rules in the app's own files count: nothing a member's device sends can set one.

Outside a space there is one person and no rules. So a view asks before it draws a button, and the answer is yes to everything there:

```js
const can = await ctx.call("sync", "may", "chores");        // { add, change, remove, why? }
const mine = await ctx.call("sync", "may", "chores", id);   // for one record, when a rule says "author"
```

`why` is a sentence for the person when something is refused ("Ask the space's owner, Ann, to make you an editor."). `sync.role()` gives the role alone. A write that isn't allowed is stopped on the device and the person is told why; nothing is kept as a draft. [`demos/household`](../../demos/household/) uses all of this: only whoever added a chore removes it, and a reader sees the lists without their buttons.

To show people whether their copy is in step, link the standard sync plugin and give it a slot:

```html
<link rel="plugin" href="/std/sync.js">
…
<slot name="sync"></slot>
```

It says when the page is offline or behind, and lists the drafts kept when two people changed the same record while apart, with **Use mine** and **Keep theirs**. A plugin can ask the same things itself with the `sync` permission (`sync.state`, `sync.keep`, `sync.dismiss`, and the `sync:changed` event). The [household demo](../../demos/household/app.html) is made to be opened in a space.

## A plugin that runs on the server

A plugin says where it runs with `runs` in its manifest: `"browser"` (the default), `"server"`, or `"both"`. A server plugin is the same kind of file, read by the same manifest parser and checked by the same gate. It has no page to draw on, so it doesn't ask for `ui`.

The survey demo's [`collect.js`](../../demos/survey/collect.js) runs only on the server:

```js
export const manifest = {
  id: "collect",
  name: "Survey answers",
  runs: "server",
  permissions: ["routes", "schedule", "email", "data:read:surveys"],
  collections: { answers: { schema: { type: "object", required: ["survey", "values"], properties: { /* … */ } } } },
};

export default async function (ctx) {
  // Public: /s/<space>/demos/survey/answer?survey=<id>, for anyone, signed in or not.
  ctx.routes.add("GET", "answer", async ({ query }) => ({ html: formFor(await ctx.call("data", "get", "surveys", query?.survey)) }));
  ctx.routes.add("POST", "answer", async ({ query, form }) => {
    await ctx.call("data", "put", "answers", { survey: query.survey, values: form });
    return { html: "<p>Thank you.</p>" };
  });

  // Once a day, even with no app open anywhere.
  ctx.schedule.every("digest", 24 * 60 * 60 * 1000, async () => {
    await ctx.call("email", "send", { to: ["owner@example.com"], subject: "New answers", text: "…" });
  });
}
```

The app links it like any other plugin, beside the browser one: `<link rel="plugin" href="collect.js">`. The browser leaves out a plugin that runs only on the server.

What a server plugin can do that a browser plugin can't:

| With | It can | Notes |
| --- | --- | --- |
| `routes` | Answer public requests at `/s/<space>/<its folder>/<path>` | Anyone may call one, from any site, and the plugin isn't told who. A request wakes the space if it was asleep. The answers are the same as in a browser ([Routes](routes.md)). |
| `schedule` | Run a job every so often (repeating at most once a second), or once at a given time | Jobs outlive a restart, and one that came due while the space was stopped runs once when it starts. In a browser a job runs only while the kernel does. |
| `notify` | Show a notification on members' devices, with the app closed on all of them | Sent with Web Push to each device a member turned notifications on for, on their account page. To every member, or `to: [ids]`. A click opens the plugin's app in the space. At most 6 a minute per plugin and 200 a day per person. |
| `email` | Send a message to up to 10 addresses | Only to the space's members, at an address they confirmed from a link mailed to it. At most 50 a day per plugin. Delivered by Cloudflare Email Service or SMTP, which the site sets up ([Sending email](../server.md#sending-email)). |
| `hook:intercept:data:beforeWrite:<collection>` | Check every change any member's device sends, and stop it | It hears which member sent it. For a collection it doesn't own, it also needs `data:read:<collection>`. |
| `network` | Fetch from the internet | Never the server's own network: loopback, private and metadata addresses are refused where the connection is made. |

What it writes reaches every member's device as a change by `plugin:<id>`.

**A reminder with every tab closed** is a job and a notification together:

```js
// permissions: ["schedule", "notify"]
ctx.schedule.at("bins", when, () => ctx.call("notify", "show", { title: "The bins go out tonight", tag: "bins" }));
```

`show` answers `true` if it reached at least one device, and the space's trace says how many members it reached and why not the rest. Each person turns notifications on once for each device, under **Notifications on this device** on `/account/`, and can send themselves a test there. [`demos/household/reminders.js`](../../demos/household/reminders.js) tells everyone when a chore comes due this way, and sets one job for the next due time instead of polling.

**Live messages** are for what shouldn't be kept: a game's moves and
frames, a cursor, who is here. A page calls `ctx.call("sync", "live",
topic, value)` (with the `live` permission) and the space's server plugins
hear it as `sync:live`, with the member and device it came from; a server
plugin calls the same and every device that has spoken on that topic hears
it, or only the one it names. Nothing is stored or traced, and a device may
send 60 a second. [Glowfall together](../../demos/glowfall-together/) plays
one game for everyone this way ([games and sound](games-and-audio.md#playing-together-on-a-spaces-server)).

## The rules a server plugin runs under

- **Only the app's own files run there.** When a device opens an app in a space, the space reads that app's `app.html` from the site and starts the plugins it links that run on the server. It never runs code a member's browser sent: a plugin a member adds in the space is their own, and one they share with the space goes to the other members' browsers, turned off until each of them turns it on, never to the server. So a server plugin is always the author's, as the site serves it.
- **Each runs in an isolate of its own.** On Node, a process under Node's permission model, with no file system, no child processes and none of the server's environment. On Cloudflare, a Dynamic Worker with no bindings and no network unless it asks for `network`.
- **They start again by themselves.** The space remembers the apps opened in it and starts their server plugins whenever its kernel starts.

## Trying it on your machine

```sh
npm run serve      # builds, then serves the site and its spaces at http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787/account/`, make an account with a passkey (the browser's own, or a phone), make a space, and open any app inside it: `/s/<space>/demos/reading-list/`, say. `/s/<space>/demos/survey/` is the survey builder; make a survey, and its **Share link** opens the public form, which works in another browser, signed out.

To check a server plugin without a browser, copy [`tests/fixtures/server-app/`](../../tests/fixtures/server-app/) and the checks for it in [`tests/server/run.mjs`](../../tests/server/run.mjs), which run against Node and against `wrangler dev` (`npm run test:server`).

## A model for everyone in a space

The people in a space don't each need an API key. On `/account/`, under **A model for a space**, the space's owner can give it one key for Claude, Gemini or OpenAI. The space's server keeps the key encrypted and never sends it to a browser. A member then opens any app in the space, adds **The space's model** where the app asks for a language model (or from Customize), and asks: they are shown whose key pays before their first question, and each member has 200 questions a day. See [A model key a space holds for its members](../server.md#a-model-key-a-space-holds-for-its-members) for where the key is kept.

## Moving a space to another server

On `/account/`, the owner of a space can **Download a copy** of it and **Load a copy** into an empty space on another server: from the hosted site to `npm run serve` on your own machine, say. Everything in the space goes, and its server plugins start again there by themselves. The people don't: they have accounts on the old server, so invite them again. See [Moving a space between hosts](../server.md#moving-a-space-between-hosts).

## What isn't there yet

- **Only collections sync.** A person's own plugins for an app, and an app's other files, stay on each device.
- **Keys the site provides**, so a person needn't bring their own API key, aren't there yet. A server plugin with `secret:<name>` has no one to ask for a key.

Back to the [guide's contents](README.md).
