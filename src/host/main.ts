// The host: the only code on the main thread. It draws the declarative views
// plugins send, turns the person's actions into events, creates plugin
// workers when it is the spawner tab, and bridges APIs that only exist in a
// page (Web Audio here). It runs no plugin code.

import type { Command, HostToKernel, KernelToHost, Slot, TraceEvent, View } from "../shared/protocol";
import { connectBindings, receive, setOwner } from "./bindings";
import { defineBoundComponents } from "./bound";
import { defineComponents } from "./components";
import { morphChildren } from "./morph";
import { sanitize } from "./sanitize";

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
//
// Every view, JSON or HTML, becomes DOM whose controls carry `data-action`;
// one set of listeners per drawn entry turns the person's actions into
// events. An update builds the new DOM and morphs the old into it, so focus,
// typing, scroll and open <details> survive.

defineComponents();
defineBoundComponents();
connectBindings((message) => send(message), () => newTrace());

type Entry = { owner: string; order: number; el: HTMLElement };
const slots = new Map<Slot, Map<string, Entry>>();
const canvases = new Map<string, HTMLCanvasElement>();

function element(view: View, owner: string): HTMLElement {
  switch (view.type) {
    case "html": {
      const el = document.createElement("div");
      el.className = "html-view";
      el.append(sanitize(view.html, owner, { remote: view.remote === true }));
      return el;
    }
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
      el.dataset.action = view.action;
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
        button.dataset.action = item.action;
        li.append(button);
        el.append(li);
      }
      return el;
    }
    case "textarea": {
      const el = document.createElement("textarea");
      el.name = view.name;
      el.value = view.value;
      el.textContent = view.value;
      if (view.placeholder) el.placeholder = view.placeholder;
      // Plugins see edits after a short pause, as editor extensions do.
      el.dataset.action = view.action;
      el.dataset.live = "";
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
        for (const option of view.options ?? []) input.append(new Option(option, option, option === view.value, option === view.value));
      } else {
        input = document.createElement("input");
        input.type = view.kind;
        if (view.kind === "checkbox") {
          if (view.value) input.setAttribute("checked", "");
        } else input.setAttribute("value", String(view.value));
      }
      input.name = view.name;
      // Sent when the change is committed (blur, Enter, or a click), not on every key.
      input.dataset.action = view.action;
      if (view.kind === "checkbox") label.append(input, caption);
      else label.append(caption, input);
      return label;
    }
    case "diff": {
      const el = document.createElement("pre");
      el.className = "diff";
      for (const line of view.lines) {
        const span = document.createElement("span");
        span.className = line.op;
        span.textContent = `${line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}${line.text}`;
        el.append(span);
      }
      return el;
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
      if (!canvases.has(key)) {
        const el = document.createElement("canvas");
        el.width = view.width;
        el.height = view.height;
        el.dataset.canvas = key;
        const offscreen = el.transferControlToOffscreen();
        send({ t: "canvas", owner, id: view.id, canvas: offscreen }, [offscreen]);
        canvases.set(key, el);
      }
      // A stand-in; the live canvas takes its place once the view is drawn.
      const placeholder = document.createElement("canvas");
      placeholder.dataset.canvas = key;
      return placeholder;
    }
  }
}

/** The value a control holds, as a plugin wants it. */
function valueOf(control: Element): unknown {
  if (control instanceof HTMLInputElement) {
    if (control.type === "checkbox") return control.checked;
    if (control.type === "number" || control.type === "range") return control.valueAsNumber;
    return control.value;
  }
  if (control instanceof HTMLSelectElement && control.multiple) return [...control.selectedOptions].map((o) => o.value);
  return (control as HTMLSelectElement | HTMLTextAreaElement).value;
}

function formValues(form: HTMLFormElement): Record<string, unknown> {
  // No prototype, so a field named __proto__ or constructor is just a field.
  const out: Record<string, unknown> = Object.create(null);
  for (const control of form.elements) {
    const name = (control as HTMLInputElement).name;
    if (!name || control instanceof HTMLButtonElement || control instanceof HTMLFieldSetElement) continue;
    if (control instanceof HTMLInputElement && control.type === "radio") {
      if (control.checked) out[name] = control.value;
      else if (!Object.hasOwn(out, name)) out[name] = null;
      continue;
    }
    out[name] = valueOf(control);
  }
  return out;
}

const CONTROLS = "input, select, textarea";

