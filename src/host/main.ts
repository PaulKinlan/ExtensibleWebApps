// The host: the only code on the main thread. It draws the views plugins
// send into the page's <slot name> elements, turns the person's actions into
// events, creates plugin workers when it is the spawner tab, and bridges APIs
// that only exist in a page (Web Audio here). It runs no plugin code.
//
// The page is an app: an app.html that links its plugins with
// <link rel="plugin" href="…">. The host fetches each one and asks the
// kernel to run it, and shows only the views those plugins draw. A page that
// links no plugins is the platform's own workbench (index.html), which shows
// every view along with the trace and the plugins panel.

import type { Command, HostToKernel, KernelToHost, Slot, TraceEvent, View } from "../shared/protocol";
import { answerElements, connectBindings, receive, setOwner } from "./bindings";
import { defineElementsIn, onElementError } from "./elements";
import { morphChildren } from "./morph";
import { sanitize } from "./sanitize";
import { cleanCss, installPluginStyle } from "./plugin-styles";
import { fill, loadedFile, loadFile, styleOf } from "./templates";
import { workbench } from "./workbench";

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

// ---- Reporting problems ----
//
// What goes wrong in the page (a plugin file or template that didn't load,
// an uncaught error) is reported to the kernel, which puts it in the trace
// with everything else. A debug console plugin reads it from there. Reports
// wait until the kernel knows this tab, and a page that throws in a loop is
// cut off at 20 a second.

let introduced = false;
const unsent: Extract<HostToKernel, { t: "report" }>[] = [];
let reportWindow = 0;
let reportCount = 0;
function report(source: string, text: string) {
  const now = Math.floor(Date.now() / 1000);
  if (now !== reportWindow) [reportWindow, reportCount] = [now, 0];
  if (++reportCount > 20) return;
  const message = { t: "report" as const, source, text: text.slice(0, 2000) };
  if (introduced) send(message);
  else unsent.push(message);
}
addEventListener("error", (e) => report("error", `${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`));
addEventListener("unhandledrejection", (e) => report("unhandled", e.reason instanceof Error ? e.reason.message : String(e.reason)));
onElementError((name, error) => report("element", `Couldn't load <${name}>: ${error instanceof Error ? error.message : error}`));
let traceCounter = 0;
const newTrace = () => `${tab}-${++traceCounter}`;

// ---- Views ----
//
// Every view, JSON or HTML, becomes DOM whose controls carry `data-action`;
// one set of listeners per drawn entry turns the person's actions into
// events. An update builds the new DOM and morphs the old into it, so focus,
// typing, scroll and open <details> survive.

answerElements(document);
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
    case "template": {
      // render() has made sure the file is loaded. Filled, it is HTML like any other view.
      // The file's <style>, if it has one, is scoped to this plugin's views (see plugin-styles.ts).
      const file = loadedFile(view.src)!;
      installPluginStyle(pluginOf(owner), view.src, styleOf(file));
      const el = document.createElement("div");
      el.className = "html-view";
      el.append(sanitize(fill(file, view.id, view.data), owner, { remote: view.remote === true }));
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

// ---- The app ----

/** The plugins this page's app links; the kernel answers with their ids. */
const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="plugin"]')].map((link) => link.href);
/** Whose views this page shows: its app's plugins, or (on the workbench) everyone's. */
let shown: Set<string> | "all" = links.length ? new Set() : "all";
/** Review cards always show: the person must see what a plugin wants to change. */
const ALWAYS = new Set(["review"]);
/** A tab-scoped plugin's views come from an instance such as `drawing@tab1`; the app linked `drawing`. */
const showing = (owner: string) => shown === "all" || shown.has(owner.split("@")[0]) || ALWAYS.has(owner);
/** Views for owners this page doesn't show (yet): kept, in case the app's plugins are still starting. */
const held = new Map<string, Extract<KernelToHost, { t: "render" }>>();

async function openApp() {
  const plugins = await Promise.all(
    links.map(async (href) => {
      const response = await fetch(href).catch((error: Error) => error);
      if (response instanceof Response && response.ok) return { href, source: await response.text(), why: "" };
      return { href, source: "", why: response instanceof Response ? `it answered ${response.status}` : response.message };
    }),
  );
  for (const { href, source, why } of plugins) if (!source) notice(`Couldn't load the plugin at ${href}: ${why}`);
  send({ t: "open", plugins: plugins.filter((p) => p.source).map(({ href, source }) => ({ href, source })) });
}

function opened(plugins: { href: string; id?: string; error?: string }[]) {
  for (const p of plugins) if (p.error) notice(`${p.href.split("/").pop()}: ${p.error}`);
  shown = new Set(plugins.flatMap((p) => (p.id && !p.error ? [p.id] : [])));
  for (const [id, message] of held) {
    if (!showing(message.owner)) continue;
    held.delete(id);
    render(message.slot, message.key, message.owner, message.order, message.view);
  }
}

