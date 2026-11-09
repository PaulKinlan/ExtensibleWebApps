// Watches every page the tests open, in every browser context, for anything the
// site's page policy refused (public/_headers): a string where Trusted Types
// wants a policy's value, an inline or outside script, a device feature the
// Permissions-Policy turns off. platform.test.mjs fails the run if any page
// broke it, so CI enforces the policy on every demo and page the checks visit.

/** Reports each refusal as a console error the watcher below picks up. */
const listen = () => {
  addEventListener("securitypolicyviolation", (e) => {
    // A plugin's view may hold onclick= (the workbench's checks and the homepage's chapter 9 draw one on purpose).
    // The host takes it out before parsing (src/host/handlers.ts), because Chromium 158 and later report it as
    // it is parsed, even inert: so a report of one from the host's script fails the run too.
    console.error(`[page policy] ${e.effectiveDirective} refused ${e.blockedURI || "inline"}${e.sample ? `: ${e.sample}` : ""} at ${e.sourceFile || location.pathname}:${e.lineNumber}`);
  });
};

/** Starts watching `browser`'s contexts, made now or later; returns the refusals seen. @param {import("playwright").Browser} browser */
export function watchPolicy(browser) {
  /** @type {string[]} */
  const refused = [];
  const watch = (/** @type {import("playwright").BrowserContext} */ context) => {
    void context.addInitScript(listen);
    context.on("console", (message) => {
      const text = message.text();
      // tests/checks/page-policy.mjs breaks the policy on purpose, on a page it marks.
      if (message.page()?.url().endsWith("#policy-probe")) return;
      if (message.type() === "error" && (text.startsWith("[page policy]") || /TrustedHTML|TrustedScript|Trusted Type|Permissions policy violation/i.test(text))) refused.push(`${new URL(message.page()?.url() ?? "about:blank").pathname}: ${text}`);
    });
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    watch(context);
    return context;
  };
  return refused;
}
