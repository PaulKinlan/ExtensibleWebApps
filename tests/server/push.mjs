// Notifications with every tab closed (src/server/auth/push.ts, std/notify/module.ts),
// the same on every host: a device gives its push subscription to the person's
// account; a plugin on a space's server shows a notification, and the server
// sends it, encrypted for each device, to the device's push service, signed
// with a key the server made itself; a job set with ctx.schedule sends one
// with nobody connected.
//
// The push service here is a stand-in on this machine, which both hosts are
// told they may send to (PUSH_HOSTS). Each "device" is a key pair made here,
// as a browser makes one, so what arrives is read the way a browser reads it
// (RFC 8291) and its signature checked as a push service checks it (RFC 8292).
//
// The app is tests/fixtures/server-app/, whose nudger.js shows the notifications.

import { createServer } from "node:http";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const utf8 = (text) => new TextEncoder().encode(text);
const join = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bytes * 8));

/** A push service: takes what a server sends to a subscription's address, and keeps it for the checks to read. */
export async function fakePushService() {
  const received = [];
  /** Subscriptions that have ended: the service answers 410 for them, as a real one does. */
  const ended = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const id = req.url.split("/").pop();
      if (req.method !== "POST" || !req.url.startsWith("/send/")) return res.writeHead(404).end();
      if (ended.has(id)) return res.writeHead(410).end();
      received.push({ id, headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, received, ended, close: () => server.close() };
}

/** A device's subscription, as a browser makes one: where to send, and the keys only the device can read with. */
export async function subscription(service, id) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const mine = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    id,
    json: { endpoint: `${service.origin}/send/${id}`, keys: { p256dh: b64url(mine), auth: b64url(auth) } },
    /** What has arrived for this device, read as the browser would. */
    async notes() {
      const out = [];
      for (const m of service.received.filter((r) => r.id === id)) {
        try {
          const salt = m.body.slice(0, 16);
          const keyLength = m.body[20];
          const theirs = m.body.slice(21, 21 + keyLength);
          const sealed = m.body.slice(21 + keyLength);
          const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await crypto.subtle.importKey("raw", theirs, { name: "ECDH", namedCurve: "P-256" }, false, []) }, pair.privateKey, 256));
          const ikm = await hkdf(auth, shared, join(utf8("WebPush: info\0"), mine, theirs), 32);
          const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
          const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
          const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
          const end = plain.lastIndexOf(2);
          out.push({ ...JSON.parse(new TextDecoder().decode(plain.slice(0, end))), headers: m.headers });
        } catch (error) {
          out.push({ unreadable: String(error), headers: m.headers });
        }
      }
      return out;
    },
  };
}

/** Whether a message's Authorization is a VAPID token signed by `key` for this push service. */
async function signedBy(authorization, key, origin) {
  const [, token, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(authorization ?? "") ?? [];
  if (!token || k !== key) return false;
  const [head, claims, signature] = token.split(".");
  const said = JSON.parse(Buffer.from(claims, "base64url").toString());
  const verify = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, Buffer.from(signature, "base64url"), utf8(`${head}.${claims}`));
  return good && JSON.parse(Buffer.from(head, "base64url").toString()).alg === "ES256" && said.aud === origin && said.exp > Date.now() / 1000 && said.exp < Date.now() / 1000 + 24 * 3600 && /^(mailto:|https:)/.test(said.sub ?? "");
}

const until = async (test, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got || Date.now() > end) return got;
    await new Promise((r) => setTimeout(r, 200));
  }
};

/**
 * @param {string} base @param {(what: string, ok: unknown, detail?: string) => void} check
 * @param {{ cookie: string, base: string, call: Function }} owner @param {() => any} person makes a new person
 * @param {{ device: Function, client: Function }} tools the runner's device (speaks sync) and client (runs commands)
 * @param {Awaited<ReturnType<typeof fakePushService>>} service
 */
