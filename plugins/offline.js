// Has no `network` permission. Its worker's content security policy blocks
// the fetch before it leaves the browser.

export const manifest = {
  id: "offline",
  name: "Offline",
  version: "1.0.0",
  permissions: [],
};

export default async function (ctx) {
  try {
    const response = await fetch("/index.html");
    ctx.log(`network: fetched with status ${response.status}`);
  } catch (error) {
    ctx.log(`network: refused (${error.message})`);
  }
}
