// The host: the only code on the main thread. It draws the declarative views
// plugins send, turns the person's actions into events, creates plugin
// workers when it is the spawner tab, and bridges APIs that only exist in a
// page (Web Audio here). It runs no plugin code.

import type { Command, HostToKernel, KernelToHost, Slot, TraceEvent, View } from "../shared/protocol";

const tab = Math.random().toString(36).slice(2, 8);
const params = new URLSearchParams(location.search);
const useShared = typeof SharedWorker !== "undefined" && params.get("kernel") !== "dedicated";

let port: MessagePort;
if (useShared) {
  const kernel = new SharedWorker(new URL("../kernel/kernel.ts", import.meta.url), { type: "module", name: "kernel" });
  port = kernel.port;
} else {
  const kernel = new Worker(new URL("../kernel/kernel.ts", import.meta.url), { type: "module", name: "kernel" });
  const channel = new MessageChannel();
  kernel.postMessage({ t: "connect" }, [channel.port2]);
  port = channel.port1;
}

const send = (message: HostToKernel, transfer: Transferable[] = []) => port.postMessage(message, transfer);
let traceCounter = 0;
const newTrace = () => `${tab}-${++traceCounter}`;

// ---- Views ----

type Entry = { owner: string; order: number; el: HTMLElement };
const slots = new Map<Slot, Map<string, Entry>>();
const canvases = new Map<string, HTMLCanvasElement>();

function element(view: View, owner: string): HTMLElement {
  const event = (action: string, value?: unknown) => send({ t: "event", owner, action, value, trace: newTrace() });
  switch (view.type) {
    case "stack": {
      const el = document.createElement("div");
      el.className = `stack${view.direction === "row" ? " row" : ""}`;
      for (const child of view.children) el.append(element(child, owner));
      return el;
    }
    case "heading": {
      const el = document.createElement("h2");
      el.textContent = view.text;
      return el;
    }
    case "text": {
      const el = document.createElement("span");
      el.textContent = view.text;
      if (view.title) el.title = view.title;
      if (view.tone) el.className = view.tone;
      return el;
    }
    case "button": {
      const el = document.createElement("button");
      el.textContent = view.label;
      if (view.primary) el.className = "primary";
      el.onclick = () => event(view.action);
      return el;
    }
    case "list": {
      const el = document.createElement("ul");
      el.className = "list";
      for (const item of view.items) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.textContent = item.label;
        button.setAttribute("aria-current", String(Boolean(item.selected)));
        button.onclick = () => event(item.action);
        li.append(button);
        el.append(li);
      }
      return el;
    }
    case "textarea": {
      const el = document.createElement("textarea");
      el.name = view.name;
      el.value = view.value;
      if (view.placeholder) el.placeholder = view.placeholder;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Plugins see edits after a short pause, as editor extensions do.
      el.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => event(view.action, el.value), 300);
      };
      return el;
    }
    case "field": {
      const label = document.createElement("label");
      label.className = `field ${view.kind}`;
      const caption = document.createElement("span");
      caption.textContent = view.label;
      if (view.description) caption.title = view.description;
      let input: HTMLInputElement | HTMLSelectElement;
      if (view.kind === "select") {
        input = document.createElement("select");
        for (const option of view.options ?? []) input.append(new Option(option, option, false, option === view.value));
      } else {
        input = document.createElement("input");
        input.type = view.kind;
        if (view.kind === "checkbox") input.checked = Boolean(view.value);
        else input.value = String(view.value);
      }
      input.name = view.name;
      // Sent when the change is committed (blur, Enter, or a click), not on every key.
      input.onchange = () => {
        const el = input as HTMLInputElement;
        event(view.action, view.kind === "checkbox" ? el.checked : view.kind === "number" ? el.valueAsNumber : el.value);
      };
      if (view.kind === "checkbox") label.append(input, caption);
      else label.append(caption, input);
      return label;
    }
    case "canvas": {
      // A canvas can only go to a worker this tab created: handing an
      // OffscreenCanvas to another tab's worker crashed the renderer
      // (Chromium 153). Plugins that draw use `scope: "tab"`.
      if (!owner.endsWith(`@${tab}`)) {
        const note = document.createElement("span");
        note.className = "muted";
        note.textContent = "Plugins that draw need scope: \"tab\".";
        return note;
      }
      const key = `${owner}/${view.id}`;
      let el = canvases.get(key);
      if (!el) {
        el = document.createElement("canvas");
        el.width = view.width;
        el.height = view.height;
        const offscreen = el.transferControlToOffscreen();
        send({ t: "canvas", owner, id: view.id, canvas: offscreen }, [offscreen]);
        canvases.set(key, el);
      }
      return el;
    }
  }
}

function render(slot: Slot, key: string, owner: string, order: number, view: View | null) {
  const container = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (!container) return;
  const entries = slots.get(slot) ?? new Map<string, Entry>();
  slots.set(slot, entries);
  const old = entries.get(key);
  if (!view) {
    old?.el.remove();
    entries.delete(key);
    return;
  }
  const el = document.createElement("div");
  el.dataset.key = key;
  el.append(element(view, owner));
  // Keep the text field the person is typing in, and keep focus on any other
  // named control they were on, so keyboard use carries on after a redraw.
  const active = document.activeElement as (HTMLElement & { name?: string }) | null;
  const hadFocus = old && active && old.el.contains(active) && typeof active.name === "string" ? active : undefined;
  const sameName = (root: HTMLElement) =>
    hadFocus ? [...root.querySelectorAll<HTMLElement & { name: string }>(hadFocus.tagName)].find((x) => x.name === hadFocus.name) : undefined;
  if (hadFocus instanceof HTMLTextAreaElement) sameName(el)?.replaceWith(hadFocus);
  if (old) old.el.replaceWith(el);
  if (hadFocus && !(hadFocus instanceof HTMLTextAreaElement)) sameName(el)?.focus();
  entries.set(key, { owner, order, el });
  if (!old) {
    const sorted = [...entries.values()].sort((a, b) => a.order - b.order);
    container.append(...sorted.map((e) => e.el));
  }
}