// ---- Slots ----
//
// A view goes into the <slot name> it names. Whatever the page put inside a
// slot is its fallback, shown until some plugin draws there.

const fallbacks = new Map<HTMLElement, HTMLElement>();
function slotFor(name: Slot, owner: string): HTMLElement | null {
  let slot = document.querySelector<HTMLElement>(`slot[name="${CSS.escape(name)}"]`);
  // A review card must be seen, even in an app with no slot of that name.
  if (!slot && ALWAYS.has(owner)) slot = document.getElementById("review") ?? document.body.appendChild(Object.assign(document.createElement("section"), { id: "review" }));
  if (slot && !fallbacks.has(slot)) {
    const fallback = document.createElement("span");
    fallback.className = "fallback";
    fallback.append(...slot.childNodes);
    slot.append(fallback);
    fallbacks.set(slot, fallback);
  }
  return slot;
}

/** The plugin an owner is an instance of: "month@tab-1" is an instance of "month". */
const pluginOf = (owner: string) => owner.split("@")[0];

/** Every template file a view uses, including inside stacks. */
function templateFiles(view: View): string[] {
  if (view.type === "template") return [view.src];
  if (view.type === "stack") return view.children.flatMap(templateFiles);
  return [];
}

const waitingForFile = new Map<string, [Slot, string, string, number, View]>();

function render(slot: Slot, key: string, owner: string, order: number, view: View | null) {
  const id = `${slot}/${key}`;
  if (!showing(owner)) {
    if (view) held.set(id, { t: "render", slot, key, owner, order, view });
    else held.delete(id);
    return;
  }
  // A template view (or a stack holding one) waits for its files; the latest view for this slot and key is drawn once they load.
  const missing = view ? templateFiles(view).filter((src) => !loadedFile(src)) : [];
  if (missing.length) {
    waitingForFile.set(id, [slot, key, owner, order, view!]);
    Promise.all(missing.map(loadFile)).then(
      () => {
        const latest = waitingForFile.get(id);
        waitingForFile.delete(id);
        if (latest) render(...latest);
      },
      (error) => {
        // Only if this view is still the one waiting: the key may since have been removed or redrawn.
        const latest = waitingForFile.get(id);
        if (latest?.[4] !== view) return;
        waitingForFile.delete(id);
        const [s, k, o, n] = latest;
        const text = `Couldn't load ${missing.join(", ")}: ${error instanceof Error ? error.message : error}`;
        report("template", `${o}: ${text}`);
        render(s, k, o, n, { type: "text", text, tone: "error" });
      },
    );
    return;
  }
  waitingForFile.delete(id);
  const container = slotFor(slot, owner);
  if (!container) return;
  const entries = slots.get(slot) ?? new Map<string, Entry>();
  slots.set(slot, entries);
  const old = entries.get(key);
  if (!view) {
    old?.el.remove();
    entries.delete(key);
    fallbacks.get(container)!.hidden = entries.size > 0;
    return;
  }
  const next = document.createElement("div");
  next.append(element(view, owner));
  let entry = old;
  // Which plugin's stylesheet applies here. Instances of one plugin share it.
  next.dataset.plugin = pluginOf(owner);
  if (entry) {
    setOwner(entry.el, owner);
    entry.el.dataset.plugin = next.dataset.plugin;
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
    fallbacks.get(container)!.hidden = true;
  }
  defineElementsIn(entry.el);
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

function notice(text: string, reported = true) {
  if (reported) report("notice", text);
  const p = document.createElement("p");
  p.textContent = text;
  const area = document.getElementById("notice") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "notice", role: "status" }));
  area.append(p);
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

/** The trace, benchmarks and demo links, on the platform's own page only. */
const bench = document.getElementById("devtools") ? workbench(command) : undefined;
const traces: TraceEvent[] = [];
function showTrace(events: TraceEvent[]) {
  traces.push(...events);
  if (traces.length > 1000) traces.splice(0, traces.length - 1000);
  bench?.trace(events);
}

// ---- Kernel messages ----

let spawner = false;
port.onmessage = async (e: MessageEvent<KernelToHost>) => {
  const message = e.data;
  if (receive(message)) return;
  switch (message.t) {
    case "welcome":
      spawner = message.spawner;
      bench?.mode(`Kernel in a ${message.mode} worker · tab ${tab}${spawner ? " · runs the plugin workers" : ""}`);
      return;
    case "opened":
      return opened(message.plugins);
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
      // The kernel's own notices are in its trace already.
      return notice(message.text, false);
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
introduced = true;
for (const message of unsent.splice(0)) send(message);
if (links.length) await openApp();

// For tests and poking around in the console.
// Tests reach the template filler and the CSS cleaner here, to check them without a plugin.
Object.assign(window, { __host: { tab, command, traces, audioStats, workers, fill, cleanCss, report, get spawner() { return spawner; } } });
