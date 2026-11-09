// Trusted Types: the page's policy (public/_headers) has the browser refuse a
// plain string where HTML, a script or a script's address goes in, so only
// the policies named here and in that header can make one. A view a plugin
// sends never reaches the page as markup: sanitize.ts copies it, element by
// element, into the page, and that copy is what it parses through `platform`.
//
//   platform  the host's own: plugin views and template files to sanitize or
//             read, element files (elements.ts), the speculation rules
//             (speculation.ts), and script addresses on this site. Markup
//             loses its on…= attributes first (handlers.ts), so the browser
//             has no inline handler to report refusing.
//   default   what the browser asks when code hands a sink a plain string. It
//             takes script addresses on this site (Vite's `new Worker(new
//             URL(…))`, the kernel's shared worker, vendored libraries
//             loading their own files), and markup only when a library in
//             vendor/ hands it over (Mermaid builds its SVG with innerHTML,
//             after cleaning it with its own DOMPurify policy, `dompurify`).
//             Anything else's string is refused, and the page reports it.
//
// Elements that draw a library's output keep a policy of their own, named in
// the header (elements/mermaid.js).

import { withoutHandlers } from "./handlers";

type Policy = {
  createHTML(input: string): TrustedHTML;
  createScript(input: string): TrustedScript;
  createScriptURL(input: string): TrustedScriptURL;
};
type Factory = { createPolicy(name: string, rules: Partial<Record<keyof Policy, (input: string) => string | null>>): Policy };
declare global {
  interface TrustedHTML {}
  interface TrustedScript {}
  interface TrustedScriptURL {}
}

const factory = (globalThis as { trustedTypes?: Factory }).trustedTypes;

/** A script address on this site (or a blob: this page made), whole; anything else is refused. */
function onThisSite(input: string): string {
  const url = new URL(input, document.baseURI);
  const origin = url.protocol === "blob:" ? new URL(url.pathname).origin : url.origin;
  if (origin !== location.origin) throw new TypeError(`Scripts come only from this site, not ${url.origin}`);
  return url.href;
}

const identity: Policy = { createHTML: (s) => withoutHandlers(s) as unknown as TrustedHTML, createScript: (s) => s as unknown as TrustedScript, createScriptURL: (s) => onThisSite(s) as unknown as TrustedScriptURL };

/** The host's own policy. Where the browser has no Trusted Types, it passes strings through, checking addresses still. */
export const platform: Policy = factory?.createPolicy("platform", { createHTML: withoutHandlers, createScript: (s) => s, createScriptURL: onThisSite }) ?? identity;

/** Whether the code handing over markup is a library vendored on this site (vendor/), by the call's stack. */
function fromVendor(): boolean {
  const vendor = `${location.origin}/vendor/`;
  const frames = (new Error().stack ?? "").split("\n").filter((line) => line.includes("://"));
  return frames.some((line) => line.includes(vendor));
}

if (factory) {
  try {
    factory.createPolicy("default", { createScriptURL: onThisSite, createHTML: (s) => (fromVendor() ? s : null) });
  } catch {
    // A page made its own default policy first: it keeps it.
  }
}

/** Markup the host is about to parse into an inert template or document, as the policy wants it. */
export const html = (s: string): string => platform.createHTML(s) as unknown as string;
/** A script's text the host writes itself (speculation rules). */
export const script = (s: string): string => platform.createScript(s) as unknown as string;
