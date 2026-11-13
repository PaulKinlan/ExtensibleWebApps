// Fast in-memory test harness and runner for apps and plugins.
//
//   import { createTestHarness } from "extensible-web-apps/test";
//
// `createTestHarness(appDir, options)` boots the real kernel (`src/kernel/kernel.ts`)
// in-process against the `memory` seam (`src/seams/memory.ts`), spawns the app's
// linked plugins in `node:worker_threads` running `src/sandbox/runtime.ts`, fills
// `<template id>` views without a browser, and lets tests inspect views, send UI
// events, run commands, read/write collections, and approve or decline review cards
// in milliseconds.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import { projectKernel } from "./project-kernel.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
export const PLATFORM = resolve(dirname(THIS_FILE), "..");
const TEST_ORIGIN = "http://test.local";

/** Cached esbuild outputs by key (`platform` + `kernel.json` settings), built once per process. */
const kernelBundles = new Map();
const runtimeBundles = new Map();
let nextBootId = 0;

/** Bundles `src/kernel/kernel.ts` with `memoryFiles` and the active kernel modules. */
async function getKernelBundle(platform, ownKernel) {
  const key = `${platform}::${JSON.stringify(ownKernel ?? null)}`;
  if (kernelBundles.has(key)) return kernelBundles.get(key);

  const rootKernel = JSON.parse(readFileSync(join(platform, "kernel.json"), "utf8"));
  const activeModules = ownKernel?.modules ?? rootKernel.modules ?? [];
  const activeHooks = ownKernel ? (ownKernel.hooks ?? {}) : (rootKernel.hooks ?? {});
  const servicesDir = join(platform, "src/kernel/services");
  const serviceFiles = readdirSync(servicesDir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();

  const plugin = {
    name: "ewa-in-memory-kernel",
    setup(b) {
      b.onResolve({ filter: /^virtual:kernel-modules$/ }, () => ({ path: "virtual:kernel-modules", namespace: "virtual" }));
      b.onLoad({ filter: /.*/, namespace: "virtual" }, () => {
        const imports = activeModules.map((n, i) => `import m${i} from ${JSON.stringify(resolve(platform, "std", n, "module.ts"))};`);
        const entries = activeModules.map((n, i) => {
          const manifest = JSON.parse(readFileSync(resolve(platform, "std", n, "module.json"), "utf8"));
          return `{ name: ${JSON.stringify(n)}, manifest: ${JSON.stringify(manifest)}, module: m${i} }`;
        });
        return {
          contents: `${imports.join("\n")}\nexport default [${entries.join(", ")}];\nexport const hookLimits = ${JSON.stringify(activeHooks)};`,
          loader: "ts",
          resolveDir: platform,
        };
      });
      b.onLoad({ filter: /src[\/\\]kernel[\/\\]services[\/\\]index\.ts$/ }, (args) => {
        const src = readFileSync(args.path, "utf8");
        const imports = serviceFiles.map((f, i) => `import * as s${i} from "./${f}";`).join("\n");
        const map = `{ ${serviceFiles.map((f, i) => `${JSON.stringify("./" + f)}: s${i}`).join(", ")} }`;
        return { contents: `${imports}\n${src.replace(/import\.meta\.glob[^;]+/, map)}`, loader: "ts", resolveDir: servicesDir };
      });
      b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
    },
  };

  const entry = `
    import { setEnv } from "./src/kernel/env.ts";
    import { memoryFiles } from "./src/seams/memory.ts";
    const boot = globalThis.__ewaTestBoot;
    delete globalThis.__ewaTestBoot;
    __kernelTimers = boot.timers;
    const files = boot.files ?? memoryFiles();
    if (boot.seed) {
      for (const [p, v] of Object.entries(boot.seed)) await files.write(p, v);
    }
    boot.exposedFiles = files;
    setEnv({
      kind: "dedicated",
      origin: boot.origin,
      folder: files,
      fetch: boot.fetch ?? globalThis.fetch,
      connect(accept) { boot.connect(accept); },
      onError(report) { boot.onError?.(report); },
    });
    await import("./src/kernel/kernel.ts");
  `;

  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: platform, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["node:*"],
    banner: {
      js: "let __kernelTimers; const __kernelSetTimeout = (fn, ms, ...r) => { const h = globalThis.setTimeout(fn, ms, ...r); __kernelTimers?.add(h); return h; };",
    },
    define: { BroadcastChannel: "undefined", setTimeout: "__kernelSetTimeout" },
    logLevel: "silent",
    plugins: [plugin],
  });
  const text = out.outputFiles[0].text;
  kernelBundles.set(key, text);
  return text;
}

