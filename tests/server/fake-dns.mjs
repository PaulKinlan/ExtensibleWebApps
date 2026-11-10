// A stand-in DNS-over-HTTPS resolver on this machine, for the Cloudflare
// host's checks (src/server/cloudflare/names.ts reads it from DNS_RESOLVER):
// it answers as Cloudflare's JSON resolver does, from a small table, so the
// checks can ask about names that lead inside without touching real DNS.
import { createServer } from "node:http";

/** Names and where they lead. `fail` is the resolver going wrong; a name not listed doesn't exist. */
const NAMES = {
  "inside.example": { A: ["10.1.2.3"] },
  "loop.example": { A: ["93.184.216.34", "127.0.0.1"] },
  "six.example": { AAAA: ["fd00::1"] },
  "alias.example": { CNAME: "inside.example", A: ["10.1.2.3"] },
  "outside.example": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1:248:1893:25c8:1946"] },
  "broken.example": { fail: true },
};
const TYPES = { A: 1, AAAA: 28 };

export async function fakeDns() {
  const asked = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://dns");
    const name = (url.searchParams.get("name") ?? "").toLowerCase();
    const type = url.searchParams.get("type") ?? "A";
    asked.push(`${name} ${type}`);
    const known = NAMES[name];
    if (known?.fail) return res.writeHead(500).end();
    res.writeHead(200, { "content-type": "application/dns-json" });
    if (!known) return res.end(JSON.stringify({ Status: 3 }));
    const answer = [];
    if (known.CNAME) answer.push({ name, type: 5, TTL: 60, data: `${known.CNAME}.` });
    for (const data of known[type] ?? []) answer.push({ name: known.CNAME ?? name, type: TYPES[type], TTL: 60, data });
    res.end(JSON.stringify({ Status: 0, Answer: answer }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/dns-query`, asked, stop: () => new Promise((r) => server.close(r)) };
}
