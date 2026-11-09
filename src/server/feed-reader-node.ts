// The feed reader's one request on Node (feed-reader.ts): https only, and
// never to the server's own network. The check is made on the address the
// connection actually goes to, after DNS (the socket's `lookup`), so a name
// that looks up to 127.0.0.1 or 10.x is refused however it is written. The
// same addresses are refused as for server plugins (network-guard.ts);
// `allow` opens some hosts anyway, for the tests' feed server on this machine.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { Get } from "./feed-reader.ts";
import { isPrivate } from "./network-guard.ts";

const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");

export function nodeGet(allow: string[] = []): Get {
  const allowed = new Set(allow.map(bare));
  return (url, signal) =>
    new Promise<Response>((done, fail) => {
      const open = allowed.has(bare(url.hostname));
      const lookup: LookupFunction = (host, options, callback) =>
        dnsLookup(host, { ...options, all: true }, (error, list: LookupAddress[]) => {
          if (error) return (callback as any)(error);
          const ok = list.filter((a) => open || !isPrivate(a.address));
          if (!ok.length) return (callback as any)(Object.assign(new Error(`The feed reader can't reach ${url.host}: it is on the server's own network`), { code: "EPRIVATE" }));
          if ((options as { all?: boolean }).all) return (callback as any)(null, ok);
          (callback as any)(null, ok[0].address, ok[0].family);
        });
      const literal = bare(url.hostname);
      if (!open && /^[\d.]+$|:/.test(literal) && isPrivate(literal)) return fail(new Error(`The feed reader can't reach ${url.host}: it is on the server's own network`));
      const req = request(url, { method: "GET", lookup, signal, headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5", "user-agent": "ExtensibleWebApps-FeedReader" } }, (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") headers.set(name, value);
        const status = res.statusCode ?? 502;
        // A status that has no body can't be given one; anything outside 200-599 is the feed going wrong.
        if (status < 200 || status > 599 || [204, 205, 304].includes(status)) return (res.resume(), done(new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers })));
        done(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      });
      req.on("error", fail);
      req.end();
    });
}