/** Bundles `src/sandbox/runtime.ts` for `node:worker_threads` with in-flight call/hook tracking. */
async function getRuntimeBundle(platform) {
  if (runtimeBundles.has(platform)) return runtimeBundles.get(platform);

  const entry = `
    import { parentPort } from "node:worker_threads";

    const selfObj = globalThis;
    selfObj.self = globalThis;
    globalThis.navigator ??= {};
    const listeners = new Map();
    selfObj.addEventListener = (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    const fire = (type, event) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    };
    process.on("uncaughtException", (err) => fire("error", { message: err?.message ?? String(err) }));
    process.on("unhandledRejection", (reason) => fire("unhandledrejection", { reason, preventDefault() {} }));

    selfObj.__moduleUrl = (source) => "data:text/javascript;base64," + Buffer.from(source).toString("base64");

    let inFlightCalls = 0;
    let inFlightHooks = 0;
    let initializing = true;
    const early = [];
    let loaded = false;

    function handleParentMessage(msg) {
      if (msg?.t === "__status") {
        setImmediate(() => {
          parentPort.postMessage({ t: "__status", id: msg.id, busy: (initializing ? 1 : 0) + inFlightCalls + inFlightHooks });
        });
        return;
      }
      if (msg?.t !== "init") return;
      if (!msg.network) {
        for (const name of ["fetch", "WebSocket", "EventSource"]) {
          try { Reflect.deleteProperty(globalThis, name); } catch {}
        }
      }
      const rawPort = msg.port;
      const wrappedPort = {
        onmessage: null,
        postMessage(out) {
          if (out?.t === "ready" || out?.t === "failed") initializing = false;
          else if (out?.t === "call") inFlightCalls++;
          else if (out?.t === "hook:result") inFlightHooks = Math.max(0, inFlightHooks - 1);
          rawPort.postMessage(out);
        },
        start() { rawPort.start(); },
        close() { rawPort.close(); },
      };
      rawPort.on("message", (data) => {
        if (data?.t === "result") inFlightCalls = Math.max(0, inFlightCalls - 1);
        else if (data?.t === "hook" && data.id !== undefined) inFlightHooks++;
        wrappedPort.onmessage?.({ data });
        if (data?.t === "event" && data.trace) {
          setImmediate(() => parentPort.postMessage({ t: "__ack_event", trace: data.trace }));
        }
      });
      selfObj.onmessage?.({ data: { t: "init", source: msg.source }, ports: [wrappedPort] });
    }

    parentPort.on("message", (msg) => (loaded ? handleParentMessage(msg) : early.push(msg)));
    await import("./src/sandbox/runtime.ts");
    loaded = true;
    for (const msg of early.splice(0)) handleParentMessage(msg);
  `;

  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: platform, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["node:*"],
    logLevel: "silent",
  });
  const text = out.outputFiles[0].text;
  runtimeBundles.set(platform, text);
  return text;
}

/** Two in-memory ports that pass messages in order on the microtask queue (like `src/kernel/isolate-host.ts`). */
function createPortPair() {
  const makeEnd = () => ({
    onmessage: null,
    other: null,
    closed: false,
    postMessage(data) {
      if (!this.closed && this.other && !this.other.closed) {
        queueMicrotask(() => {
          if (!this.other.closed) this.other.onmessage?.({ data });
        });
      }
    },
    start() {},
    close() {
      this.closed = true;
    },
  });
  const a = makeEnd();
  const b = makeEnd();
  a.other = b;
  b.other = a;
  return [a, b];
}

// ---- HTML template filling (matching `src/host/templates.ts` without a browser DOM) ----

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const HOLE = /\{\{\s*(!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}/g;
const WHOLE_ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"\{\{\s*(!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}"|'\{\{\s*(!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}')/g;

function lookup(scope, path) {
  const neg = path.startsWith("!");
  let cur = scope;
  for (const part of (neg ? path.slice(1) : path).split(".")) {
    if (cur === null || cur === undefined) break;
    const own = typeof cur === "object" && Object.hasOwn(cur, part);
    cur = own || (part === "length" && (Array.isArray(cur) || typeof cur === "string")) ? cur[part] : undefined;
  }
  return neg ? !cur : cur;
}

const holeText = (v) => (v === null || v === undefined || v === false ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Finds matching `</template>` accounting for nested `<template ...>` tags. */
function findTemplateEnd(html, openEnd) {
  const tagRe = /<\/?template\b[^>]*>/gi;
  tagRe.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith("</")) {
      if (--depth === 0) return { innerEnd: m.index, afterEnd: tagRe.lastIndex };
    } else if (!m[0].endsWith("/>")) {
      depth++;
    }
  }
  return { innerEnd: html.length, afterEnd: html.length };
}

/** Extracts `<template id="...">` content from an `.html` template file. */
function extractTemplateById(fileHtml, id) {
  const clean = fileHtml.replace(/<!--[\s\S]*?-->/g, "");
  const openRe = /<template\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(clean))) {
    const attrs = m[1];
    const end = findTemplateEnd(clean, openRe.lastIndex);
    const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const foundId = idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3];
    if (foundId === id) return clean.slice(openRe.lastIndex, end.innerEnd);
    openRe.lastIndex = end.afterEnd;
  }
  return null;
}

function fillSegment(segment, scope) {
  // Replace whole-hole attributes inside tags, then general holes in tags and text.
  return segment.replace(/<([A-Za-z][\w:-]*)(\s[^>]*)?>|([^<]+)/g, (full, tag, attrs, textNode) => {
    if (textNode !== undefined) {
      return textNode.replace(HOLE, (_, p) => escapeHtml(holeText(lookup(scope, p))));
    }
    if (!attrs) return full;
    const close = full.endsWith("/>") ? "/>" : ">";
    const body = full.endsWith("/>") ? attrs.slice(0, -1) : attrs;
    const withWhole = body.replace(WHOLE_ATTR, (_, attrName, p1, p2) => {
      const val = lookup(scope, p1 ?? p2);
      if (val === false || val === null || val === undefined) return "";
      return val === true ? attrName : `${attrName}="${escapeHtml(holeText(val))}"`;
    });
    const filledAttrs = withWhole.replace(HOLE, (_, p) => escapeHtml(holeText(lookup(scope, p))));
    return `<${tag}${filledAttrs}${close}`;
  });
}

function renderTemplateBody(body, scope) {
  let out = "";
  let cursor = 0;
  const openRe = /<template\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(body))) {
    out += fillSegment(body.slice(cursor, m.index), scope);
    const attrs = m[1];
    const end = findTemplateEnd(body, openRe.lastIndex);
    const inner = body.slice(openRe.lastIndex, end.innerEnd);
    const forAttr = /\bfor\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const ifAttr = /\bif\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (forAttr) {
      const expr = forAttr[1] ?? forAttr[2] ?? "";
      const [, itemVar, listPath] = /^\s*([A-Za-z_$][\w$]*)\s+of\s+(\S+)\s*$/.exec(expr) ?? [];
      const items = itemVar ? lookup(scope, listPath) : undefined;
      if (Array.isArray(items)) {
        for (const item of items) out += renderTemplateBody(inner, { ...scope, [itemVar]: item });
      }
    } else if (ifAttr) {
      const cond = (ifAttr[1] ?? ifAttr[2] ?? "").trim();
      if (lookup(scope, cond)) out += renderTemplateBody(inner, scope);
    } else {
      out += renderTemplateBody(inner, scope);
    }
    cursor = end.afterEnd;
    openRe.lastIndex = cursor;
  }
  out += fillSegment(body.slice(cursor), scope);
  return out;
}

