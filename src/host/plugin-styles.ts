// Plugin stylesheets. A template file may carry a <style> beside its
// templates. The host checks that CSS and installs it so that it reaches only
// that plugin's own views, and loses to the page:
//
//   @layer platform, plugins;              styles.css declares the order
//   @layer plugins {
//     @scope ([data-plugin="month"] > *) { only inside this plugin's views
//       .month td { height: 5.5rem }
//     }
//   }
//
// The page's own <style> is not in a layer, so it beats both layers: the app
// author has the last word on how every plugin looks. Each view entry gets
// data-plugin from the host (the sanitiser drops it from plugin HTML), and is
// contained (contain: layout paint), so nothing a plugin styles can be drawn
// over the rest of the page, even with position: fixed. The scope starts at
// the entry's children, not the entry: a plugin's CSS can't match the element
// that holds the containment (not even with :scope), so it can't undo it.
//
// The CSS is parsed by the browser, then rebuilt from what is allowed:
//   - style rules, and the @media, @supports, @container and @layer blocks
//     around them;
//   - not @import, @font-face, @keyframes or other at-rules;
//   - no declaration that loads something (url(), src(), image-set()…),
//     because a stylesheet must not make requests a plugin can't;
//   - no !important, which in a layer would beat the page.

const installed = new Set<string>();

/** Installs the CSS from `src` for `plugin`'s views, once per plugin and file. */
export function installPluginStyle(plugin: string, src: string, css: string): void {
  const key = `${plugin}\n${src}`;
  if (installed.has(key)) return;
  installed.add(key);
  const rules = cleanCss(css);
  if (!rules) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`@layer plugins { @scope ([data-plugin="${CSS.escape(plugin)}"] > *) {\n${rules}\n} }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/**
 * Functions that load something. A value with a backslash goes too: in a
 * custom property an escape like \75 rl( is kept as written, and only
 * becomes url( where the property is used.
 */
const LOADS = /\b(url|src|image-set|image|cross-fade|element)\s*\(|\\/i;

/** The allowed part of `css`, as text. Exported for the tests. */
export function cleanCss(css: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css); // @import is ignored here, and bad CSS is dropped rule by rule.
  return [...sheet.cssRules].map(cleanRule).filter(Boolean).join("\n");
}

/** Drops declarations that load something, and !important, in place. */
function cleanDeclarations(style: CSSStyleDeclaration): string {
  for (const name of [...style]) {
    const value = style.getPropertyValue(name);
    if (LOADS.test(value)) style.removeProperty(name);
    else if (style.getPropertyPriority(name)) style.setProperty(name, value);
  }
  return style.cssText;
}

function cleanRule(rule: CSSRule): string {
  if (rule instanceof CSSStyleRule) {
    // Nested rules (CSS nesting) are checked the same way.
    const nested = [...rule.cssRules].map(cleanRule).filter(Boolean).join("\n");
    const body = [cleanDeclarations(rule.style), nested].filter(Boolean).join(" ");
    return body ? `${rule.selectorText} { ${body} }` : "";
  }
  // Declarations after a nested rule, or directly inside a nested @media, come as their own block.
  if (rule.constructor.name === "CSSNestedDeclarations") return cleanDeclarations((rule as CSSRule & { style: CSSStyleDeclaration }).style);
  const block = (prelude: string) => {
    const inner = [...(rule as CSSGroupingRule).cssRules].map(cleanRule).filter(Boolean).join("\n");
    return inner ? `${prelude} { ${inner} }` : "";
  };
  if (rule instanceof CSSMediaRule) return block(`@media ${rule.conditionText}`);
  if (rule instanceof CSSSupportsRule) return block(`@supports ${rule.conditionText}`);
  if (rule instanceof CSSContainerRule) return block(`@container ${(rule as CSSContainerRule).containerName} ${(rule as CSSContainerRule).containerQuery}`);
  if (rule instanceof CSSLayerBlockRule) return block(`@layer ${rule.name}`);
  return ""; // @font-face, @keyframes, @property, @page, @namespace, @layer statements…
}
