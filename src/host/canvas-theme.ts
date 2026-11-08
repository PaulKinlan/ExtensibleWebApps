// The theme, for canvases. A plugin draws on its canvas in a worker, where it
// can't read CSS: no tokens, no colour scheme. So the host reads them here,
// as the page shows them now (the platform's tokens, after any theme plugin
// and the page's own styles), and sends them with each canvas. It sends them
// again when they change: the colour scheme flips, or a theme is turned on,
// off or edited.
//
//   ctx.ui.onCanvas("chart", (canvas, theme) => draw(canvas, theme));
//   ctx.ui.onTheme((theme) => redraw(theme));
//
// Colours come resolved, as computed colour strings a 2D context takes:
// light-dark(), color-mix() and var() are already worked out.

import type { CanvasTheme } from "../shared/protocol";

/** The platform's colour tokens (src/host/styles.css), the ones a drawing is likely to want. */
const COLOURS = ["fg", "fg-2", "bg", "bg-2", "surface", "border", "accent", "accent-fg", "danger", "ok", "warn"] as const;

/** The theme as the page shows it now. */
export function canvasTheme(): CanvasTheme {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  const colors: Record<string, string> = {};
  for (const name of COLOURS) {
    probe.style.color = `var(--${name})`;
    colors[name] = getComputedStyle(probe).color;
  }
  probe.style.fontFamily = "var(--font)";
  const font = getComputedStyle(probe).fontFamily;
  probe.remove();
  // Light or dark by what the page shows, not what the device prefers: a theme may pin either.
  return { scheme: lightness(colors.bg) < 0.5 ? "dark" : "light", colors, font };
}

/** How light a colour is, 0 to 1, in whatever syntax the page gave it (rgb(), oklch()…): it is drawn and read back. */
function lightness(colour: string): number {
  const g = new OffscreenCanvas(1, 1).getContext("2d");
  if (!g) return 1;
  g.fillStyle = colour;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return (0.2126 * r + 0.7152 * gr + 0.0722 * b) / 255;
}

/** Calls `changed` with the new theme whenever what canvasTheme() reads changes. */
export function watchCanvasTheme(changed: (theme: CanvasTheme) => void): void {
  let last = JSON.stringify(canvasTheme());
  let pending = false;
  const check = () => {
    if (pending) return;
    pending = true;
    // After the change has been styled: a new <style> or a flipped scheme lands before the next frame.
    requestAnimationFrame(() => {
      pending = false;
      const theme = canvasTheme();
      const now = JSON.stringify(theme);
      if (now === last) return;
      last = now;
      changed(theme);
    });
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", check);
  // Themes are <style> and <link> elements in <head> (plugin themes, the page's own), with their href or media
  // changed too, and a class or style on <html> or <body>. The body is watched for its own attributes only, so
  // the probe canvasTheme() adds and takes away doesn't set it off again.
  new MutationObserver(check).observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
  new MutationObserver(check).observe(document.documentElement, { attributes: true });
  new MutationObserver(check).observe(document.body, { attributes: true });
  // A stylesheet that is added may finish loading after the check its adding set off.
  document.addEventListener("load", (event) => event.target instanceof HTMLLinkElement && check(), true);
}
