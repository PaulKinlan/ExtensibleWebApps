# Phase 0 spike: what we learned

The spike checks that the plan's riskiest choices hold up: Cordis as the kernel, the kernel in a shared worker, and every plugin in its own worker. `npm test` builds the app and runs 21 checks in Chromium; all pass.

## Results

| Question | Answer |
| --- | --- |
| Does Cordis run in a worker? | Yes. `cordis@4.0.0-rc.11` (the version DeepSeek Harness vendors) has no Node imports. The kernel bundle, Cordis included, is 51 KB before compression. |
| Can a shared worker host the kernel? | Yes, and two tabs share one kernel and one set of notes. |
| Can a shared worker create the plugin workers? | No. `Worker` is not defined in a shared worker (Chromium 153). One tab, the spawner, creates plugin workers and hands the kernel a `MessageChannel` port to each. |
| What happens when the spawner tab closes? | The next tab becomes the spawner and the plugins start again there. Tabs are noticed leaving through a Web Lock each tab holds for its lifetime; `pagehide` alone was not reliable. |
| Do Markdown editor extensions run unchanged? | Yes. `word-count.js` and `edit-times.js` are copied byte for byte and run through a shim of about 70 lines (`editorShim` in `src/sandbox/runtime.ts`). |
| Can a plugin in a worker block an action? | Yes. `no-shouting.js` blocks a save through the `serial` hook `data:beforeWrite`. |
| Does the gate hold? | Yes. `sneaky.js` asks to intercept writes and to play audio without those capabilities; both are refused and show in the trace. |
| Hook round trip to a plugin worker | p50 0.1 ms, p95 0.2 ms, max 1.5 ms over 500 calls (target: p95 under 2 ms). In-kernel p50 is under 0.1 ms. Timers are coarsened to 0.1 ms without cross-origin isolation. |
| Hot reload leaks | 100 reloads of a plugin: listeners 20 → 20, workers 7 → 7, no failures. |
| Audio with no plugin code on the main thread | Yes. `tone.js` registers its DSP as an `AudioWorkletProcessor`; the host owns the `AudioContext` and plays it. |
| Drawing from a worker | Yes. `bars.js` animates an `OffscreenCanvas` with `requestAnimationFrame` in its worker. |
| Folder handles into workers | Yes. The tab passes a `FileSystemDirectoryHandle` (the origin private file system here) to the shared worker, which stores the notes in it. |
| Observability tap | Cordis's `internal/dispatch` event reports every dispatch; the bridge adds timings for remote listeners and the gate adds denials. |

## Findings that change the plan

1. **Tabs spawn plugin workers.** Because shared workers can't create workers, the kernel needs a spawner tab and a handover. Plugins restart on handover, so plugin state must live in the kernel's store, not in the plugin's memory.
2. **Canvases can't cross tabs.** Handing an `OffscreenCanvas` from one tab to a plugin worker that another tab created crashed the renderer. Plugins that draw need `scope: "tab"`, a worker per tab. (Done in phase 1: see [kernel.md](kernel.md).)
3. **Cordis's `apply` must return nothing.** Cordis awaits whatever `apply` returns, and a `Context` looks like a promise, so `apply: (ctx) => (x = ctx)` hangs the plugin forever.
4. **Trace ids only follow synchronous paths.** The kernel links a dispatch to the remote answer when they happen in the same turn. Work after an `await` loses the id. Phase 1 needs the id carried explicitly in every message. (Done in phase 1: the id rides as Cordis's `thisArg`.)

## Not covered yet

- ~~A content security policy on plugin workers~~ and ~~reading the manifest without running the module~~: done in phase 1.
- An approval prompt. Built-in plugins are trusted with what they ask for.
- Plugins defining their own hooks from a worker, and `waterfall` hooks across workers (the code path exists but no plugin uses it).
- Plugin storage and settings in the editor shim (they are stubs).
