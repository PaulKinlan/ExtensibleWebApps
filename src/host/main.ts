// The host: the only code on the main thread. It draws the views plugins
// send into the page's <slot name> elements, turns the person's actions into
// events, creates plugin workers when it is the spawner tab, and bridges APIs
// that only exist in a page (Web Audio here). It runs no plugin code.
//
// The page is an app: an app.html that links its plugins with
// <link rel="plugin" href="…">. The host fetches each one and asks the
// kernel to run it, along with the plugins the person added to this app
// themselves, and shows only the views those plugins draw: in the page's
// slots, or in places their manifests name (places.ts). The platform's own
// workbench (workbench/index.html, the page with the trace) shows every view along
// with the trace and the plugins panel.

import type { Command, HostToKernel, KernelToHost, Opened, Slot, TraceEvent, View } from "../shared/protocol";
import { customize } from "./customize";
import { places as makePlaces } from "./places";
import { bridges } from "./bridges";
import { audioStats } from "./bridges/audio";
import { answerElements, connectBindings, receive, setOwner } from "./bindings";
import { defineElementsIn, onElementError } from "./elements";
import { morphChildren } from "./morph";
import { serviceWorker } from "./service-worker";
import { cleanCss } from "./plugin-styles";
import { fill, forgetFiles, loadedFile, loadFile } from "./templates";
import { drawView } from "./views";
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

// Each kind of view is drawn by its own file in views/, named after its type.
function element(view: View, owner: string): HTMLElement {
  return drawView(view, { owner, tab, send, canvases, element: (child) => element(child, owner) });
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
    // A submit button in a form sends its action with the form's fields, on submit.
    if (target instanceof HTMLButtonElement && target.type === "submit" && target.form?.hasAttribute("data-action")) return;
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
    // The button that sent it may name its own action, so one form can be checked or saved.
    if (!form.hasAttribute("data-action")) return;
    const action = (e as SubmitEvent).submitter?.getAttribute("data-action") ?? form.getAttribute("data-action")!;
    event(action, formValues(form));
  });
}

// ---- The app ----

/** The plugins this page's app links; the kernel answers with their ids. */
const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="plugin"]')].map((link) => link.href);
/** The platform's own page, with the trace. Every other page is an app, even one that links no plugins. */
const isWorkbench = !!document.getElementById("devtools");
/** The app's folder, which names where the person's own plugins for it are kept: `demos/trip` for /demos/trip/app.html. */
const app = location.pathname.replace(/\/[^/]*$/, "").replace(/^\/+/, "") || "root";
/** Whose views this page shows: its app's plugins, or (on the workbench) everyone's. */
let shown: Set<string> | "all" = isWorkbench ? "all" : new Set();
/** Review cards always show: the person must see what a plugin wants to change. */
const ALWAYS = new Set(["review", "secrets"]);
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
  // ?reset turns this app's plugins back on, for when a person has switched off the very plugin that would do it.
  // It works once: the address loses it, so reloading doesn't reset again.
  const reset = params.has("reset");
  if (reset) {
    const url = new URL(location.href);
    url.searchParams.delete("reset");
    history.replaceState(history.state, "", url);
  }
  send({ t: "open", plugins: plugins.filter((p) => p.source).map(({ href, source }) => ({ href, source })), reset, app });
}

/** The screen this tab shows, from the address's hash: `#/book/42?tab=notes`. The router service hands it to plugins. */
function sendUrl() {
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?", 2);
  send({ t: "url", path: path.startsWith("/") ? path : "/", query: Object.fromEntries(new URLSearchParams(search)) });
}

/** The plugins running for this app, as the kernel last said: the Customize panel lists them. */
let running: Opened[] = [];

