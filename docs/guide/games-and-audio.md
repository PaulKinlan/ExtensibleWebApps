# Games and sound

Two kinds of app push a platform hard: a game, which has to do something
many times a second, and a sound editor, which moves a lot of numbers and
has to sound right. Both are built here the same way as a reading list: a
small engine, and everything else in plugins, so a new rule or a new effect
is one more plugin and the engine never changes.

| | Engine | What a plugin adds | Demo |
| --- | --- | --- | --- |
| A game | the `game` service: a loop in the kernel ([`std/game/module.ts`](../../std/game/module.ts)) | a *system*: a rule that runs every tick | [Glowfall](../../demos/glowfall/) |
| Sound | the `audio` service: clips rendered through AudioWorklet processors ([`std/audio/module.ts`](../../std/audio/module.ts)) | an *effect*: a processor | [Sound editor](../../demos/audio-editor/) |

## A game loop whose rules are plugins

A game is a state, a plain object its plugins agree on, and a clock. The
`game` service keeps both. A plugin starts a game with its first state, and
the service ticks it, 20 times a second unless asked for another rate:

```js
await ctx.call("game", "start", { game: "glowfall", hz: 20, state: { lanes: 5, jar: 2, things: [], score: 0, lives: 3 } });
```

Each tick runs three hooks, one after the other:

```mermaid
sequenceDiagram
    participant L as game service (kernel)
    participant U as systems on game:update
    participant R as systems on game:rules
    participant D as what draws (scope "tab")

    loop every tick (1/hz s)
        L->>U: { game, tick, dt, time, input, state }
        U-->>L: { state } (each in turn sees the last one's)
        L->>R: { …, state }
        R-->>L: { state }, and { over } to end it
        L-)D: game:frame { tick, at, hz, state }
    end
```

- **`game:update`** is a waterfall: each system gets the state, and answers
  `{ state }` with its changes. The next system sees them. This is where
  things move: Glowfall's [`sky.js`](../../demos/glowfall/sky.js) drops and
  moves what falls, and [`jar.js`](../../demos/glowfall/jar.js) moves the
  jar for each key press.
- **`game:rules`** runs once everything has moved, for systems that judge:
  [`catch.js`](../../demos/glowfall/catch.js) scores what lands in the jar
  and counts the rain that does. Answering `{ over: "why" }` ends the game.
- **`game:frame`** tells whatever draws the game what the state is now.

A system is an ordinary plugin with `hook:intercept:game:update` (or
`:rules`):

```js
export const manifest = {
  id: "glowfall-wind",
  name: "Wind",
  permissions: ["hook:intercept:game:update"],
  services: ["game"],
};

export default function (ctx) {
  ctx.on("game:update", ({ game, dt, time, state }) => {
    if (game !== "glowfall" || state.done) return;
    const gust = time % 6 < 2 ? 1 : 0;
    return { state: { ...state, things: state.things.map((t) => ({ ...t, x: Math.min(state.lanes - 1, t.x + gust * dt)) })) } };
  });
}
```

That is [`samples/wind.js`](../../demos/glowfall/samples/wind.js), more or
less; Customize offers it on Glowfall. Turn it on and the wind blows; turn it
off and it stops. Nothing else changed.

**What the person presses** goes to the loop with
`ctx.call("game", "input", { game, type: "left" })`, and arrives on the next
tick as `input`, in order, each with `from`, the plugin that sent it.
Glowfall's [`controls.js`](../../demos/glowfall/controls.js) sends a press
for each button and each key (as commands, so the palette lists them).

**Tapping and dragging.** A canvas view rendered with `pointer: true`
sends each tap and drag on it to its plugin as the event `canvas:pointer`
(`ctx.ui.onEvent`): `{ canvas, type, x, y, id, kind }`, where type is
`down`, `move`, `up` or `cancel`, and x and y are in the canvas's own pixels,
whatever size the page shows it at. Moves come only while a finger or
button is down, at most once a frame, and the page doesn't scroll under a
finger on it. Glowfall's meadow sends the lane under the finger as input,
`{ type: "lane", lane }`, which `jar.js` already understood.