/** One set of listeners per drawn entry; they look up the owner when an event happens. */
function listen(entry: Entry) {
  const el = entry.el;
  const event = (action: string, value?: unknown) => send({ t: "event", owner: entry.owner, action, value, trace: newTrace() });
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  el.addEventListener("click", (e) => {
    const target = (e.target as Element).closest("[data-action]");
    if (!target || !el.contains(target) || target.matches(`${CONTROLS}, form`)) return;
    event(target.getAttribute("data-action")!, target.getAttribute("data-value") ?? undefined);
  });
  el.addEventListener("change", (e) => {
    const target = e.target as Element;
    if (!target.matches(CONTROLS) || !target.hasAttribute("data-action") || target.hasAttribute("data-live")) return;
    event(target.getAttribute("data-action")!, valueOf(target));
  });
  el.addEventListener("input", (e) => {
    const target = e.target as Element;
    if (!target.matches(CONTROLS) || !target.hasAttribute("data-action") || !target.hasAttribute("data-live")) return;
    // Read the action and value now: a redraw may change the control before the timer fires.
    const action = target.getAttribute("data-action")!;
    const value = valueOf(target);
    clearTimeout(timers.get(target));
    timers.set(target, setTimeout(() => event(action, value), 300));
  });
  // Components (a bound table's row, a bound form's save) report through this event.
  el.addEventListener("ui-action", (e) => {
    const { action, value } = (e as CustomEvent<{ action: string; value: unknown }>).detail;
    event(action, value);
  });
  el.addEventListener("submit", (e) => {
    // Never let a plugin's form navigate the page.
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const action = form.getAttribute("data-action");
    if (action) event(action, formValues(form));
  });
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
  const next = document.createElement("div");
  next.append(element(view, owner));
  let entry = old;
  if (entry) {
    setOwner(entry.el, owner);
    morphChildren(entry.el, next);
    entry.owner = owner;
    entry.order = order;
  } else {
    next.dataset.key = key;
    setOwner(next, owner);
    entry = { owner, order, el: next };
    listen(entry);
    entries.set(key, entry);
    const sorted = [...entries.values()].sort((a, b) => a.order - b.order);
    container.append(...sorted.map((e) => e.el));
  }
  for (const placeholder of entry.el.querySelectorAll<HTMLCanvasElement>("canvas[data-canvas]")) {
    const live = canvases.get(placeholder.dataset.canvas!);
    if (live && live !== placeholder) placeholder.replaceWith(live);
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

// ---- Demos ----
// Each file in demos/ is an ordinary plugin. Picking one installs it, as a
// person installing a plugin would; `?demo=<name>` does the same on load.
const DEMOS = import.meta.glob("../../demos/*.js", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const demoName = (path: string) => path.split("/").pop()!.replace(/\.js$/, "");
const picker = document.getElementById("demo") as HTMLSelectElement;
for (const path of Object.keys(DEMOS).sort()) picker.append(new Option(demoName(path), demoName(path)));
const installDemo = async (name: string) => {
  const path = Object.keys(DEMOS).find((p) => demoName(p) === name);
  if (!path) return;
  const outcome = (await command("install", DEMOS[path])) as { ok: boolean; error?: string };
  if (!outcome.ok) notice(`Couldn't add the ${name} demo: ${outcome.error}`);
  const url = new URL(location.href);
  url.searchParams.set("demo", name);
  history.replaceState(null, "", url);
  return outcome;
};
picker.onchange = () => {
  if (picker.value) void installDemo(picker.value);
};
/** Resolves once the kernel has said hello to this tab. */
let welcomed: () => void;
const kernelReady = new Promise<void>((resolve) => (welcomed = resolve));
if (params.get("demo")) {
  picker.value = params.get("demo")!;
  void kernelReady.then(() => installDemo(params.get("demo")!));
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

document.getElementById("reference")!.onclick = async () => {
  const pre = document.getElementById("reference-text")!;
  if (!pre.hidden) return void (pre.hidden = true);
  const r = (await command("reference")) as { live: string };
  pre.textContent = r.live;
  pre.hidden = false;
};

// ---- Kernel messages ----

let spawner = false;
port.onmessage = async (e: MessageEvent<KernelToHost>) => {
  const message = e.data;
  if (receive(message)) return;
  switch (message.t) {
    case "welcome":
      spawner = message.spawner;
      welcomed();
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