function opened(plugins: Opened[]) {
  for (const p of plugins) if (p.error && !running.some((r) => r.href === p.href && r.error === p.error)) notice(`${p.href.split("/").pop()}: ${p.error}`);
  running = plugins;
  // The person may have added a plugin again with new files: load its templates afresh.
  forgetFiles(`/user/${app}/`);
  const before = shown;
  shown = new Set(plugins.flatMap((p) => (p.id && !p.error ? [p.id] : [])));
  // A plugin that is no longer shown (turned off) takes its views with it.
  if (before !== "all") for (const id of before) if (!shown.has(id)) clearOwner(id);
  // Places first, so held views that go to a place find it.
  pagePlaces.configure(plugins);
  for (const [id, message] of held) {
    if (!showing(message.owner)) continue;
    held.delete(id);
    render(message.slot, message.key, message.owner, message.order, message.view);
  }
  panel?.refresh();
}

/**
 * Removes everything a plugin drew in this page. Its views are held, as if they had come while it was
 * hidden: if another tab keeps the plugin running, it won't draw them again when it is shown here again.
 * If it stops, the kernel takes its views away, and they go from what is held too.
 */
function clearOwner(plugin: string) {
  for (const [id, message] of drawn) if (pluginOf(message.owner) === plugin) {
    held.set(id, message);
    drawn.delete(id);
  }
  for (const [id, args] of placeRenders) if (pluginOf(args[2]) === plugin) placeRenders.delete(id);
  for (const [slot, entries] of slots)
    for (const [key, entry] of entries) {
      if (pluginOf(entry.owner) !== plugin) continue;
      entry.el.remove();
      entries.delete(key);
      const container = containerOf.get(entry);
      if (container) afterChange(container, slot);
    }
}

// ---- Slots ----
//
// A view goes into the <slot name> it names. Whatever the page put inside a
// slot is its fallback, shown until some plugin draws there.

const fallbacks = new Map<HTMLElement, HTMLElement>();
function withFallback(container: HTMLElement): HTMLElement {
  if (!fallbacks.has(container)) {
    const fallback = document.createElement("span");
    fallback.className = "fallback";
    fallback.append(...container.childNodes);
    container.append(fallback);
    fallbacks.set(container, fallback);
  }
  return container;
}

/**
 * Where a view for `name` goes: the page's <slot name>, or else the containers of the owner's place of
 * that name (a place with `each` has one per match). Each comes with the id its entries are kept under.
 */
function slotFor(name: Slot, owner: string): [string, HTMLElement][] {
  // A review card must be seen, wherever the person is on the page: it goes in a dialog of the host's own.
  if (ALWAYS.has(owner)) return [["#review", reviewDialog()]];
  const slot = document.querySelector<HTMLElement>(`slot[name="${CSS.escape(name)}"]`);
  if (slot) return [[name, withFallback(slot)]];
  return (pagePlaces.containers(pluginOf(owner), name) ?? []).map(([id, c]) => [id, withFallback(c)]);
}

// ---- Places ----
//
// A render to a name the page has no slot for may be for one of the
// owner's places. Those renders are remembered, so the view can be drawn
// once the place is ready (after a review card, say) and drawn again if it
// is set up anew (the person unlocked it).

const placeRenders = new Map<string, [Slot, string, string, number, View]>();
const containerOf = new WeakMap<Entry, HTMLElement>();
const pagePlaces = makePlaces({
  ask: (plugin, place, target, what) => command("place:ask", { app, plugin, place, target, what }).then(Boolean),
  changed: (plugin, name) => {
    // That place's containers are new: forget the entries that were in its old ones, then draw it again.
    for (const id of [...slots.keys()]) if (id.startsWith(`${plugin}/${name}#`)) slots.delete(id);
    for (const args of [...placeRenders.values()]) if (pluginOf(args[2]) === plugin && args[0].split("#")[0] === name) render(...args);
  },
  report: (text) => report("place", text),
});

/**
 * The dialog that holds review cards. It isn't modal, so the person can still read the page (and the
 * code being reviewed) while it is open, but it stays in view, and focus moves to it when a card arrives.
 */
function reviewDialog(): HTMLDialogElement {
  const found = document.getElementById("review");
  if (found instanceof HTMLDialogElement) return found;
  const dialog = Object.assign(document.createElement("dialog"), { id: "review" });
  dialog.setAttribute("aria-label", "Waiting for your answer");
  return document.body.appendChild(dialog);
}