**Drawing.** A canvas goes to the worker that draws on it, so the plugin
that draws is `scope: "tab"`, and each tab draws its own. It listens to
`game:frame` (with `hook:listen:game:frame`), keeps the last two frames, and
draws at the screen's rate between them: Glowfall ticks 20 times a second
and still moves smoothly. [`meadow.js`](../../demos/glowfall/meadow.js) does
this, with the page's colours from `ctx.ui.onCanvas` and `ctx.ui.onTheme`
([views](views-and-templates.md)).

**Sound.** A system can do more than change the state. Glowfall's
[`samples/chime.js`](../../demos/glowfall/samples/chime.js) listens to
`game:frame` and plays a note through the `audio` service whenever the
frame's state says something was caught on that tick.

### What the loop promises

- **Ticks are quiet.** `game:update`, `game:rules` and `game:frame` are
  *quiet* hooks: they run many times a second, so they aren't traced, or a
  running game would push everything else out of the trace. A listener that
  fails or times out is still traced. `game:started` and `game:ended` are
  traced as usual. (A kernel module marks a hook quiet with `quiet: true` in
  its spec.)
- **A slow system slows the game down; it doesn't pile up.** Each system has
  250 ms to answer a tick, or that tick goes on without it. A tick that
  isn't finished when the next is due makes the next one wait its turn, and
  the game's `late` count goes up.
- **A game ends when its plugin does.** The plugin that started a game owns
  it; if it stops (its tab closes, someone turns it off), so does the game.
- **The state stays small.** It goes to every system every tick, so it is
  held to 200,000 characters of JSON.
- **Several games, by name.** A game is `"main"` unless named, and up to four
  run at once. Systems are told the game's name, and leave alone the games
  they don't know.

`ctx.call("game", "state", { game })` reads a game as it is now, and the
page command `game-state` lists every game, for tests and developer tools.

### Playing together, on a space's server

The loop is a kernel module, so a space's server has it too, and a game
that runs there is one game for every member. [Glowfall
together](../../demos/glowfall-together/) is the example: open it at
`/s/<space>/demos/glowfall-together/` and each member gets a jar of their
own under one sky.

- Its host, [`together.js`](../../demos/glowfall-together/together.js), is a
  server plugin (`runs: "server"`) that starts the game in the space's
  kernel. Its systems, `jars.js` and `catches.js`, run there too, and so
  does Glowfall's own `sky.js`, which says `runs: "both"`: the same plugin
  is the sky alone in a browser and together on the server.
- Moves and frames are **live messages**: `ctx.call("sync", "live", topic,
  value)`, heard as the `sync:live` hook, with the `live` permission. A
  page's message reaches the space's server plugins with the member and
  device it came from, so no one moves another's jar; a server plugin's
  reaches every device that has spoken on that topic. They aren't kept or
  traced, so twenty frames a second cost nothing but the bytes
  ([`std/spaces/live.ts`](../../std/spaces/live.ts)).
- Each device draws the frames as Glowfall's meadow does, between the last
  two, and sends taps, drags and keys back as moves.
