// Has no `network` permission. Its worker's content security policy blocks
// the fetch before it leaves the browser, and stops it from starting a worker
// of its own (which would get the network runtime's more open policy).

export const manifest = {
  id: "offline",
  name: "Offline",
  version: "1.0.0",
  permissions: [],
};

export default async function (ctx) {
  try {
    const child = new Worker(self.location.href.replace(/runtime/, "net-runtime"), { type: "module" });
    child.onerror = () => ctx.log("escape: blocked");
  } catch (error) {
    ctx.log(`escape: blocked (${error.name})`);
  }
  try {
    const response = await fetch("/index.html");
    ctx.log(`network: fetched with status ${response.status}`);
  } catch (error) {
    ctx.log(`network: refused (${error.message})`);
  }
}
