// A small AT Protocol network for the server checks: a PLC directory, a handle
// resolver, a PDS and its authorization server, all on one port. Its
// authorization server checks what a real one checks (PAR, DPoP proofs with
// its nonce, PKCE, the loopback client id and its redirect URI), and signs in
// whoever `as` names, without asking. A check can make it misbehave: `sub`
// answers with another account than the one signed in, and `iss` names
// another server in the callback.
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";

const did = (letter) => `did:plc:${letter.repeat(24)}`;

export async function fakeAtproto() {
  const net = {
    url: "",
    /** The accounts on this network, by handle. */
    handles: { "alice.test": did("a"), "bob.test": did("b"), "mallory.test": did("m") },
    /** Who the next sign-in is, as a DID. */
    as: did("a"),
    /** Misbehaving: the DID the token says, and the issuer the callback says. */
    sub: undefined,
    iss: undefined,
    /** What the authorization server was sent, for checks to read. */
    seen: [],
    close: () => new Promise((done) => server.close(done)),
  };
  let nonce = "n0";
  const requests = new Map();
  const codes = new Map();

  /** A DID's document: its handle, and a PDS. Mallory's PDS is here too, but under another name, whose sign-in server is another. */
  const document = (id) => {
    const handle = Object.keys(net.handles).find((h) => net.handles[h] === id);
    if (!handle) return null;
    const pds = id === did("m") ? net.url.replace("127.0.0.1", "localhost") : net.url;
    return { id, alsoKnownAs: [`at://${handle}`], service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] };
  };

  /** Checks a DPoP proof as RFC 9449 says: its signature by the key it carries, the request it's for, and the current nonce. */
  const proofOf = async (req, path) => {
    const [h, p, s] = String(req.headers.dpop ?? "").split(".");
    if (!s) return { error: "no proof" };
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const key = await webcrypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"), Buffer.from(`${h}.${p}`));
    if (!ok || header.typ !== "dpop+jwt" || header.alg !== "ES256" || header.jwk.d) return { error: "bad proof" };
    if (claims.htm !== "POST" || claims.htu !== `http://${req.headers.host}${path}` || !claims.jti) return { error: "proof for another request" };
    if (claims.nonce !== nonce) return { nonce: true };
    const { kty, crv, x, y } = header.jwk;
    return { jkt: createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url") };
  };

  const send = (res, status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  const form = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return new URLSearchParams(body);
  };
  /** The loopback client's redirect URI, read from its client id, as an authorization server does. */
  const loopback = (clientId) => {
    try {
      const url = new URL(clientId);
      return url.origin === "http://localhost" && url.pathname === "/" && url.searchParams.get("scope") === "atproto" ? url.searchParams.get("redirect_uri") : null;
    } catch {
      return null;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, net.url);
    const here = `http://${req.headers.host}`;
    if (url.pathname.startsWith("/plc/")) {
      const doc = document(decodeURIComponent(url.pathname.slice(5)));
      return doc ? send(res, 200, doc) : send(res, 404, { message: "DID not registered" });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.resolveHandle") {
      const found = net.handles[url.searchParams.get("handle")];
      return found ? send(res, 200, { did: found }) : send(res, 400, { error: "InvalidRequest", message: "Unable to resolve handle" });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") return send(res, 200, { resource: here, authorization_servers: [here] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(res, 200, {
        issuer: here,
        authorization_endpoint: `${here}/oauth/authorize`,
        token_endpoint: `${here}/oauth/token`,
        pushed_authorization_request_endpoint: `${here}/oauth/par`,
        require_pushed_authorization_requests: true,
        dpop_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["atproto", "transition:generic"],
        client_id_metadata_document_supported: true,
      });
    }
    if (url.pathname === "/oauth/par" && req.method === "POST") {
      const proof = await proofOf(req, "/oauth/par");
      const body = await form(req);
      net.seen.push({ at: "par", proof, body: Object.fromEntries(body) });
      // A new nonce for every PAR: the client must ask again with it.
      if (proof.nonce) return send(res, 400, { error: "use_dpop_nonce" }, { "dpop-nonce": (nonce = `n${Number(nonce.slice(1)) + 1}`) });
      if (proof.error) return send(res, 400, { error: "invalid_dpop_proof", error_description: proof.error });
      if (loopback(body.get("client_id")) !== body.get("redirect_uri") || body.get("code_challenge_method") !== "S256" || body.get("scope") !== "atproto") return send(res, 400, { error: "invalid_request" });
      const uri = `urn:ietf:params:oauth:request_uri:${Math.random().toString(36).slice(2)}`;
      requests.set(uri, { body, jkt: proof.jkt });
      return send(res, 201, { request_uri: uri, expires_in: 60 }, { "dpop-nonce": nonce });
    }
    if (url.pathname === "/oauth/authorize") {
      const found = requests.get(url.searchParams.get("request_uri"));
      requests.delete(url.searchParams.get("request_uri"));
      if (!found || found.body.get("client_id") !== url.searchParams.get("client_id")) return res.writeHead(400).end("Unknown request");
      const code = Math.random().toString(36).slice(2);
      codes.set(code, { ...found, who: net.as });
      const back = new URL(found.body.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", found.body.get("state"));
      back.searchParams.set("iss", net.iss ?? here);
      return res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const proof = await proofOf(req, "/oauth/token");
      const body = await form(req);
      net.seen.push({ at: "token", proof, body: Object.fromEntries(body) });
      if (proof.nonce) return send(res, 400, { error: "use_dpop_nonce" }, { "dpop-nonce": nonce });
      const found = codes.get(body.get("code"));
      codes.delete(body.get("code"));
      const pkce = found && createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") === found.body.get("code_challenge");
      // The token is bound to the key that made the PAR, so a proof by any other key is refused.
      if (!found || proof.error || proof.jkt !== found.jkt || !pkce || body.get("redirect_uri") !== found.body.get("redirect_uri") || body.get("client_id") !== found.body.get("client_id")) {
        return send(res, 400, { error: "invalid_grant" });
      }
      return send(res, 200, { access_token: "at-" + Math.random().toString(36).slice(2), token_type: "DPoP", scope: "atproto", sub: net.sub ?? found.who, expires_in: 60 }, { "dpop-nonce": nonce });
    }
    res.writeHead(404).end();
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  net.url = `http://127.0.0.1:${server.address().port}`;
  /** Its entry in AUTH_PROVIDERS: Bluesky, with this network's directory and resolver, over http://. */
  net.entry = { id: "bluesky", plc: `${net.url}/plc`, resolver: net.url, insecure: true };
  net.did = did;
  return net;
}