- A **referee**, [`referee.js`](../../demos/glowfall-together/referee.js),
  keeps it fair, and is a plugin like the rest: turn it off and the game
  plays on unrefereed. The host asks its own hooks before it seats a device
  (`glowfall-together:join`) and before each move goes to the loop
  (`glowfall-together:move`, a `quiet` hook, so moves aren't traced); the
  referee answers `{ block }` to a member's second device (one jar each),
  to a lane that isn't one, and past 12 moves a second. Then, on every
  tick, it compares the state with the one it saw a tick before: a score
  may go up only by fireflies that were near that jar and are gone, the
  team's only by fireflies gone, no score goes down and no light comes
  back on. That difference holds whatever every other system did, in
  whatever order they ran, so a rule someone adds to the space that hands
  out points is caught as surely as a player who sends too much. What it
  puts right goes in the state as `referee`, and every lobby shows it.

## Clips, and effects that are plugins

The `audio` service has played sound since the
[Beat pad](../../demos/beats/): a plugin registers an AudioWorklet
processor and plays it. For sound that is edited rather than played, it also
has **clips**: a recording as `{ rate, pcm, channels? }`, where `pcm` is
base64 of 16-bit samples, one channel, or two (`channels: 2`, stereo)
interleaved. A clip holds up to about four and a half minutes of one
channel at 22,050 samples a second. It is plain JSON, so a plugin can keep
one in a collection, send it in a hook, or hand it to the service:

| Method | Does |
| --- | --- |
| `audio.render({ clip, chain, tail? })` | Runs a clip through a chain of processors in an `OfflineAudioContext`, faster than real time, and gives back the new clip. `tail` adds silence for an echo to ring into. With `source` instead of `clip`, a processor makes the clip. |
| `audio.playClip({ clip, from?, to?, chain?, group? })` | Plays a clip, or a part of it, through a chain if given. Answers `{ at, ms }`, when it starts and how long it lasts, for a playhead. |
| `audio.stop({ group })` | Stops a group's sounds, even those already sounding. |
| `audio.mix({ tracks: [{ clip, at?, gain?, pan?, chain? }] })` | Lays clips over each other into one, offline: each track starts `at` seconds in, at its gain, panned from -1 (left) to 1 (right), through its own chain. Stereo unless `channels: 1`. |
| `audio.open({ channels? })` | Opens the file chooser for a sound file and decodes it into a clip, in stereo with `channels: 2` (only right after a click). |
| `audio.save({ clip, name })` | Downloads a clip as a WAV file. |
| `audio.keep({ name, clip })`, `load({ name, of? })`, `forget`, `kept()` | Keeps a clip in the person's data folder, for one too long for a collection (a collection holds 5 MB in all). Each plugin's are its own; another reads them with `of` and `audio:kept:<plugin>`. |

Effects are processors that take one channel: on a stereo clip, each
channel goes through a copy of the chain of its own, so every effect works
on both.

An **effect** is a processor some plugin registered. The service sends each
processor's source with the sound that uses it, so a processor registered by
one plugin works in any tab another plugin plays in. A processor's name is
the first plugin's to register it.

The [sound editor](../../demos/audio-editor/) knows no effects. It defines a
hook of its own, `sound-editor:effects` (a waterfall,
[hooks of your own](plugin-hooks.md)), and offers whatever answers it.
An effect plugin registers its processor and adds itself:

```js
export const manifest = {
  id: "effect-echo",
  name: "Echo",
  permissions: ["audio", "hook:intercept:sound-editor:effects"],
  services: ["audio"],
};

const PROCESSOR = `registerProcessor("effect-echo", class extends AudioWorkletProcessor {
  constructor(options) { super(); this.line = new Float32Array(Math.round(0.25 * sampleRate)); this.i = 0; }
  process(inputs, outputs) {
    const input = inputs[0][0], out = outputs[0][0];   // input is missing once the sound has ended
    for (let n = 0; n < out.length; n++) {
      const dry = input ? input[n] : 0, wet = this.line[this.i];
      this.line[this.i] = dry + wet * 0.45;
      this.i = (this.i + 1) % this.line.length;
      out[n] = dry + wet * 0.5;
    }
    return true;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "effect-echo", PROCESSOR);
  ctx.on("sound-editor:effects", ({ effects }) => ({
    effects: [...effects, { id: "echo", name: "Echo", processor: "effect-echo", tail: 1500 }],
  }));
}
```

To apply one, the editor renders the part the person picked through it:

```mermaid
sequenceDiagram
    participant E as editor.js (its worker)
    participant K as audio service (kernel)
    participant P as the tab (OfflineAudioContext)

    E->>E: hooks.call("effects") → [echo, lo-fi, tremolo, …]
    Note over E: the person picks 1.0–2.0 s and clicks Echo
    E->>K: audio.render({ clip: that part, chain: [effect-echo] })
    K->>P: the clip, and effect-echo's source
    P->>P: AudioBufferSource → AudioWorkletNode → render
    P-->>E: the new clip
    E->>E: splice it back, keep a step to undo, draw the waveform
```

The editor's own edits (cut, trim, fade, reverse, normalise) are done on the
samples in its worker; they need no effect.

### Knobs

An effect can say which of its options the person may tune: beside
`options`, its answer to `sound-editor:effects` gives `knobs`, `{ delay: {
label, min, max, step?, unit? } }`. The editor draws a slider for each, and
renders with the values set. [`echo.js`](../../demos/audio-editor/echo.js)
offers delay, repeats and mix; an effect with no knobs, like the Telephone
sample, still works as it did. The command `tune-effect` sets one by name,
for an agent.

The editor also lays another clip over the one open (**Layer another
clip**, through `audio.mix`), opens sound files in stereo, and keeps a clip
too long for the collection with `audio.keep`, its record holding the name
it was kept under.

### A timeline of tracks

Layering mixes a clip in for good. The
[timeline](../../demos/audio-editor/timeline.js), a plugin beside the
editor, keeps clips apart as tracks of a mix, so a track that came in late
or too loud is put right afterwards: drag it along its lane on the canvas,
or set its start, level, pan and mute. Nothing is mixed until it plays or
is kept: then `audio.mix` renders the tracks as they are now. A mix is a
record in the timeline's own collection, `sound-mixes`, holding each
track's clip (a record in the editor's `sound-clips`, read with
`data:read:sound-clips`) and how it sits. **Make it a clip** puts the mix
in `sound-clips` for the editor, a write the person allows on a card. A
long clip's sound is where the editor kept it: the timeline reads it with
`audio.load({ name, of: "sound-editor" })` and the permission
`audio:kept:sound-editor`, which lets it read those clips and not change
them.

### Clips in a folder

**Save to the folder** writes the clip to the app's folder (the `folder`
service) as `sounds/<name>.wav`, a WAV file any program opens. The folder
is one the person picks on their disk (**Pick a folder…**), or until they
do, a private one in the browser. Whatever is in `sounds/` is listed and
opens again (`folder.readData`, which gives a file that isn't text as a
data: URL), so a long clip has a home that isn't one browser's data. The
folder takes files up to 32 MB that aren't text: five minutes of stereo.

### The waveform

[`<ui-waveform>`](../../elements/ui-waveform.html) draws a sound's shape
from `peaks` (a low and a high, from -100 to 100, for each column; a few
hundred pairs) and its `duration`. The person drags across it to pick a
part, or uses Shift and the arrow keys; it sends `action` with
`{ from, to }` in seconds, and the plugin sets `select` to show it. While
something plays, `playing="at,from,to"` runs a playhead from the time
`audio.playClip` answered, so the plugin doesn't redraw for each frame. The
element never gets the sound itself.

## Building on them with the app maker

Because the engines don't change for a new rule or a new effect, the
[app maker](making-apps.md) can build on them: asked for "Glowfall with a
magnet that pulls the fireflies to the jar", it makes an app whose page links
Glowfall's plugins from `/demos/glowfall/` as they are, and writes one plugin,
the magnet, a system on `game:update`. Asked for "the sound editor with a
robot voice", it links the editor and writes a robot-voice effect. The
check [`tests/checks/game-audio-maker.mjs`](../../tests/checks/game-audio-maker.mjs)
does both, with a scripted model, and plays each.

## What isn't there yet

- **The referee knows Glowfall.** It judges catches from what the state
  shows (fireflies near a jar, gone a tick later), so a new rule that scores
  some other way needs the referee taught too. It can't tell a fast hand
  from a script that keeps under 12 moves a second.
- **The timeline doesn't edit inside a track.** Cutting, fading and effects
  are the editor's, on a whole clip; a track is moved, levelled, panned or
  muted, and its clip edited in the editor.
- **Kept clips don't reach a space.** A long clip kept with `audio.keep` is in
  that browser's data folder, and a space's server has no folder: other
  members see its record, not its sound, unless it goes through a folder
  they share.
