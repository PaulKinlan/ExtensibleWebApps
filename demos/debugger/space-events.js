// Space server events: the trace of the kernel on a space's server, as it
// happens, for a debugger opened in that space (/s/<space>/demos/debugger/).
// The events panel (events.js) shows this device's kernel; this one shows
// the server's: each hook its server plugins hear, each answer and call,
// each refusal and error, each worker started or stopped, and members'
// devices coming and going.
//
// It asks with sync.trace(true), which sends the request over the page's
// own socket to the space (only members can open it) and needs
// reflect:read here, as reading the server's plugins does (space.js). The
// space answers with the events from just before, then each new batch as
// the sync:trace hook (std/spaces/trace.ts). Outside a space it says how to
// get there.

export const manifest = {
  id: "debugger-space-events",
  name: "Debugger: space server events",
  description: "In a space, the trace of the kernel on the space's server as it happens: hooks, calls, refusals and errors.",
  version: "1.0.0",
  permissions: ["ui", "reflect:read", "members", "hook:listen:sync:trace"],
  scope: "tab",
};

const KEEP = 1000;
const DRAWN = 120;

export default async function (ctx) {
  const views = ctx.ui.views("space-events.html");
  let events = [];
  let lastSeq = 0;
  let paused = false;
  let search = "";
  let problems = false;
  let listening = false;
  let problem = "";
  let inSpace = false;

  const draw = () => {
    const shown = events.filter((e) => (!problems || e.kind === "error" || e.kind === "denied") && (!search || `${e.name} ${e.plugin ?? ""} ${e.detail ?? ""}`.includes(search)));
    views.render("space-events", "space-events", {
      away: !inSpace,
      inSpace,
      problem,
      listening,
      paused,
      pressed: String(paused),
      onlyProblems: problems,
      search,
      count: events.length,
      none: inSpace && !problem && !shown.length,
      left: Math.max(0, shown.length - DRAWN),
      rows: shown
        .slice(-DRAWN)
        .reverse()
        .map((e) => ({
          seq: e.seq,
          time: `${(e.at / 1000).toFixed(1)} s`,
          kind: e.kind,
          problem: e.kind === "error" || e.kind === "denied" || /^failed/.test(e.detail ?? ""),
          name: e.name,
          plugin: e.plugin ?? "",
          ms: e.ms !== undefined ? `${e.ms} ms` : "",
          detail: (e.detail ?? "").slice(0, 400),
        })),
    });
  };

  let timer;
  const soon = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      draw();
    }, 150);
  };

  ctx.on("sync:trace", ({ events: batch, first, error }) => {
    if (error) {
      listening = false;
      problem = error;
      return draw();
    }
    if (paused && !first) return;
    // The first batch is the space's latest events, from before: it starts the list again (after a reconnection
    // too, when the space's kernel may have started again and counts from 1). A later batch can repeat a few of
    // the first's, still waiting to be sent when it was made: only the ones after the last seen are new.
    if (first) {
      events = [];
      lastSeq = 0;
    }
    const fresh = batch.filter((e) => e.seq > lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh[fresh.length - 1].seq;
    events = events.concat(fresh).slice(-KEEP);
    soon();
  });

  const listen = async (on) => {
    try {
      await ctx.call("sync", "trace", on);
      listening = on;
      problem = "";
    } catch (error) {
      listening = false;
      problem = error instanceof Error ? error.message : String(error);
    }
    draw();
  };

  ctx.ui.onEvent((action, value) => {
    if (action === "pause") paused = !paused;
    else if (action === "clear") events = [];
    else if (action === "search") search = String(value ?? "").trim();
    else if (action === "problems") problems = value === true;
    else if (action === "listen") return listen(!listening);
    else return;
    draw();
  });

  const members = await ctx.call("sync", "members").catch(() => ({ space: null }));
  inSpace = !!members.space;
  draw();
  if (!inSpace) return;
  // The page may still be connecting to its space: try again for a while.
  for (let tries = 0; tries < 20 && !listening; tries++) {
    await listen(true);
    if (!listening) await new Promise((r) => setTimeout(r, 1000));
  }
}