function stripTags(html) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function renderViewToHtml(view, resolveTemplateFile) {
  if (!view) return "";
  switch (view.type) {
    case "html":
      return view.html ?? "";
    case "template": {
      const fileText = resolveTemplateFile(view.src);
      if (fileText === undefined) return `<p>Missing template file ${escapeHtml(view.src)}</p>`;
      const tpl = extractTemplateById(fileText, view.id);
      if (tpl === null) return `<p>No template with id ${escapeHtml(view.id)}.</p>`;
      const scope = view.data && typeof view.data === "object" && !Array.isArray(view.data) ? view.data : { value: view.data };
      return renderTemplateBody(tpl, scope);
    }
    case "stack":
      return (view.children ?? []).map((c) => renderViewToHtml(c, resolveTemplateFile)).join("");
    case "heading":
      return `<h3>${escapeHtml(view.text ?? "")}</h3>`;
    case "text":
      return `<p>${escapeHtml(view.text ?? "")}</p>`;
    case "button":
      return `<button data-action="${escapeHtml(view.action ?? "")}">${escapeHtml(view.label ?? "")}</button>`;
    case "list":
      return `<ul>${(view.items ?? []).map((i) => `<li data-action="${escapeHtml(i.action ?? "")}">${escapeHtml(i.label ?? "")}</li>`).join("")}</ul>`;
    case "textarea":
      return `<textarea name="${escapeHtml(view.name ?? "")}" data-action="${escapeHtml(view.action ?? "")}">${escapeHtml(view.value ?? "")}</textarea>`;
    case "field":
      return `<label>${escapeHtml(view.label ?? "")}<input name="${escapeHtml(view.name ?? "")}" value="${escapeHtml(view.value ?? "")}" data-action="${escapeHtml(view.action ?? "")}"></label>`;
    case "diff":
      return `<pre>${(view.lines ?? []).map((l) => `${l.op === "add" ? "+" : l.op === "del" ? "-" : " "} ${escapeHtml(l.text ?? "")}`).join("\n")}</pre>`;
    case "canvas":
      return `<canvas id="${escapeHtml(view.id ?? "")}" width="${Number(view.width ?? 0)}" height="${Number(view.height ?? 0)}"></canvas>`;
    default:
      return "";
  }
}

// ---- App HTML link parsing & path resolution ----

function parseAppLinks(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  for (const m of clean.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const relVal = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").trim().toLowerCase();
    const hrefVal = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    const tokens = relVal.split(/\s+/);
    if (!hrefVal) continue;
    if (tokens.includes("plugin")) out.push({ kind: "plugin", href: hrefVal });
    else if (tokens.includes("agent")) out.push({ kind: "agent", href: hrefVal });
  }
  return out;
}