export async function pushChecks(base, check, owner, person, { device, client }, service) {
  // The push service is the same for each host's run: nothing of the last one's is left in it.
  service.ended.clear();
  service.received.length = 0;
  await owner.call("/auth/spaces", { name: "bins" });
  const ann = await person().account("Ann");
  const bo = await person().account("Bo");
  for (const who of [ann, bo]) await who.call("/auth/invites/accept", { token: (await owner.call("/auth/spaces/bins/invite", {})).body?.token });
  const members = (await owner.call("/auth/spaces/bins")).body?.members ?? [];
  const idOf = (name) => members.find((m) => m.name === name)?.id;

  const signedOut = await person().call("/auth/push");
  const first = await owner.call("/auth/push");
  const key = first.body?.key ?? "";
  check(
    "push: the server makes its own key for notifications, the same each time, and only someone signed in is given it",
    signedOut.status === 401 && /Sign in/.test(signedOut.body?.error ?? "") && Buffer.from(key, "base64url").length === 65 && first.body?.devices?.length === 0 && (await ann.call("/auth/push")).body?.key === key,
    JSON.stringify([signedOut, first]),
  );

  const phone = await subscription(service, "owner-phone");
  const laptop = await subscription(service, "owner-laptop");
  const annPhone = await subscription(service, "ann-phone");
  const elsewhere = await owner.call("/auth/push", { subscription: { ...phone.json, endpoint: "https://push.elsewhere.example/send/1" } });
  const inside = await owner.call("/auth/push", { subscription: { ...phone.json, endpoint: `${base}/auth/me` } });
  const muddled = await owner.call("/auth/push", { subscription: { endpoint: phone.json.endpoint, keys: { p256dh: "short", auth: "x" } } });
  const cross = await owner.call("/auth/push", { subscription: phone.json }, { origin: "https://elsewhere.example" });
  check(
    "push: a subscription is only taken for a push service the site sends to, and a refusal says what to do",
    elsewhere.status === 400 && /push\.elsewhere\.example/.test(elsewhere.body?.error ?? "") && /PUSH_HOSTS/.test(elsewhere.body?.error ?? "") && inside.status === 400 && muddled.status === 400 && /account page/.test(muddled.body?.error ?? "") && cross.status >= 400 && (await owner.call("/auth/push")).body?.devices?.length === 0,
    JSON.stringify([elsewhere, inside, muddled, cross]),
  );

  const added = await owner.call("/auth/push", { subscription: phone.json, label: "Phone" });
  await owner.call("/auth/push", { subscription: laptop.json, label: "Laptop" });
  const again = await owner.call("/auth/push", { subscription: phone.json, label: "Phone" });
  await ann.call("/auth/push", { subscription: annPhone.json, label: "Ann's phone" });
  const here = await owner.call(`/auth/push?endpoint=${encodeURIComponent(phone.json.endpoint)}`);
  const notHere = await ann.call(`/auth/push?endpoint=${encodeURIComponent(phone.json.endpoint)}`);
  check(
    "push: a person's devices are kept with their account, each once, and a browser can ask whether it is one of them",
    added.status === 200 && added.body?.id && again.body?.devices?.length === 2 && again.body.devices.map((d) => d.label).join() === "Phone,Laptop" && here.body?.here === added.body.id && !notHere.body?.here && notHere.body?.devices?.length === 1 && !JSON.stringify(again.body).includes(service.origin),
    JSON.stringify([added, again, here, notHere]),
  );

  // The same browser, after Bo signs in on it and turns notifications on: it stops being Ann's.
  const shared = await subscription(service, "shared-browser");
  await ann.call("/auth/push", { subscription: shared.json, label: "Shared" });
  const taken = await bo.call("/auth/push", { subscription: shared.json, label: "Shared" });
  const annHas = (await ann.call("/auth/push")).body?.devices?.map((d) => d.label) ?? [];
  check("push: a browser is one person's at a time: when someone else turns notifications on in it, it stops being the first person's", taken.status === 200 && taken.body?.devices?.length === 1 && annHas.join() === "Ann's phone", JSON.stringify({ taken, annHas }));
  await bo.call("/auth/push/remove", { endpoint: shared.json.endpoint });

  // The space reads the app's plugins once a device says the app is open in it; then every device goes away.
  const opener = await device(base, "bins", owner.cookie);
  await opener.hello(0);
  opener.app("server-app");
  const nudge = (form = {}) => fetch(`${base}/s/bins/server-app/nudge`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }).then((r) => r.json(), () => null);
  await until(async () => (await nudge({ title: "Warm up", to: "nobody" }))?.state === "granted", 15_000);
  opener.close();
  await new Promise((r) => setTimeout(r, 500));
  service.received.length = 0;

  /** What the space's trace says of the notifications it sent: how many devices each reached, and what went wrong. */
  const said = async () => {
    const asker = await client(base, "bins", owner.cookie).catch(() => null);
    const trace = await asker?.command("trace").catch(() => null);
    asker?.close();
    return (Array.isArray(trace) ? trace : (trace?.entries ?? [])).filter((e) => e.name === "notify:push").map((e) => e.detail);
  };
  const all = await nudge({ title: "Bins are out" });
  const got = await Promise.all([phone, laptop, annPhone].map((d) => until(async () => (await d.notes()).find((n) => n.title === "Bins are out"))));
  const sent = service.received.find((r) => r.id === "owner-phone");
  check(
    "push: a server plugin's notification reaches every member's devices with nobody connected, encrypted for each device",
    all?.shown === true && got.every((n) => n && n.body === "From the space's server" && n.url === "/s/bins/server-app/" && n.app === "/s/bins/server-app/" && /nudger:nudge$/.test(n.tag ?? "")) && sent?.headers["content-encoding"] === "aes128gcm" && Number(sent?.headers.ttl) > 0 && !Buffer.from(sent.body).includes("Bins are out"),
    JSON.stringify({ all, got: got.map((n) => n && { ...n, headers: undefined }), arrived: service.received.map((r) => r.id), unreadable: (await Promise.all([phone, laptop, annPhone].map((d) => d.notes()))).flat().filter((n) => n.unreadable).map((n) => n.unreadable), trace: await said(), headers: sent?.headers }),
  );
  check("push: each message is signed with the server's key, for that push service", sent && (await signedBy(sent.headers.authorization, key, service.origin)), String(sent?.headers.authorization).slice(0, 80));

  service.received.length = 0;
  const one = await nudge({ title: "Only Ann", to: idOf("Ann") });
  const toAnn = await until(async () => (await annPhone.notes()).find((n) => n.title === "Only Ann"));
  await new Promise((r) => setTimeout(r, 500));
  const none = await nudge({ title: "Only Bo", to: idOf("Bo") });
  const outsider = await nudge({ title: "Someone else", to: "someone-not-in-the-space" });
  await new Promise((r) => setTimeout(r, 500));
  check(
    "push: a notification for some members goes only to them, and says when it reached nobody",
    one?.shown === true && toAnn && service.received.every((r) => r.id === "ann-phone") && service.received.length === 1 && none?.shown === false && outsider?.shown === false,
    JSON.stringify({ one, none, outsider, received: service.received.map((r) => r.id) }),
  );

  // A reminder: a job set for later shows its notification at its time, with nobody connected.
  service.received.length = 0;
  const later = await fetch(`${base}/s/bins/server-app/later`, { method: "POST" }).then((r) => r.json(), () => null);
  const reminded = await until(async () => (await annPhone.notes()).find((n) => n.title === "The bins go out tonight"), 20_000);
  check("push: a reminder set in a space arrives at its time with every tab closed", later?.set === true && reminded && /nudger:reminder$/.test(reminded.tag ?? ""), JSON.stringify({ later, reminded: reminded && { ...reminded, headers: undefined } }));

  // A subscription that has ended (the browser's data was cleared): the push service says so, and the device is forgotten.
  service.ended.add("owner-laptop");
  service.received.length = 0;
  const test = await owner.call("/auth/push/test", {});
  const tested = await until(async () => (await phone.notes()).find((n) => /reach this device/.test(n.title ?? "")));
  const left = (await owner.call("/auth/push")).body?.devices ?? [];
  const noDevice = await bo.call("/auth/push/test", {});
  check(
    "push: a person can send their own devices a test, and a device whose subscription ended is forgotten",
    test.status === 200 && test.body?.sent === 1 && tested?.url === "/account/" && tested.always === true && left.length === 1 && left[0].label === "Phone" && noDevice.status === 409 && /Turn them on/.test(noDevice.body?.error ?? "") && service.received.every((r) => r.id === "owner-phone"),
    JSON.stringify({ test, left, noDevice }),
  );

  const removed = await owner.call("/auth/push/remove", { endpoint: phone.json.endpoint });
  const notMine = await ann.call("/auth/push/remove", { id: added.body?.id });
  service.received.length = 0;
  const after = await nudge({ title: "After", to: idOf("Owner") });
  check(
    "push: a device taken away gets nothing more, and nobody takes away another person's",
    removed.status === 200 && removed.body?.devices?.length === 0 && notMine.status === 404 && after?.shown === false && service.received.length === 0,
    JSON.stringify({ removed, notMine, after }),
  );
}
