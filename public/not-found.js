// What 404.html runs (it holds no script of its own, so the page's policy can refuse inline
// scripts: public/_headers). On a first visit it starts the platform's service worker and loads
// the address again through it, so a link to an app's screen opens; with the service worker
// running and still here, nothing is at this address.

const status = document.getElementById("status");
const notFound = () => {
  document.title = "Not found";
  const home = document.createElement("a");
  home.href = "/";
  home.textContent = "Go to the front page";
  status.replaceChildren("There's nothing at this address. ", home, ".");
};
// Under the site's Trusted Types policy, a worker's script address goes through a policy (src/host/trusted.ts).
const policy = globalThis.trustedTypes?.createPolicy("platform", { createScriptURL: (url) => (url === "/sw.js" ? url : null) });
if (!("serviceWorker" in navigator) || navigator.serviceWorker.controller) notFound();
else {
  // The service worker claims this page as soon as it starts (sw.js): then load the address through it.
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  navigator.serviceWorker.register(policy ? policy.createScriptURL("/sw.js") : "/sw.js", { type: "module", scope: "/" }).catch(notFound);
}
