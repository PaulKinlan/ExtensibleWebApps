// The workbench page (site/workbench/index.html): every plugin's views,
// the plugins panel, and a trace of everything the kernel does, with buttons
// to measure it. App pages (app.html) leave all of this out.

import type { Command, TraceEvent } from "../shared/protocol";

export function workbench(command: (name: Command, arg?: unknown) => Promise<unknown>) {
  // The plugins panel is this page's alone: the kernel draws it once asked (src/kernel/catalog.ts).
  void command("plugins-panel");
  const traceList = document.getElementById("trace")!;
  const result = document.getElementById("result")!;

  document.getElementById("bench")!.onclick = async () => {
    result.textContent = "Measuring…";
    const r = (await command("bench", 300)) as any;
    result.textContent = `Hook round trip to a plugin worker: p50 ${r.remote.p50} ms, p95 ${r.remote.p95} ms (in-kernel p50 ${r.local.p50} ms)`;
  };
  document.getElementById("reload-test")!.onclick = async () => {
    result.textContent = "Reloading…";
    const r = (await command("reload-test", 50)) as any;
    result.textContent = `50 reloads: listeners ${r.before.hooks} → ${r.after.hooks}, workers ${r.before.workers} → ${r.after.workers}, ${r.failures} failed`;
  };
  document.getElementById("reference")!.onclick = async () => {
    const pre = document.getElementById("reference-text")!;
    if (!pre.hidden) return void (pre.hidden = true);
    const r = (await command("reference")) as { live: string };
    pre.textContent = r.live;
    pre.hidden = false;
  };

  return {
    /** Shows which kind of worker the kernel runs in. */
    mode(text: string) {
      document.getElementById("mode")!.textContent = text;
    },
    /** Adds events to the trace panel, newest first. */
    trace(events: TraceEvent[]) {
      for (const e of events) {
        const li = document.createElement("li");
        li.className = e.kind;
        li.textContent = `${e.at.toFixed(1).padStart(8)}  ${e.kind.padEnd(9)} ${e.name}${e.plugin ? ` [${e.plugin}]` : ""}${e.ms !== undefined ? ` ${e.ms} ms` : ""}${e.detail ? `  ${e.detail}` : ""}${e.trace ? `  #${e.trace}` : ""}`;
        traceList.prepend(li);
      }
      while (traceList.children.length > 200) traceList.lastChild?.remove();
    },
  };
}
