// /platform/drawing.js: the fixed address the SVG and canvas code had before it was
// named for its content. A page opened before a deploy, or a host.js the service
// worker kept from one, still asks for it here; a host from this build loads
// ./drawing itself (drawing-gate.ts) and never does.
export * from "./drawing";
