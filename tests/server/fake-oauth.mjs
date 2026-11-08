// Another site to sign in with, for the server checks: a plain OAuth 2
// provider with PKCE that signs in whoever `as` names, without asking.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function fakeProvider() {
  const codes = new Map();
  const tokens = new Map();
  const provider = {
    /** Who the next sign-in is: { id, name }. */
    as: { id: 1, name: "Fake Person" },
    secret: "fake-secret",
    url: "",
    close: () => new Promise((done) => server.close(done)),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, provider.url);
    if (url.pathname === "/authorize") {
      const code = Math.random().toString(36).slice(2);
      codes.set(code, { who: provider.as, challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      return res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const found = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      const verified = found && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === found.challenge;
      if (!found || !verified || form.get("client_secret") !== provider.secret || form.get("redirect_uri") !== found.redirect) return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
      const token = Math.random().toString(36).slice(2);
      tokens.set(token, found.who);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, token_type: "bearer" }));
    }
    if (url.pathname === "/user") {
      const who = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return who ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who)) : res.writeHead(401).end();
    }
    res.writeHead(404).end();
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  provider.url = `http://127.0.0.1:${server.address().port}`;
  provider.env = {
    AUTH_PROVIDERS: JSON.stringify([{ id: "fake", name: "Fake", clientId: "fake-client", authorize: `${provider.url}/authorize`, token: `${provider.url}/token`, user: `${provider.url}/user` }]),
    FAKE_CLIENT_SECRET: provider.secret,
  };
  return provider;
}
