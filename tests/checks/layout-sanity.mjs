// What a person would call "it looks broken", caught before they see it. Every
// app and site page is opened at a desktop and a phone width, and fails when:
//   - a one-line field, select or button is taller than a few lines of text
//     (the account page once drew each field 12rem tall);
//   - the page scrolls sideways;
//   - two controls in the same view are drawn over each other;
//   - a control is drawn but squeezed to nothing;
//   - a long word in a view (an address, a file path) pushes the page wider than
//     the window (the Markdown editor's side panels once ran off the screen).
// The rules are DESIGN.md's, measured: see "What the layout check holds every page to".
// A page that must break one says so in ALLOWED below, with the reason.
import { readdirSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

export const SIZES = { desktop: { width: 1280, height: 800 }, wide: { width: 1680, height: 1000 }, phone: { width: 390, height: 844 } };
export const TALLEST_CONTROL = 64;

// [what the line "<page> <size>: <finding>" matches, why it is allowed]. Keep it short; fix the page instead where you can.
const ALLOWED = [
  [/^\/demos\/glowfall\/app\.html \w+: button "Jar /, "the game's steering pads are big on purpose, for thumbs"],
];

// Runs in the page. Returns what looks broken, as short sentences.
export function measure(tallest) {
  const found = [];
  const shown = (el) => {
    if (!el.checkVisibility?.({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    // Hidden by clipping (visually-hidden labels and the like) isn't drawn.
    for (let p = el; p && p !== document.documentElement; p = p.parentElement ?? p.getRootNode().host) {
      const s = getComputedStyle(p);
      if (s.clipPath !== "none" && r.width <= 2) return false;
    }
    return true;
  };
  const name = (el) => {
    const text = (el.getAttribute("aria-label") || el.name || el.placeholder || el.textContent || el.id || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `${el.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
  };
  // Every element, through open shadow roots (the ui-* elements keep theirs open).
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const oneLine = (el) =>
    (el.tagName === "INPUT" && !["checkbox", "radio", "range", "color", "file", "hidden", "image"].includes(el.type)) ||
    (el.tagName === "SELECT" && !el.multiple && !(el.size > 1)) ||
    ((el.tagName === "BUTTON" || (el.tagName === "A" && el.classList.contains("button"))) && !el.querySelector("img, svg, canvas, br, div, p, small") && !/\n/.test(el.innerText ?? ""));
  const controls = all.filter((el) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName) || (el.tagName === "A" && el.classList.contains("button"))).filter((el) => el.type !== "hidden" && shown(el));

  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (oneLine(el) && r.height > tallest) found.push(`${name(el)} is ${Math.round(r.height)}px tall, more than ${tallest}px for a one-line control`);
    if (r.width < 8 || r.height < 8) found.push(`${name(el)} is squeezed to ${Math.round(r.width)}x${Math.round(r.height)}px`);
  }

  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    // Name what sticks out, to make the failure fixable from its line.
    const wide = all.filter((el) => shown(el) && el.getBoundingClientRect().right > doc.clientWidth + 1 && getComputedStyle(el).position !== "fixed")
      .filter((el, _, list) => !list.some((other) => other !== el && el.contains(other)));
    found.push(`the page scrolls sideways (${doc.scrollWidth}px wide in a ${doc.clientWidth}px window): ${wide.slice(0, 3).map(name).join(", ") || "something"} sticks out`);
  }

  // Controls drawn over each other, inside one view. Fixed and sticky chrome floats over the page on purpose.
  const floats = (el) => { for (let p = el; p && p.nodeType === 1; p = p.parentElement ?? p.getRootNode().host) { const pos = getComputedStyle(p).position; if (pos === "fixed" || pos === "sticky" || pos === "absolute") return true; } return false; };
  const view = (el) => { for (let p = el; p; p = p.parentElement ?? p.getRootNode().host) if (p.nodeType === 1 && p.hasAttribute("data-plugin")) return p; return null; };
  const flat = controls.filter((el) => !floats(el)).map((el) => ({ el, r: el.getBoundingClientRect(), v: view(el) }));
  const over = [];
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const a = flat[i], b = flat[j];
    if (a.v !== b.v || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 3 && h > 3) over.push(`${name(a.el)} and ${name(b.el)} are drawn over each other`);
  }
  found.push(...over.slice(0, 3));
  return found;
}

// Runs in the page, after measure. Puts a long unbroken word in the first few bits of text of every view, the way
// real content does sooner or later, and says which views then stick out of the window.
export function stretch() {
  const long = `https://example.com/${"averyveryverylongunbrokenword".repeat(8)}`;
  for (const view of document.querySelectorAll("[data-plugin]")) {
    const leaves = [...view.querySelectorAll("p, li, span, strong, td, h2, h3, small, a")].filter((el) => !el.children.length && el.textContent.trim() && el.checkVisibility());
    for (const el of leaves.slice(0, 4)) el.textContent = long;
  }
  const doc = document.documentElement;
  if (doc.scrollWidth <= doc.clientWidth + 1) return [];
  const wide = [...document.querySelectorAll("[data-plugin]")].filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1 && getComputedStyle(el).position !== "fixed").map((el) => el.dataset.key || el.dataset.plugin);
  return [`a long word in a view pushes the page to ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window (${wide.slice(0, 4).join(", ") || "outside any view"})`];
}

export default async function ({ check, context, URL, errors }) {
  const demos = new globalThis.URL("../../demos/", import.meta.url);
  const apps = readdirSync(demos, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(new globalThis.URL(`${e.name}/app.html`, demos))).map((e) => `demos/${e.name}/app.html`);
  const pages = ["", "demos/", "docs/", "packages/", "new/", "workbench/", "account/", ...apps];
  const broken = [];
  const look = async (page, label, size) => {
    const findings = await page.evaluate(measure, TALLEST_CONTROL).catch((e) => [`couldn't be measured: ${e.message}`]);
    if (!findings.some((f) => f.includes("scrolls sideways"))) findings.push(...(await page.evaluate(stretch).catch(() => [])));
    for (const finding of findings) {
      const line = `${label} ${size}: ${finding}`;
      if (!ALLOWED.some(([allowed]) => allowed.test(line))) broken.push(line);
    }
  };
  const settle = (page) => page.waitForFunction(() => document.readyState === "complete" && !document.querySelector("slot .fallback:not([hidden])"), null, { timeout: 6000 }).catch(() => {}).then(() => page.waitForTimeout(400));

  for (const [size, viewport] of Object.entries(SIZES)) {
    const own = await context.browser().newContext({ viewport });
    const page = await own.newPage();
    for (const path of pages) {
      await page.goto(`${URL}${path}`, { waitUntil: "load" }).catch(() => {});
      await settle(page);
      await look(page, `/${path}`, size);
    }
    await own.close();
  }

  // The account page signed in, with a space: most of it only draws then, and it needs the site's server.
  const spaces = await mkdtemp(join(tmpdir(), "layout-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  try {
    for (const [size, viewport] of Object.entries(SIZES)) {
      const own = await context.browser().newContext({ viewport });
      const page = await own.newPage();
      page.on("pageerror", (e) => errors.push(`layout-sanity: ${e.message}`));
      const cdp = await own.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      await page.goto(`${server.url}/account/`);
      await page.fill('form[data-action="register"] input[name="name"]', "Ada");
      await page.click('form[data-action="register"] button[type="submit"]');
      await page.waitForSelector(".signed-in", { timeout: 8000 });
      await page.fill('form[data-action="make"] input[name="name"]', `layout-${size}`);
      await page.click('form[data-action="make"] button[type="submit"]');
      await page.waitForSelector(".space-list strong", { timeout: 8000 });
      await page.waitForSelector(".keys form", { timeout: 8000 }).catch(() => {});
      await look(page, "/account/ signed in", size);
      await own.close();
    }
  } catch (error) {
    broken.push(`/account/ signed in: couldn't be opened: ${String(error?.message ?? error).split("\n")[0]}`);
  } finally {
    await server.stop();
  }

  check(`no page looks broken at desktop, wide or phone width (${pages.length + 1} pages: one-line controls under ${TALLEST_CONTROL}px, no sideways scroll even with long words, no controls drawn over each other)`, !broken.length, broken.slice(0, 12).join(" | ") + (broken.length > 12 ? ` | and ${broken.length - 12} more` : ""));
}