function resolveDiskFile(urlPath, appDir, isRootProject, platform) {
  const clean = decodeURIComponent(urlPath.replace(/[?#].*$/, ""));
  if (isRootProject) {
    const inProject = join(appDir, clean);
    if (existsSync(inProject) && statSync(inProject).isFile()) return inProject;
  }
  const inPlatform = join(platform, clean);
  if (existsSync(inPlatform) && statSync(inPlatform).isFile()) return inPlatform;
  const inSite = join(platform, "site", clean);
  if (existsSync(inSite) && statSync(inSite).isFile()) return inSite;
  const relToApp = join(appDir, clean.replace(/^\/+/, ""));
  if (existsSync(relToApp) && statSync(relToApp).isFile()) return relToApp;
  return undefined;
}

function parseReviewCard(id, view, AnswerFns) {
  const children = view?.type === "stack" && Array.isArray(view.children) ? view.children : [];
  const heading = children.find((c) => c.type === "heading")?.text ?? "";
  const reasonNode = children.find((c) => c.type === "text" && /^Reason:\s|^No reason given\./.test(c.text ?? "")) ?? children.find((c) => c.type === "text");
  const rawReason = reasonNode?.text ?? "";
  const reason = rawReason === "No reason given." ? "" : rawReason.replace(/^Reason:\s*/, "");
  const diff = children.find((c) => c.type === "diff")?.lines ?? [];
  return {
    id,
    heading,
    reason,
    diff,
    view,
    ...AnswerFns,
  };
}

function normalizeDecision(decision) {
  if (decision === true || decision === "accept" || decision === "allow" || decision === "allowed-once") return "accept";
  if (decision === "always" || decision === "allowed-always") return "always";
  if (decision === false || decision === "decline" || decision === "reject" || decision === "rejected") return "decline";
  return undefined;
}

/**
 * Boots an app (`appDir`) against a fresh in-memory kernel and spawns its linked
 * plugins in `node:worker_threads`. No browser or network required.
 *
 * @param {string} [appDir] Folder containing `app.html` (or path to `app.html`). Defaults to `EXTENSIBLE_APP_DIR` or `process.cwd()`.
 * @param {{
 *   platform?: string,
 *   plugins?: Array<string | { href?: string, source: string, files?: Record<string, string> }>,
 *   files?: any,
 *   seed?: Record<string, string | Uint8Array>,
 *   fetch?: typeof globalThis.fetch,
 *   onReview?: string | boolean | ((review: any) => any),
 *   url?: string,
 * }} [options]
 */
export async function createTestHarness(appDir = process.env.EXTENSIBLE_APP_DIR || process.cwd(), options = {}) {
  const platform = resolve(options.platform ?? PLATFORM);
  const resolvedTarget = resolve(appDir);
  const pageFile = existsSync(resolvedTarget) && statSync(resolvedTarget).isFile() ? resolvedTarget : join(resolvedTarget, "app.html");
  const folder = dirname(pageFile);
  if (!existsSync(pageFile)) throw new Error(`No app.html found in ${relative(process.cwd(), folder) || folder}`);

  const isRootProject = existsSync(join(folder, "package.json")) && resolve(folder) !== platform;
  const ownKernel = isRootProject ? projectKernel(folder, { platform }) : undefined;

  const [kernelCode, runtimeCode] = await Promise.all([
    getKernelBundle(platform, ownKernel),
    getRuntimeBundle(platform),
  ]);
  await esbuild.stop();

  const relFromPlatform = relative(platform, folder).split("\\").join("/");
  const insidePlatform = !isRootProject && !relFromPlatform.startsWith("..") && relFromPlatform !== "";
  const appId = isRootProject ? "root" : insidePlatform ? relFromPlatform : "app";
  const basePath = isRootProject ? "/" : insidePlatform ? `/${relFromPlatform}/` : "/app/";
  const pageUrl = new URL(`${basePath}app.html`, TEST_ORIGIN);

  /** Extra virtual files registered via `options.plugins` or `addPlugin`. */
  const virtualFiles = new Map();

  function readSiteText(urlString) {
    const u = new URL(urlString, pageUrl);
    if (virtualFiles.has(u.pathname)) return virtualFiles.get(u.pathname);
    // Relative to app folder first when under basePath
    if (!isRootProject && u.pathname.startsWith(basePath)) {
      const sub = join(folder, u.pathname.slice(basePath.length));
      if (existsSync(sub) && statSync(sub).isFile()) return readFileSync(sub, "utf8");
    }
    const disk = resolveDiskFile(u.pathname, folder, isRootProject, platform);
    return disk ? readFileSync(disk, "utf8") : undefined;
  }

  // Parse linked plugins and agents from app.html.
  const pageHtml = readFileSync(pageFile, "utf8");
  const parsedLinks = parseAppLinks(pageHtml);
  const openPlugins = [];

  for (const link of parsedLinks) {
    const resolvedUrl = new URL(link.href, pageUrl);
    const source = readSiteText(resolvedUrl.href);
    if (!source) throw new Error(`Couldn't read linked ${link.kind} "${link.href}" from ${pageFile}`);
    if (link.kind === "agent") {
      const runnerMatch = /^runner:\s*(\S+)\s*$/m.exec(source);
      const runnerUrl = new URL(runnerMatch ? runnerMatch[1] : "/std/agents/runner.js", resolvedUrl);
      const runner = readSiteText(runnerUrl.href);
      if (!runner) throw new Error(`Couldn't read agent loop "${runnerUrl.pathname}" for "${link.href}"`);
      openPlugins.push({ href: resolvedUrl.href, source, runner });
    } else {
      openPlugins.push({ href: resolvedUrl.href, source });
    }
  }

  // Extra test plugins passed in `options.plugins`.
  let inlineCounter = 0;
  function normalizeExtraPlugin(spec) {
    if (typeof spec === "string") {
      const trimmed = spec.trim();
      const looksInline = trimmed.startsWith("export ") || trimmed.startsWith("//") || trimmed.startsWith("/*");
      if (!looksInline && existsSync(resolve(folder, spec))) {
        const disk = resolve(folder, spec);
        const href = new URL(relative(folder, disk).split("\\").join("/"), pageUrl).href;
        return { href, source: readFileSync(disk, "utf8") };
      }
      const href = new URL(`__inline-${++inlineCounter}.js`, pageUrl).href;
      return { href, source: spec };
    }
    const href = new URL(spec.href ?? `__inline-${++inlineCounter}.js`, pageUrl).href;
    if (spec.files) {
      for (const [name, content] of Object.entries(spec.files)) {
        virtualFiles.set(new URL(name, href).pathname, content);
      }
    }
    return { href, source: spec.source };
  }

  for (const extra of options.plugins ?? []) openPlugins.push(normalizeExtraPlugin(extra));

  // Track collection owners declared in linked manifests so collection helpers know the default owner.
  const collectionOwners = new Map();
  function noteManifestOwners(source) {
    const idMatch = /\bid\s*:\s*["']([a-z][a-z0-9-]*)["']/.exec(source);
    const collectionsIdx = source.indexOf("collections");
    if (!idMatch || collectionsIdx < 0) return;
    const owner = idMatch[1];
    const sub = source.slice(collectionsIdx);
    for (const m of sub.matchAll(/["']?([a-z][a-z0-9-]{0,40})["']?\s*:\s*\{\s*(?:title|schema)\b/g)) {
      if (!collectionOwners.has(m[1])) collectionOwners.set(m[1], owner);
    }
  }
  for (const p of openPlugins) noteManifestOwners(p.source);

  // Boot the kernel in-process.
  let acceptKernelPort;
  const kernelErrors = [];
  const bootState = {
    origin: TEST_ORIGIN,
    files: options.files,
    seed: options.seed,
    fetch: options.fetch,
    timers: new Set(),
    connect(accept) {
      acceptKernelPort = accept;
    },
    onError(name, detail) {
      kernelErrors.push({ name, detail });
    },
    exposedFiles: null,
  };
  globalThis.__ewaTestBoot = bootState;
  await import(`data:text/javascript;base64,${Buffer.from(`${kernelCode}\n//#boot=${++nextBootId}`).toString("base64")}`);

  const [hostPort, kernelSidePort] = createPortPair();
  acceptKernelPort(kernelSidePort);

  const tab = `test-${nextBootId}`;
  let releaseTabLock;
  const tabLockHeld = new Promise((r) => (releaseTabLock = r));
  let tabLockAcquired = Promise.resolve();
  if (globalThis.navigator?.locks?.request) {
    let markLocked;
    tabLockAcquired = new Promise((r) => (markLocked = r));
    void globalThis.navigator.locks.request(`ewa-tab-${tab}`, () => {
      markLocked();
      return tabLockHeld;
    });
  }
  await tabLockAcquired;
  let traceCounter = 0;
  const newTrace = () => `${tab}-${++traceCounter}`;
  let commandCounter = 0;
  let bindCounter = 0;
  let statusCounter = 0;
  let closed = false;

  const workers = new Map();
  const pluginPorts = new Map();
  const unackedEvents = new Set();
  const renderedSlots = new Map();
  const pendingReviews = new Map();
  const reviewHandlers = new Set();
  const commandWaiters = new Map();
  const bindListeners = new Map();
  const recordWaiters = new Map();
  let openedPlugins = [];
  let resolveWelcome;
  let resolveOpened;
  const welcomePromise = new Promise((r) => (resolveWelcome = r));
  let openedPromise = new Promise((r) => (resolveOpened = r));
  let currentUrl = (() => {
    const u = new URL(options.url ?? "/", TEST_ORIGIN);
    return { path: u.pathname, query: Object.fromEntries(u.searchParams) };
  })();

  const send = (msg) => hostPort.postMessage(msg);

  if (options.onReview !== undefined) {
    reviewHandlers.add(typeof options.onReview === "function" ? options.onReview : () => options.onReview);
  }

  function answerReview(id, verb) {
    if (!pendingReviews.has(id)) return;
    pendingReviews.delete(id);
    send({ t: "event", owner: "review", action: `${verb}:${id}`, trace: newTrace() });
  }

  let reviewTasksInFlight = 0;
  async function notifyReviewHandlers(card) {
    if (!reviewHandlers.size) return;
    reviewTasksInFlight++;
    try {
      for (const handler of [...reviewHandlers]) {
        if (!pendingReviews.has(card.id)) break;
        const decision = await handler(card);
        const verb = normalizeDecision(decision);
        if (verb && pendingReviews.has(card.id)) {
          answerReview(card.id, verb);
          break;
        }
      }
    } finally {
      reviewTasksInFlight--;
    }
  }

  function spawnPluginWorker(plugin, source, network) {
    const prev = workers.get(plugin);
    if (prev) void prev.terminate();
    pluginPorts.get(plugin)?.close();

    const workerUrl = new URL(`data:text/javascript;base64,${Buffer.from(runtimeCode).toString("base64")}`);
    const worker = new Worker(workerUrl, { name: plugin });
    worker.on("message", (m) => {
      if (m?.t === "__ack_event" && m.trace) unackedEvents.delete(m.trace);
    });
    worker.on("error", (err) => {
      kernelErrors.push({ name: `worker:${plugin}`, detail: err?.message ?? String(err) });
    });
    const { port1, port2 } = new MessageChannel();

    workers.set(plugin, worker);
    pluginPorts.set(plugin, port1);
    worker.postMessage({ t: "init", source, network, port: port2 }, [port2]);
    send({ t: "spawned", plugin, port: port1 });
  }

  async function answerBridge(service, method, args) {
    if (service === "host" && method === "workerCount") return workers.size;
    if (service === "page" && method === "matches") return [];
    if (service === "page" && method === "slots") return [];
    if (service === "router" && method === "go") {
      const target = new URL(String(args[0] ?? "/"), TEST_ORIGIN);
      currentUrl = { path: target.pathname, query: Object.fromEntries(target.searchParams) };
      send({ t: "url", ...currentUrl });
      return true;
    }
    return null;
  }

  hostPort.onmessage = (ev) => {
    const message = ev.data;
    switch (message.t) {
      case "welcome":
        resolveWelcome?.();
        return;
      case "spawn":
        spawnPluginWorker(message.plugin, message.source, message.network);
        return;
      case "terminate": {
        const w = workers.get(message.plugin);
        workers.delete(message.plugin);
        pluginPorts.get(message.plugin)?.close();
        pluginPorts.delete(message.plugin);
        if (w) void w.terminate();
        return;
      }
      case "opened":
        openedPlugins = message.plugins ?? [];
        resolveOpened?.(openedPlugins);
        return;
      case "render": {
        const isReview = message.owner === "review";
        const isSecrets = message.owner === "secrets";
        const targetSlot = isReview || isSecrets ? "#review" : message.slot;
        const slotMap = renderedSlots.get(targetSlot) ?? new Map();
        renderedSlots.set(targetSlot, slotMap);

        if (message.view) {
          slotMap.set(message.key, {
            slot: targetSlot,
            key: message.key,
            owner: message.owner,
            order: message.order ?? 1000,
            view: message.view,
          });
          if (isReview && message.key.startsWith("review:")) {
            const reviewId = message.key.slice("review:".length);
            const card = parseReviewCard(reviewId, message.view, {
              accept: () => answerReview(reviewId, "accept"),
              always: () => answerReview(reviewId, "always"),
              decline: () => answerReview(reviewId, "decline"),
            });
            pendingReviews.set(reviewId, card);
            void notifyReviewHandlers(card);
          }
        } else {
          slotMap.delete(message.key);
          if (isReview && message.key.startsWith("review:")) {
            pendingReviews.delete(message.key.slice("review:".length));
          }
        }
        return;
      }
      case "command:result": {
        const done = commandWaiters.get(message.id);
        commandWaiters.delete(message.id);
        done?.(message.value);
        return;
      }
      case "bound":
        bindListeners.get(message.id)?.(message);
        return;
      case "record:result": {
        const done = recordWaiters.get(message.id);
        recordWaiters.delete(message.id);
        done?.(message);
        return;
      }
      case "bridge":
        void answerBridge(message.service, message.method, message.args).then(
          (value) => send({ t: "bridge:result", id: message.id, ok: true, value }),
          (err) => send({ t: "bridge:result", id: message.id, ok: false, error: err?.message ?? String(err) }),
        );
        return;
    }
  };

  async function queryWorkerBusy(worker) {
    const id = ++statusCounter;
    return new Promise((resolveBusy) => {
      const timer = setTimeout(() => {
        worker.off("message", onMsg);
        resolveBusy(0);
      }, 250);
      const onMsg = (m) => {
        if (m?.t !== "__status" || m.id !== id) return;
        clearTimeout(timer);
        worker.off("message", onMsg);
        resolveBusy(m.busy ?? 0);
      };
      worker.on("message", onMsg);
      worker.postMessage({ t: "__status", id });
    });
  }

  function dispatchPluginEvent(owner, action, value) {
    const trace = newTrace();
    const base = owner.split("@")[0];
    const hasLiveWorker = workers.has(owner) || workers.has(`${base}@${tab}`) || workers.has(base);
    if (hasLiveWorker) unackedEvents.add(trace);
    send({ t: "event", owner, action, value, trace });
  }

  /** Waits until all plugin workers and live view updates reach quiescence (or wait on an unanswered review card). */
  async function settle({ timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let quietPasses = 0;
    while (Date.now() < deadline && !closed) {
      await new Promise((r) => setImmediate(r));
      const activeWorkers = [...workers.values()];
      const counts = await Promise.all(activeWorkers.map(queryWorkerBusy));
      const totalBusy = counts.reduce((a, b) => a + b, 0) + reviewTasksInFlight + unackedEvents.size;
      // If a review card is waiting with no handler answering it, 1 call per waiting review is expected to stay parked.
      const parkedOnReview = reviewTasksInFlight === 0 && unackedEvents.size === 0 ? pendingReviews.size : 0;
      if (totalBusy <= parkedOnReview) {
        if (++quietPasses >= 2) return;
      } else {
        quietPasses = 0;
      }
    }
  }

  function kernelCommand(name, arg) {
    const id = ++commandCounter;
    return new Promise((resolveCmd) => {
      commandWaiters.set(id, resolveCmd);
      send({ t: "command", id, name, arg });
    });
  }

  // Connect and open the app!
  send({ t: "hello", tab });
  await welcomePromise;
  send({ t: "open", plugins: openPlugins, app: appId });
  send({ t: "url", ...currentUrl });
  await openedPromise;
  await settle();

  // Internal helper for calling kernel services from a lightweight driver plugin inside the app when needed
  // (e.g. `commands.run("<plugin>/<id>")` or cross-plugin `data.put(..., reason)`).
  const installedDrivers = new Set();
  let driverCallId = 0;

  async function ensureDriver(driverId, permissions, services = []) {
    const key = `${driverId}::${[...permissions].sort().join(",")}`;
    if (installedDrivers.has(key)) return driverId;
    const code = `export const manifest = {
  id: ${JSON.stringify(driverId)},
  name: ${JSON.stringify(driverId)},
  permissions: ${JSON.stringify(permissions)},
  ${services.length ? `services: ${JSON.stringify(services)},` : ""}
};
export default (ctx) => {
  ctx.ui.onEvent(async (action, payload) => {
    if (action !== "__driver_call") return;
    const { callId, service, method, args } = payload;
    try {
      const value = await ctx.call(service, method, ...args);
      await ctx.storage.set("reply:" + callId, { ok: true, value });
    } catch (err) {
      await ctx.storage.set("reply:" + callId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};`;
    openedPromise = new Promise((r) => (resolveOpened = r));
    const added = await kernelCommand("user:add", { app: appId, files: [{ name: `${driverId}.js`, data: code }] });
    if (added?.ok === false) throw new Error(added.error);
    const turnedOn = await kernelCommand("user:on", { app: appId, id: driverId });
    if (turnedOn?.ok === false) throw new Error(turnedOn.error);
    await openedPromise;
    await settle();
    installedDrivers.add(key);
    return driverId;
  }

  async function callViaDriver(driverId, permissions, services, service, method, args) {
    await ensureDriver(driverId, permissions, services);
    const callId = `${++driverCallId}`;
    dispatchPluginEvent(driverId, "__driver_call", { callId, service, method, args });
    await settle();
    // Read reply from memoryFiles (`plugin-data/<driverId>.json`)
    const raw = await bootState.exposedFiles.readText(`plugin-data/${driverId}.json`);
    const storeObj = raw ? JSON.parse(raw) : {};
    const reply = storeObj[`reply:${callId}`];
    if (!reply) throw new Error(`${service}.${method} did not complete (is a review card still waiting for an answer?)`);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }

  async function ownerForCollection(collection) {
    if (collectionOwners.has(collection)) return collectionOwners.get(collection);
    // Try each opened plugin to find one that can bind to this collection
    for (const p of openedPlugins) {
      if (!p.id || p.error) continue;
      const probe = await bindOnce(p.id, collection);
      if (!probe.error) {
        if (probe.writable) collectionOwners.set(collection, p.id);
        return p.id;
      }
    }
    return openedPlugins.find((p) => p.id && !p.error)?.id ?? "app";
  }

  function bindOnce(owner, collection) {
    const id = `b${++bindCounter}`;
    return new Promise((resolveBind) => {
      bindListeners.set(id, (msg) => {
        bindListeners.delete(id);
        send({ t: "unbind", id });
        resolveBind(msg);
      });
      send({ t: "bind", id, owner, collection });
    });
  }

  function saveViaBinding(owner, collection, recordId, fields) {
    const id = `r${++bindCounter}`;
    return new Promise((resolveSave) => {
      recordWaiters.set(id, resolveSave);
      send({ t: "record", id, owner, collection, recordId, fields, trace: newTrace() });
    });
  }

  function formatEntry(entry) {
    const plugin = entry.owner.split("@")[0];
    const colon = entry.key.indexOf(":");
    const shortKey = colon >= 0 ? entry.key.slice(colon + 1) : entry.key;
    const html = renderViewToHtml(entry.view, readSiteText);
    return {
      slot: entry.slot,
      key: entry.key,
      shortKey,
      plugin,
      owner: entry.owner,
      order: entry.order,
      view: entry.view,
      data: entry.view?.type === "template" ? entry.view.data : undefined,
      html,
      text: stripTags(html),
    };
  }

  const harness = {
    /** Metadata for each plugin opened by the app. */
    get plugins() {
      return openedPlugins.slice();
    },

    /** Underlying in-memory `files` seam (`src/seams/memory.ts`). */
    get files() {
      return bootState.exposedFiles;
    },

    /** Errors reported by the kernel itself, if any. */
    get errors() {
      return kernelErrors.slice();
    },

    /**
     * Rendered views in `slot` (sorted by `order`), or across all slots (excluding `#review`) when `slot` is omitted.
     * Each entry has `{ slot, key, shortKey, plugin, owner, order, view, data, html, text }`.
     */
    views(slot) {
      if (slot !== undefined) {
        const entries = [...(renderedSlots.get(slot)?.values() ?? [])].sort((a, b) => a.order - b.order);
        return entries.map(formatEntry);
      }
      const all = [];
      for (const [name, map] of renderedSlots) {
        if (name === "#review") continue;
        const sorted = [...map.values()].sort((a, b) => a.order - b.order);
        for (const e of sorted) all.push(formatEntry(e));
      }
      return all;
    },

    /** First rendered view in `slot` (or matching `key` / `shortKey`), or `undefined`. */
    view(slot, key) {
      const list = harness.views(slot);
      if (key === undefined) return list[0];
      return list.find((v) => v.key === key || v.shortKey === key);
    },

    /** Concatenated HTML rendered in `slot`. */
    html(slot = "main") {
      return harness.views(slot).map((v) => v.html).join("\n");
    },

    /** Sends a UI action event to `pluginId` (just as clicking/changing `[data-action]` does) and waits to settle. */
    async act(pluginId, action, value) {
      dispatchPluginEvent(pluginId, action, value);
      await settle();
    },

    /**
     * Runs either a plugin command (`"<plugin>/<id>"`, via the `commands` service) or a kernel page
     * command (`"trace"`, `"changes"`, `"modules"`, `"route"`, etc.), and waits for effects to settle.
     */
    async command(name, arg) {
      if (name.includes("/") && !name.startsWith("user:") && !name.startsWith("place:")) {
        const args = arg === undefined ? [] : [arg];
        const value = await callViaDriver("test-cmd-driver", ["commands"], ["commands"], "commands", "run", [name, ...args]);
        await settle();
        return value;
      }
      const value = await kernelCommand(name, arg);
      await settle();
      return value;
    },

    /** Lists the app's commands registered with `ctx.commands.add`. */
    async commands() {
      return callViaDriver("test-cmd-driver", ["commands"], ["commands"], "commands", "list", []);
    },

    /** Lists all records in `collection`, most recently updated first. */
    async list(collection) {
      const owner = await ownerForCollection(collection);
      const bound = await bindOnce(owner, collection);
      if (bound.error) throw new Error(bound.error);
      return JSON.parse(JSON.stringify(bound.records ?? []));
    },

    /** Alias for `list(collection)`. */
    records(collection) {
      return harness.list(collection);
    },

    /** Reads a single record by `id` from `collection`, or `null`. */
    async get(collection, id) {
      const records = await harness.list(collection);
      return records.find((r) => r.id === id) ?? null;
    },

    /**
     * Creates or updates a record in `collection`.
     * Without `options.as`, writes as the collection's owner (like `<ui-form collection="…">`).
     * With `options.as` naming another plugin, executes `data.put` as that plugin so capability checks and review cards run.
     */
    async put(collection, fields, putOptions = {}) {
      const defaultOwner = await ownerForCollection(collection);
      const actor = putOptions.as ?? putOptions.plugin;
      if (actor && actor !== defaultOwner) {
        const running = openedPlugins.some((p) => p.id === actor && !p.error);
        if (running && putOptions.reason === undefined) {
          const saved = await saveViaBinding(actor, collection, fields?.id, fields);
          await settle();
          if (!saved.ok) throw new Error(saved.error ?? saved.errors?.map((e) => e.message).join("; ") ?? "Write failed");
          return { ok: true, id: saved.recordId };
        }
        const perms = putOptions.permissions ?? [`data:read:${collection}`, `data:write:${collection}`];
        const result = await callViaDriver(actor, perms, [], "data", "put", [collection, fields, ...(putOptions.reason !== undefined ? [putOptions.reason] : [])]);
        await settle();
        return result;
      }
      const saved = await saveViaBinding(defaultOwner, collection, fields?.id, fields);
      await settle();
      if (!saved.ok) {
        if (saved.errors) return { ok: false, id: saved.recordId, errors: saved.errors };
        throw new Error(saved.error ?? "Write failed");
      }
      return { ok: true, id: saved.recordId };
    },

    /** Deletes a record from `collection` (optionally `{ as, reason }` for a cross-plugin reviewed delete). */
    async delete(collection, id, delOptions = {}) {
      const defaultOwner = await ownerForCollection(collection);
      const actor = delOptions.as ?? delOptions.plugin;
      if (actor && actor !== defaultOwner) {
        const perms = delOptions.permissions ?? [`data:read:${collection}`, `data:write:${collection}`];
        const result = await callViaDriver(actor, perms, [], "data", "delete", [collection, id, ...(delOptions.reason !== undefined ? [delOptions.reason] : [])]);
        await settle();
        return result;
      }
      const res = await saveViaBinding(defaultOwner, collection, id, null);
      await settle();
      if (!res.ok) throw new Error(res.error ?? "Delete failed");
      return { ok: true, id };
    },

    /** Convenience wrapper bound to a single collection name. */
    collection(name) {
      return {
        list: () => harness.list(name),
        get: (id) => harness.get(name, id),
        put: (fields, opts) => harness.put(name, fields, opts),
        delete: (id, opts) => harness.delete(name, id, opts),
      };
    },

    /** Currently open review cards waiting for an answer. */
    reviews() {
      return [...pendingReviews.values()];
    },

    /**
     * Registers a review handler `(review) => "accept" | "always" | "decline" | boolean`
     * (or passes a decision value directly). Answers any open review cards immediately. Returns `off()`.
     */
    onReview(handlerOrDecision) {
      const fn = typeof handlerOrDecision === "function" ? handlerOrDecision : () => handlerOrDecision;
      reviewHandlers.add(fn);
      for (const card of [...pendingReviews.values()]) void notifyReviewHandlers(card);
      return () => void reviewHandlers.delete(fn);
    },

    /** Installs and turns on a user plugin in this app at run time, waiting for views to settle. */
    async addPlugin(source, { name, files = {} } = {}) {
      const idMatch = /\bid\s*:\s*["']([a-z][a-z0-9-]*)["']/.exec(source);
      const id = idMatch?.[1] ?? `plugin-${++inlineCounter}`;
      const fileList = [
        { name: name ?? `${id}.js`, data: source },
        ...Object.entries(files).map(([k, v]) => ({ name: k, data: v })),
      ];
      noteManifestOwners(source);
      openedPromise = new Promise((r) => (resolveOpened = r));
      const added = await kernelCommand("user:add", { app: appId, files: fileList });
      if (added?.ok === false) throw new Error(added.error);
      const on = await kernelCommand("user:on", { app: appId, id });
      if (on?.ok === false) throw new Error(on.error);
      await openedPromise;
      await settle();
      return id;
    },

    /** Navigates the simulated tab to `path` (e.g. `"/book/42?tab=notes"`), notifying router listeners. */
    async navigate(urlPath) {
      const u = new URL(urlPath, TEST_ORIGIN);
      currentUrl = { path: u.pathname, query: Object.fromEntries(u.searchParams) };
      send({ t: "url", ...currentUrl });
      await settle();
    },

    /** Recent kernel trace events. */
    traces() {
      return kernelCommand("trace");
    },

    /** Kernel change log entries (reviewed writes and grants). */
    changes() {
      return kernelCommand("changes");
    },

    /** Waits for in-flight plugin work and live views to settle. */
    settle,

    /** Stops the app tab and terminates all plugin worker threads. */
    async close() {
      if (closed) return;
      closed = true;
      reviewHandlers.clear();
      pendingReviews.clear();
      unackedEvents.clear();
      send({ t: "bye", tab });
      await new Promise((r) => setImmediate(r));
      releaseTabLock?.();
      hostPort.close();
      kernelSidePort.close();
      for (const p of pluginPorts.values()) p.close();
      pluginPorts.clear();
      for (const t of bootState.timers) clearTimeout(t);
      bootState.timers.clear();
      const toStop = [...workers.values()];
      workers.clear();
      await Promise.all(toStop.map((w) => w.terminate()));
    },

    [Symbol.asyncDispose]() {
      return harness.close();
    },
  };

  return harness;
}

/** Discovers `*.test.mjs` and `*.test.js` files inside `dir` (skipping `node_modules` and dotfiles). */
export function findTestFiles(dir) {
  const found = [];
  const walk = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.m?js$/.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Runs `checkApps` static validation on `project` and executes its `*.test.mjs` / `*.test.js` files
 * with Node's built-in test runner (`node --test`).
 */
export async function runAppTests(project, { files = [], platform = PLATFORM, json = false, quiet = false } = {}) {
  process.argv[1] ??= THIS_FILE;
  const [{ checkApps }, { writeProjectTypes }] = await Promise.all([import("./check.mjs"), import("./types.mjs")]);
  const folder = resolve(project);
  if (existsSync(join(folder, "package.json")) && folder !== resolve(platform)) {
    writeProjectTypes(folder, { platform });
  }

  const isOwnProject = existsSync(join(folder, "package.json")) && folder !== resolve(platform);
  const [checked] = await checkApps([folder], isOwnProject ? { root: folder } : {});
  const named = (file) => (file ? relative(folder, resolve(platform, file)).split("\\").join("/") : file);
  const problems = checked.problems.map((p) => ({ ...p, file: named(p.file) }));
  const checkFailed = problems.some((p) => p.level === "error");

  if (!json && !quiet) {
    console.log(`${problems.length ? "✗" : "✓"} app.html${checked.plugins.length ? ` (${checked.plugins.join(", ")})` : ""}`);
    for (const p of problems) console.log(`    ${p.level.padEnd(7)} ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
  }

  if (checkFailed) {
    if (json && !quiet) console.log(JSON.stringify({ ok: false, check: { ok: false, problems }, tests: { ran: 0, ok: false } }, null, 2));
    return { ok: false, check: { ok: false, plugins: checked.plugins, problems }, tests: { ran: 0, ok: false, output: "" } };
  }

  const targets = files.length ? files.map((f) => resolve(folder, f)) : findTestFiles(folder);
  if (!targets.length) {
    if (json && !quiet) console.log(JSON.stringify({ ok: true, check: { ok: true, problems }, tests: { ran: 0, ok: true } }, null, 2));
    return { ok: true, check: { ok: true, plugins: checked.plugins, problems }, tests: { ran: 0, ok: true, output: "" } };
  }

  // Loader hook so `import { createTestHarness } from "extensible-web-apps/test"` works everywhere,
  // even in `--no-install` scratch folders.
  const testEntryUrl = pathToFileURL(THIS_FILE).href;
  const loaderSource = `import { registerHooks } from "node:module";
const target = ${JSON.stringify(testEntryUrl)};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "extensible-web-apps" || specifier === "extensible-web-apps/test") {
      return { url: target, shortCircuit: true };
    }
    return next(specifier, context);
  },
});`;
  const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource).toString("base64")}`;

  const run = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", loaderUrl, "--test", ...(json || quiet ? ["--test-reporter=tap"] : ["--test-reporter=spec"]), ...targets],
    {
      cwd: folder,
      encoding: "utf8",
      stdio: json || quiet ? "pipe" : "inherit",
      env: { ...process.env, EXTENSIBLE_APP_DIR: folder },
    },
  );
  const testsOk = run.status === 0;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (json && !quiet) {
    console.log(JSON.stringify({ ok: testsOk, check: { ok: true, problems }, tests: { ran: targets.length, ok: testsOk, output } }, null, 2));
  }
  return { ok: testsOk, check: { ok: true, plugins: checked.plugins, problems }, tests: { ran: targets.length, ok: testsOk, output } };
}