// ---- Plugin workers (spawner tab only) ----

const workers = new Map<string, Worker>();

function spawn(plugin: string, source: string, network: boolean) {
  workers.get(plugin)?.terminate();
  // Two copies of the runtime, served with different content security policies.
  const worker = network
    ? new Worker(new URL("../sandbox/net-runtime.ts", import.meta.url), { type: "module", name: plugin })
    : new Worker(new URL("../sandbox/runtime.ts", import.meta.url), { type: "module", name: plugin });
  const channel = new MessageChannel();
  worker.postMessage({ t: "init", source }, [channel.port2]);
  workers.set(plugin, worker);
  send({ t: "spawned", plugin, port: channel.port1 }, [channel.port1]);
}

// ---- Bridges to page-only APIs ----

let audio: AudioContext | undefined;
const processors = new Map<string, { source: string; added?: Promise<void> }>();
const audioStats = { played: 0, state: "none" as string };

async function bridge(service: string, method: string, args: unknown[]): Promise<unknown> {
  if (service === "host" && method === "workerCount") return workers.size;
  if (service === "audio" && method === "registerProcessor") {
    const [name, source] = args as [string, string];
    processors.set(name, { source });
    return true;
  }
  if (service === "audio" && method === "play") {
    const [{ processor, ms = 300, options = {} }] = args as [{ processor: string; ms?: number; options?: Record<string, unknown> }];
    const entry = processors.get(processor);
    if (!entry) throw new Error(`No audio processor named ${processor}`);
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    entry.added ??= audio.audioWorklet.addModule(URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" })));
    await entry.added;
    const node = new AudioWorkletNode(audio, processor, { processorOptions: options });
    node.connect(audio.destination);
    setTimeout(() => node.disconnect(), ms);
    audioStats.played++;
    audioStats.state = audio.state;
    return { ...audioStats };
  }
  throw new Error(`The host has no ${service}.${method}`);
}

// ---- Trace view ----

const traceList = document.getElementById("trace")!;
const traces: TraceEvent[] = [];
function showTrace(events: TraceEvent[]) {
  traces.push(...events);
  if (traces.length > 1000) traces.splice(0, traces.length - 1000);
  for (const e of events) {
    const li = document.createElement("li");
    li.className = e.kind;
    li.textContent = `${e.at.toFixed(1).padStart(8)}  ${e.kind.padEnd(9)} ${e.name}${e.plugin ? ` [${e.plugin}]` : ""}${e.ms !== undefined ? ` ${e.ms} ms` : ""}${e.detail ? `  ${e.detail}` : ""}${e.trace ? `  #${e.trace}` : ""}`;
    traceList.prepend(li);
  }
  while (traceList.children.length > 200) traceList.lastChild?.remove();
}

function notice(text: string) {
  const p = document.createElement("p");
  p.textContent = text;
  document.getElementById("notice")!.append(p);
  setTimeout(() => p.remove(), 4000);
}

// ---- Commands (devtools and tests) ----

let commandId = 0;
const waiting = new Map<number, (value: unknown) => void>();
function command(name: Command, arg?: unknown): Promise<unknown> {
  const id = ++commandId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ t: "command", name, arg, id });
  });
}

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

// ---- Kernel messages ----

let spawner = false;
port.onmessage = async (e: MessageEvent<KernelToHost>) => {
  const message = e.data;
  switch (message.t) {
    case "welcome":
      spawner = message.spawner;
      document.getElementById("mode")!.textContent = `Kernel in a ${message.mode} worker · tab ${tab}${spawner ? " · runs the plugin workers" : ""}`;
      return;
    case "render":
      return render(message.slot, message.key, message.owner, message.order, message.view);
    case "spawn":
      // The kernel decides which tab runs which plugin instance.
      spawn(message.plugin, message.source, message.network);
      return;
    case "terminate":
      workers.get(message.plugin)?.terminate();
      workers.delete(message.plugin);
      return;
    case "bridge":
      try {
        send({ t: "bridge:result", id: message.id, ok: true, value: await bridge(message.service, message.method, message.args) });
      } catch (error) {
        send({ t: "bridge:result", id: message.id, ok: false, error: String(error instanceof Error ? error.message : error) });
      }
      return;
    case "trace":
      return showTrace(message.events);
    case "notice":
      return notice(message.text);
    case "command:result":
      waiting.get(message.id)?.(message.value);
      waiting.delete(message.id);
      return;
  }
};
port.start();

addEventListener("pagehide", () => send({ t: "bye", tab }));

// Hold a lock for this tab's lifetime, so the kernel notices when it closes.
await new Promise<void>((held) => {
  void navigator.locks.request(`ewa-tab-${tab}`, () => {
    held();
    return new Promise(() => {});
  });
});
const folder = await navigator.storage.getDirectory().catch(() => undefined);
send({ t: "hello", tab, folder });

// For tests and poking around in the console.
Object.assign(window, { __host: { tab, command, traces, audioStats, workers, get spawner() { return spawner; } } });
