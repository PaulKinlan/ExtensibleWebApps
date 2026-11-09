// What a plugin may draw in an <svg> inside an HTML view or template. Like
// html.ts, it is a list the sanitiser enforces (src/host/sanitize-svg.ts) and
// the API reference prints. Shapes, text, gradients, clips, masks, markers
// and simple filters are in; anything that runs or loads is out: no
// <script>, <foreignObject>, <image>, <a>, <style>, no animation elements
// (they can rewrite attributes), no feImage, and no address but a #fragment
// inside the same view.

/** SVG elements a view may hold, by their name as written in SVG (case matters: linearGradient). */
export const SVG_TAGS = ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "title", "desc", "defs", "symbol", "use", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "filter", "feGaussianBlur", "feOffset", "feDropShadow", "feColorMatrix", "feFlood", "feBlend", "feComposite", "feMerge", "feMergeNode"];


/**
 * Attributes allowed on every SVG element, besides `aria-*`, `data-*`, `class`, `id` and the global ones in
 * html.ts. Presentation attributes may name a gradient, clip, mask, marker or filter only as `url(#id)`, an
 * id in the same view.
 */
export const SVG_ATTRIBUTES = [
  // Where and how big
  "viewBox", "preserveAspectRatio", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr",
  "d", "points", "pathLength", "transform", "dx", "dy", "rotate", "textLength", "lengthAdjust", "startOffset", "side", "method", "spacing",
  // Paint
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "opacity", "color", "paint-order", "vector-effect", "shape-rendering", "visibility", "display",
  "clip-path", "clip-rule", "mask", "filter", "marker-start", "marker-mid", "marker-end", "overflow",
  // Text
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "alignment-baseline", "letter-spacing", "word-spacing", "text-decoration",
  // Gradients, patterns, clips, masks, markers, symbols
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform",
  "clipPathUnits", "maskUnits", "maskContentUnits", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  // Filters
  "filterUnits", "primitiveUnits", "in", "in2", "result", "stdDeviation", "edgeMode", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4",
  "flood-color", "flood-opacity", "color-interpolation-filters",
  // References inside the view (use, textPath)
  "href", "focusable",
];

/** Attributes that may hold `url(#id)`: a gradient, clip, mask, marker or filter in the same view. */
export const SVG_URL_ATTRIBUTES = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]);

/** The attributes of a <canvas> in a view. */
export const CANVAS_ATTRIBUTES = ["id", "width", "height", "pointer"];

/** The largest canvas side, in pixels. */
export const CANVAS_MAX = 4096;
