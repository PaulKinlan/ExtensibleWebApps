// Secrets and net.fetch (src/kernel/secrets.ts, src/kernel/net.ts): a plugin
// asks the person for a key, the person pastes it into the kernel's card, and
// the kernel puts it into the plugin's request to the one host it is for. A
// small echo server on this computer stands in for an API.
import { createServer } from "node:http";

export default async function ({ a, check, plugin, pluginLog, traceHas }) {
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ method: req.method, authorization: req.headers.authorization ?? null, body })));
  });
  await new Promise((resolve) => server.listen(4175, "localhost", resolve));
  try {
    await plugin(`export const manifest = { id: 'keyed', name: 'Keyed', permissions: ['network:localhost:4175', 'secret:echo'] };
export default async (ctx) => {
  ctx.log('keyed-has ' + JSON.stringify(await ctx.call('secrets', 'has', 'echo')));
  ctx.log('keyed-asked ' + JSON.stringify(await ctx.call('secrets', 'request', 'echo', { hosts: ['localhost:4175'], label: 'Echo key' })));
  const r = await ctx.call('net', 'fetch', { url: 'http://localhost:4175/echo', method: 'POST', headers: { authorization: { secret: 'echo', prefix: 'Bearer ' } }, body: 'hi' });
  ctx.log('keyed-fetch ' + r.status + ' ' + r.text);
  ctx.log('keyed-other ' + await ctx.call('net', 'fetch', { url: 'https://example.com/' }).then(() => 'reached', (e) => 'refused: ' + e.message));
};`);
    check("a plugin can ask whether it has a secret", (await pluginLog("keyed", "keyed-has")) === 'keyed-has {"set":false,"hosts":[]}');
    // The person pastes the key into the kernel's card and saves it.
    const field = await a.waitForSelector('[data-key^="secrets:"] input[type=password]', { timeout: 5000 }).catch(() => null);
    check("asking for a secret shows the person a card with a password field", !!field);
    await field?.fill("s3cret");
    await field?.press("Tab");
    await a.click('[data-key^="secrets:"] button:has-text("Save")').catch(() => {});
    check("saving the card answers the plugin's request", (await pluginLog("keyed", "keyed-asked")) === 'keyed-asked {"set":true}');
    const fetched = await pluginLog("keyed", "keyed-fetch").catch(() => "");
    check("net.fetch reaches the host the plugin names, with the secret filled into the header", fetched.includes('"authorization":"Bearer s3cret"') && fetched.includes('"body":"hi"') && fetched.startsWith("keyed-fetch 200"), fetched);
    check("net.fetch refuses a host the plugin's manifest doesn't name", /keyed-other refused/.test(await pluginLog("keyed", "keyed-other").catch(() => "")));
    check("the trace records the request and that it used the secret, not the secret itself", await traceHas(a, (e) => e.name === "net:POST localhost:4175" && /with echo/.test(e.detail ?? "") && !/s3cret/.test(e.detail ?? "")));

    // Another plugin can reach the same host, but can't use the secret without secret:echo,
    // and a plugin that may use it can't send it to a host it wasn't given for.
    await plugin(`export const manifest = { id: 'thief', name: 'Thief', permissions: ['network:localhost:4175', 'network:127.0.0.1:4175'] };
export default async (ctx) => {
  ctx.log('thief ' + await ctx.call('net', 'fetch', { url: 'http://localhost:4175/', headers: { authorization: { secret: 'echo' } } }).then((r) => 'got ' + r.text, (e) => 'refused: ' + e.message));
};`);
    await plugin(`export const manifest = { id: 'mover', name: 'Mover', permissions: ['network:127.0.0.1:4175', 'secret:echo'] };
export default async (ctx) => {
  ctx.log('mover ' + await ctx.call('net', 'fetch', { url: 'http://127.0.0.1:4175/', headers: { authorization: { secret: 'echo' } } }).then((r) => 'got ' + r.text, (e) => 'refused: ' + e.message));
};`);
    const thief = await pluginLog("thief", "thief").catch(() => "");
    const mover = await pluginLog("mover", "mover").catch(() => "");
    check("a secret is only filled in for a plugin with secret:<name>, and only to its own hosts", /needs secret:echo/.test(thief) && /only for localhost:4175/.test(mover), `${thief} | ${mover}`);
    await plugin(`export const manifest = { id: 'forgetter', name: 'Forgetter', permissions: ['secret:echo'] };
export default async (ctx) => { await ctx.call('secrets', 'forget', 'echo'); ctx.log('forgetter ' + JSON.stringify(await ctx.call('secrets', 'has', 'echo'))); };`);
    check("a secret can be forgotten", (await pluginLog("forgetter", "forgetter").catch(() => "")) === 'forgetter {"set":false,"hosts":[]}');
  } finally {
    for (const id of ["keyed", "thief", "mover", "forgetter"]) await a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});
    server.close();
  }
}