/** Opens the review dialog when it holds a card, and closes it when the last one is answered. */
function syncReview(dialog: HTMLDialogElement, count: number) {
  if (count && !dialog.open) {
    dialog.show();
    dialog.querySelector<HTMLElement>("button")?.focus();
  } else if (!count && dialog.open) dialog.close();
}

/** After a container's entries change: show its fallback when empty, and tell its place. */
function afterChange(container: HTMLElement, _slot: string) {
  const count = container.querySelectorAll(":scope > [data-key]").length;
  if (container.id === "review" && container instanceof HTMLDialogElement) return syncReview(container, count);
  const fallback = fallbacks.get(container);
  if (fallback) fallback.hidden = count > 0;
  pagePlaces.sync(container, count);
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
/** The views drawn in this page, as they came, so a plugin turned off here can be shown again. */
const drawn = new Map<string, Extract<KernelToHost, { t: "render" }>>();

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
  if (view) drawn.set(id, { t: "render", slot, key, owner, order, view });
  else drawn.delete(id);
  const targets = slotFor(slot, owner);
  // Not a slot in this page: remember it, in case it is for a place that isn't ready yet.
  const isPlace = !ALWAYS.has(owner) && !document.querySelector(`slot[name="${CSS.escape(slot)}"]`);
  if (isPlace) {
    // A view to every match replaces what was drawn to one of them, so drawing again later gives the same page.
    if (!slot.includes("#")) for (const [other, args] of placeRenders) if (args[1] === key && pluginOf(args[2]) === pluginOf(owner) && args[0].startsWith(`${slot}#`)) placeRenders.delete(other);
    // Latest last: it is drawn again in this order.
    placeRenders.delete(id);
    if (view) placeRenders.set(id, [slot, key, owner, order, view]);
  }
  // A view to `name` also clears what was drawn to `name#i`, and the other way round, so keys stay unique per container.
  for (const [slotId, container] of targets) drawIn(slotId, container, key, owner, order, view);
  if (isPlace && !view && !slot.includes("#")) for (const [slotId, entries] of slots) if (slotId.startsWith(`${pluginOf(owner)}/${slot.split("#")[0]}#`) && entries.has(key)) {
    const entry = entries.get(key)!;
    entry.el.remove();
    entries.delete(key);
    afterChange(containerOf.get(entry)!, slotId);
  }
}

function drawIn(slot: string, container: HTMLElement, key: string, owner: string, order: number, view: View | null) {
  const entries = slots.get(slot) ?? new Map<string, Entry>();
  slots.set(slot, entries);
  const old = entries.get(key);
  if (!view) {
    old?.el.remove();
    entries.delete(key);
    afterChange(container, slot);
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
    containerOf.set(entry, container);
    listen(entry);
    entries.set(key, entry);
    const sorted = [...entries.values()].sort((a, b) => a.order - b.order);
    container.append(...sorted.map((e) => e.el));
    afterChange(container, slot);
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

// ---- Bridges to page-only APIs: a file each in bridges/ ----

const bridge = bridges({ workers, places: pagePlaces });

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

/** The trace, benchmarks and demo links, on the workbench page only. */
const bench = document.getElementById("devtools") ? workbench(command) : undefined;
serviceWorker(command, report);
const traces: TraceEvent[] = [];
function showTrace(events: TraceEvent[]) {
  traces.push(...events);
  // Kept generously: the tests look back to events from the first seconds after a long run.
  if (traces.length > 5000) traces.splice(0, traces.length - 5000);
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
/** Every app gets the Customize button, where the person adds their own plugins. */
const panel = isWorkbench ? undefined : customize({ app, command, running: () => running, places: () => pagePlaces.status() });
if (!isWorkbench) await openApp();
sendUrl();
addEventListener("hashchange", sendUrl);

// For tests and poking around in the console.
// Tests reach the template filler and the CSS cleaner here, to check them without a plugin.
Object.assign(window, { __host: { tab, app, command, traces, audioStats, workers, fill, cleanCss, report, places: () => pagePlaces.status(), get spawner() { return spawner; } } });
