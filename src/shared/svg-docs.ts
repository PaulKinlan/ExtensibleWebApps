// What each SVG element on the list (svg.ts) is for, for the API reference
// and the app maker's checks. Kept apart from the list itself so the page's
// host, which only needs the names, doesn't carry the prose.

import { SVG_TAGS } from "./svg";

const ABOUT: Record<string, string> = {
  svg: "The drawing; give it a viewBox, and role=\"img\" with aria-label (or a <title>) when it means something",
  textPath: "Text along a path: href=\"#<path id>\"",
  use: "A copy of something in this view: href=\"#<id>\"",
  linearGradient: "Gradients, used as fill=\"url(#<id>)\"",
  g: "A group, to move, style or label shapes together",
  path: "Shapes: path (d=), rect, circle, ellipse, line, polyline and polygon (points=)",
  text: "Text, and runs of it",
  title: "What it shows, for screen readers and as a tooltip",
  defs: "Things used by reference: gradients, clips, masks, markers, patterns, symbols, filters",
  filter: "Simple filters: blur, offset, shadow, colour matrix, flood, blend, composite and merge",
};

/** SVG elements, and what each is for. */
export const SVG_ELEMENTS: Record<string, string> = Object.fromEntries(SVG_TAGS.map((tag) => [tag, ABOUT[tag] ?? ""]));
