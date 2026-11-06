// Has the `network` permission, so its worker may fetch.

export const manifest = {
  id: "fetcher",
  name: "Fetcher",
  version: "1.0.0",
  permissions: ["network"],
};

export default async function (ctx) {
  try {
    const response = await fetch("/index.html");
    ctx.log(`network: fetched with status ${response.status}`);
  } catch (error) {
    ctx.log(`network: refused (${error.message})`);
  }
}
