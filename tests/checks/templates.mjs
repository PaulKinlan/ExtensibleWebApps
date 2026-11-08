// Template filling and plugin CSS, checked directly in the workbench page
// through window.__host, without a plugin.
export default async function ({ a, check }) {
  // Nested loops multiply: 300 × 300 items would make 90,000 rows, so filling stops at its node budget.
  const tooBig = await a.evaluate(() => {
    const file = new DOMParser().parseFromString('<template id="grid"><template for="r of rows"><template for="c of rows"><i>{{c}}</i></template></template></template>', "text/html");
    const rows = Array.from({ length: 300 }, (_, i) => i);
    const started = performance.now();
    const html = window.__host.fill(file, "grid", { rows });
    return { html: html.slice(0, 120), ms: Math.round(performance.now() - started) };
  });
  check("a template that would make too many nodes stops early instead of freezing the page", /wasn't drawn/.test(tooBig.html), `${tooBig.ms}ms: ${tooBig.html}`);
  // An attribute that is one whole hole comes and goes with its value; a hole inside other text is just text.
  const conditional = await a.evaluate(() => {
    const file = new DOMParser().parseFromString('<template id="t"><input type="checkbox" checked="{{on}}"><i data-x="{{off}}" data-y="{{missing}}" data-n="{{n}}" title="is {{on}}"></i></template>', "text/html");
    return window.__host.fill(file, "t", { on: true, off: false, n: 0 });
  });
  check("an attribute that is one whole hole is left out when false or missing, and bare when true", conditional === '<input type="checkbox" checked=""><i data-n="0" title="is true"></i>', conditional);
  // A plugin's CSS keeps its rules but loses anything that loads, any @import or @font-face, and !important.
  const cleanCss = await a.evaluate(() => window.__host.cleanCss(`@import "https://example.com/x.css";
    @font-face { font-family: x; src: url(https://example.com/x.woff2); }
    .a { color: red !important; background: url(https://example.com/x.png); --y: \\75 rl(https://example.com/y.png); padding: 4px; }
    @media (min-width: 1px) { .b { cursor: url(https://example.com/c.cur), auto; margin: 1px; } }
    @keyframes spin { to { rotate: 1turn; } }
    .n { color: red; & .m { color: blue; } padding: 2px; }`));
  check("a plugin's CSS is cleaned: no url(), @import, @font-face or !important", !/url|import|font-face|important|keyframes|example/i.test(cleanCss) && /\.a \{[^}]*padding: 4px;[^}]*color: red;/.test(cleanCss) && /@media .*\.b \{ margin: 1px; \}/s.test(cleanCss) && /\.n \{[^]*padding: 2px/.test(cleanCss), cleanCss);
  // A shorthand written with var() lists as empty longhands, so the cleaner reads the shorthand itself.
  const shorthands = await a.evaluate(() => window.__host.cleanCss(`.s { background: var(--bg) url(https://example.com/s.png); color: red; }
    .t { color: red; & .u { border-image: var(--x) url(https://example.com/u.png) 30; } }
    .v { font: 600 1rem/1.2 var(--mono) !important; margin: var(--m) !important; }`));
  check(
    "a shorthand written with var() is checked whole: one that loads something goes, and one with !important stays, without it",
    !/url|example|important/i.test(shorthands) && /\.s \{ color: red; \}/.test(shorthands) && /font: 600 1rem\/1\.2 var\(--mono\)/.test(shorthands) && /margin: var\(--m\)/.test(shorthands),
    shorthands,
  );
}
