// Checks for signing in with Bluesky (src/server/auth/bluesky/), against the
// small AT Protocol network in fake-atproto.mjs. tests/server/run.mjs runs
// them on each host: the redirects a browser follows, one by one.
import { bluesky } from "../../src/server/auth/bluesky/index.ts";
import { safeUrl } from "../../src/server/auth/bluesky/resolve.ts";
import { isPublicAddress } from "../../src/server/auth/bluesky/guarded-fetch.ts";

export async function blueskyChecks(base, check, net) {
  const jar = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return res;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const get = async (url, extra = {}) => keep(await fetch(url, { redirect: "manual", headers: { cookie: cookie(), ...extra } }));
  const me = async () => (await (await get(`${base}/auth/me`)).json()).user;
  /** Type a handle, go to its server, come back: where the callback sends the browser. */
  const signIn = async (handle) => {
    jar.clear();
    const start = await get(`${base}/auth/oauth/bluesky/start?handle=${encodeURIComponent(handle)}`);
    if (start.status !== 302) return { status: start.status, location: start.headers.get("location") };
    const atServer = await get(start.headers.get("location"));
    const back = await get(atServer.headers.get("location"));
    return { status: back.status, location: back.headers.get("location"), user: await me() };
  };
  const failed = (r) => r.status === 303 && /^\/account\/\?error=/.test(r.location ?? "") && !r.user;

  const { providers = [] } = await (await get(`${base}/auth/providers`)).json();
  const listed = providers.find((p) => p.id === "bluesky");
  net.seen.length = 0;
  net.as = net.did("a");
  const alice = await signIn("alice.test");
  const pars = net.seen.filter((s) => s.at === "par");
  check(
    "bluesky: it's listed with a field for a handle, and a handle signs in a new account named by it, through PAR and DPoP with the server's nonce",
    listed?.name === "Bluesky" && listed.ask?.name === "handle" && alice.location === "/account/" && alice.user?.name === "alice.test" && pars.length === 2 && pars[0].proof.nonce && pars[1].proof.jkt && pars[1].body.login_hint === "alice.test",
    JSON.stringify({ listed, alice, pars: pars.map((p) => p.proof) }),
  );

  const again = await signIn("@Alice.test");
  const byDid = await signIn(net.did("a"));
  const byServer = await signIn(net.url);
  check(
    "bluesky: the same account comes back by its handle (with @ or capitals), its DID, or its server's address",
    [again, byDid, byServer].every((r) => r.location === "/account/" && r.user?.id === alice.user?.id),
    JSON.stringify({ again, byDid, byServer }),
  );

  // A server that signs in someone else than the account typed, or one that isn't theirs.
  net.sub = net.did("b");
  const swapped = await signIn("alice.test");
  net.sub = net.did("m");
  const notTheirs = await signIn(net.url);
  net.sub = undefined;
  net.iss = "http://elsewhere.example";
  const otherIssuer = await signIn("alice.test");
  net.iss = undefined;
  check(
    "bluesky: refused when the token is for another account than the handle typed, for an account whose DID names another server, or when the answer names another server",
    failed(swapped) && failed(notTheirs) && failed(otherIssuer),
    JSON.stringify({ swapped, notTheirs, otherIssuer }),
  );

  const nobody = await signIn("nobody.test");
  const blank = await signIn("");
  const local = await get(`${base.replace("127.0.0.1", "localhost")}/auth/oauth/bluesky/start?handle=alice.test`);
  check(
    "bluesky: a handle no one has, or none, goes back to /account/ saying so; on localhost it moves to 127.0.0.1, which atproto's development client needs",
    failed(nobody) && /handle/.test(decodeURIComponent(nobody.location)) && failed(blank) && new URL(local.headers.get("location") ?? "x:").hostname === "127.0.0.1",
    JSON.stringify({ nobody, blank, local: local.headers.get("location") }),
  );

  // Signed in, a link on another site that starts linking (with an attacker's handle) is refused, and so is
  // linking from localhost, whose move to 127.0.0.1 would leave the session behind.
  const signedIn = await signIn("alice.test");
  const crossSite = await get(`${base}/auth/oauth/bluesky/start?handle=bob.test`, { "sec-fetch-site": "cross-site" });
  const ownPage = await get(`${base}/auth/oauth/bluesky/start?handle=bob.test`, { "sec-fetch-site": "same-origin" });
  const fromLocalhost = await get(`${base.replace("127.0.0.1", "localhost")}/auth/oauth/bluesky/start?handle=bob.test`);
  check(
    "bluesky: a sign-in or link started from another site is refused, one from this site's page goes ahead, and linking from localhost says to sign in at 127.0.0.1",
    signedIn.user?.id === alice.user?.id && crossSite.status === 303 && /error=/.test(crossSite.headers.get("location") ?? "") && ownPage.status === 302 && /error=.*127\.0\.0\.1/.test(decodeURIComponent(fromLocalhost.headers.get("location") ?? "")) && (await me())?.id === alice.user?.id,
    JSON.stringify({ crossSite: crossSite.headers.get("location"), ownPage: ownPage.status, fromLocalhost: fromLocalhost.headers.get("location") }),
  );

  // Not over the network: what this server publishes about itself on HTTPS, and which servers it won't ask.
  const flow = bluesky({ id: "bluesky" });
  const metadata = await flow.serve(new URL("https://apps.example/auth/oauth/bluesky/client-metadata.json"), "client-metadata.json")?.json();
  const settings = { insecure: false };
  const refuses = ["https://localhost.", "https://router.local.", "http://bsky.social", "https://10.0.0.1", "https://[::1]", "https://localhost", "https://intranet", "https://router.local", "https://u:p@bsky.social"].filter((u) => {
    try {
      safeUrl(u, settings);
      return false;
    } catch {
      return true;
    }
  });
  check(
    "bluesky: on HTTPS its client id is its metadata's own URL, with this site's callback; and it won't ask a server that isn't public HTTPS",
    metadata?.client_id === "https://apps.example/auth/oauth/bluesky/client-metadata.json" && metadata.redirect_uris?.[0] === "https://apps.example/auth/oauth/bluesky/callback" && metadata.dpop_bound_access_tokens === true && refuses.length === 9 && safeUrl("https://bsky.social", settings),
    JSON.stringify({ metadata, refuses }),
  );

  const privateOnes = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"];
  const publicOnes = ["8.8.8.8", "151.101.1.1", "2606:4700::1111"];
  check(
    "bluesky: on Node, its fetch connects only to public addresses, whatever a name resolves to",
    privateOnes.every((a) => !isPublicAddress(a)) && publicOnes.every(isPublicAddress),
    JSON.stringify({ allowed: privateOnes.filter(isPublicAddress), refused: publicOnes.filter((a) => !isPublicAddress(a)) }),
  );
}
