// The account page (account/index.html): sign in with a passkey or a provider, make and share
// spaces, invite people, keep an email address and make agent keys. A file of its own, not a
// script in the page, so the page's policy can refuse every inline script (public/_headers).

const $ = (id) => document.getElementById(id);
const say = (text) => ($("status").textContent = text);

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 401) throw new Error(data.error ?? `The server answered ${res.status}`);
  return { status: res.status, ...data };
}

// An invite in the address, kept for signing in with another site, which comes back to /account/.
const pendingInvite = new URLSearchParams(location.search).get("invite");

// The app this page was opened from, to open in a space: /account/?app=/demos/<app>/, or else the
// app page that linked here. Kept for this tab, since signing in elsewhere comes back without it.
const APP = /^\/(?:[a-z0-9][a-z0-9-]*\/)+$/;
/** What was asked for: an address given in ?app= (which must be an app as given), or the folder of the page that linked here. */
const appAsked = (() => {
  const asked = new URLSearchParams(location.search).get("app");
  if (asked !== null) return { path: asked, exact: true };
  try {
    const from = new URL(document.referrer);
    if (from.origin === location.origin) {
      const path = from.pathname.replace(/^\/s\/[a-z0-9][a-z0-9-]*\//, "/").replace(/[^/]*$/, "");
      if (APP.test(path) && !path.startsWith("/account/")) return { path, exact: false };
    }
  } catch {}
  try {
    const kept = sessionStorage.getItem("account:app");
    return kept ? { path: kept, exact: true } : null;
  } catch { return null; }
})();

/** The app.html at a folder, or undefined. */
const page = async (path) => {
  const res = await fetch(`${path}app.html`).catch(() => undefined);
  return res?.ok && (res.headers.get("content-type") ?? "").includes("html") ? res : undefined;
};

/**
 * The asked-for app's address and title, or undefined if none was asked for. A page that linked here may
 * be one of an app's screens (/demos/<app>/book/42), so its nearest folder with an app.html is the
 * app. One named in ?app= must be an app as given, and says so when it isn't.
 */
async function appFrom(asked) {
  if (!asked?.path) return undefined;
  let path = APP.test(asked.path) ? asked.path : "";
  let found = path ? await page(path) : undefined;
  while (!found && !asked.exact && path.split("/").length > 3) {
    path = path.replace(/[^/]+\/$/, "");
    found = await page(path);
  }
  if (!found) {
    try { sessionStorage.removeItem("account:app"); } catch {}
    if (asked.exact) say(`There's no app at ${asked.path} to open in a space.`);
    return undefined;
  }
  try { sessionStorage.setItem("account:app", path); } catch {}
  // Read as a document without scripts, through a policy, since the page takes no markup from a plain string (public/_headers).
  const policy = globalThis.trustedTypes?.createPolicy("platform", { createHTML: (s) => s });
  const markup = await found.text();
  const title = new DOMParser().parseFromString(policy ? policy.createHTML(markup) : markup, "text/html").title.trim();
  return { path, title: title || path };
}
const appReady = appFrom(appAsked);

/** Other sites this server lets people sign in with: a link each, which signs in (or, signed in, links that account to yours). */
async function providers() {
  const { providers = [] } = await fetch("/auth/providers").then((r) => (r.ok ? r.json() : {}), () => ({}));
  for (const holder of document.querySelectorAll(".providers")) {
    holder.replaceChildren(
      ...providers.map(({ id, name, ask }) => {
        const text = holder.hasAttribute("data-link") ? `Link your ${name} account` : `Sign in with ${name}`;
        if (!ask) return Object.assign(document.createElement("a"), { href: `/auth/oauth/${id}/start${pendingInvite ? `?invite=${encodeURIComponent(pendingInvite)}` : ""}`, className: "button", textContent: text });
        // A provider that needs something typed first (Bluesky, your handle): a small form that goes to the same place.
        const form = Object.assign(document.createElement("form"), { method: "get", action: `/auth/oauth/${id}/start` });
        const field = Object.assign(document.createElement("input"), { name: ask.name, placeholder: ask.placeholder, required: true, autocomplete: "username", spellcheck: false, autocapitalize: "none" });
        field.setAttribute("aria-label", ask.label);
        const invite = pendingInvite ? [Object.assign(document.createElement("input"), { type: "hidden", name: "invite", value: pendingInvite })] : [];
        form.append(field, ...invite, Object.assign(document.createElement("button"), { type: "submit", textContent: text }));
        return form;
      }),
    );
  }
}

async function show() {
  const res = await fetch("/auth/me");
  if (res.status === 404 || !res.headers.get("content-type")?.includes("json")) return void ($("unavailable").hidden = false);
  const { user } = await res.json();
  $("in").hidden = !user;
  $("out").hidden = !!user;
  $("who").textContent = user?.name ?? "";
  $("email-address").value = user?.email ?? "";
  $("email-state").textContent = !user?.email ? "" : user.emailConfirmed ? "Confirmed: apps in your spaces can email you here." : "Not confirmed yet: open the link we mailed to it, or press Save to send a new one. Until then, apps can't email it.";
  $("email-test").hidden = !user?.emailConfirmed;
  // An invite made before signing out isn't for whoever signs in next.
  if (!user) {
    $("invite-link").hidden = true;
    $("invite-url").value = "";
    return;
  }
  // Signed in with an invite in the address: join that space, once.
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) {
    history.replaceState(null, "", location.pathname);
    const joined = await call("/auth/invites/accept", { token: invite }).catch((error) => ({ error: error.message }));
    say(joined.space ? `You've joined ${joined.space.name}.` : joined.error);
  }
  const { spaces = [] } = await call("/auth/spaces");
  const app = await appReady;
  $("spaces").replaceChildren(
    ...spaces.map(({ name, role }) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("strong"), { textContent: name }), ` (${role === "owner" ? "yours" : "member"}) `);
      // Any app opens in a space: its data is then the space's, shared with everyone in it.
      // The app you came from, if any, and the site's own front page: no app is named here.
      if (app) li.append(Object.assign(document.createElement("a"), { href: `/s/${name}${app.path}`, textContent: `Open ${app.title} in it` }), " ");
      li.append(Object.assign(document.createElement("a"), { href: `/s/${name}/`, textContent: "Open the site in it" }), " ");
      if (role === "owner") {
        const button = Object.assign(document.createElement("button"), { type: "button", textContent: "Invite someone" });
        button.addEventListener("click", run(async () => {
          const { token } = await call(`/auth/spaces/${name}/invite`, {});
          $("invite-url").value = new URL(`/account/?invite=${token}`, location.href).href;
          $("invite-link").hidden = false;
        }, `Here's an invite to ${name}.`, false));
        li.append(button, " ");
        // Moving the space to another server (src/server/transfer.ts): a copy of everything in it, and a copy loaded into an empty one.
        li.append(Object.assign(document.createElement("a"), { href: `/auth/spaces/${name}/export`, download: `${name}.space.json`, className: "button", textContent: "Download a copy" }), " ");
        const load = Object.assign(document.createElement("button"), { type: "button", textContent: "Load a copy" });
        const file = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json", hidden: true });
        load.addEventListener("click", () => file.click());
        file.addEventListener("change", run(async () => {
          const chosen = file.files?.[0];
          file.value = "";
          if (!chosen) return;
          const res = await fetch(`/auth/spaces/${name}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: await chosen.text() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
        }, `The copy is in ${name}. Invite the others again: they have accounts on the old server, not this one.`, false));
        li.append(load, file);
      } else {
        const button = Object.assign(document.createElement("button"), { type: "button", textContent: "Leave" });
        button.addEventListener("click", run(() => call(`/auth/spaces/${name}/leave`, {}), `You've left ${name}.`, false));
        li.append(button);
      }
      return li;
    }),
  );
  if (!spaces.length) $("spaces").append(Object.assign(document.createElement("li"), { textContent: "None yet." }));
}

/** Makes a passkey from the server's options, and gives it back to the server. */
async function register(name) {
  const options = await call("/auth/register/options", { name });
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
  await call("/auth/register", credential.toJSON());
}

const run = (task, done, passkey = true) => async (event) => {
  event?.preventDefault();
  say("");
  if (passkey && !window.PublicKeyCredential?.parseCreationOptionsFromJSON) return say("This browser can't use passkeys yet.");
  try {
    const said = await task();
    say(typeof said === "string" ? said : done);
    if (event?.target instanceof HTMLFormElement) event.target.reset();
  } catch (error) {
    // Closing the passkey prompt isn't an error worth more than a line.
    say(error.name === "NotAllowedError" ? "No passkey was used." : error.message);
  }
  await show();
};

$("register").addEventListener("submit", run(() => register($("name").value.trim()), "Your account is made, and you're signed in."));
$("add").addEventListener("click", run(() => register(), "Another passkey is added to your account."));
$("signin").addEventListener("click", run(async () => {
  const options = await call("/auth/signin/options", {});
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  const answer = await call("/auth/signin", credential.toJSON());
  if (answer.status === 401) throw new Error(answer.error);
}, "You're signed in."));
$("email").addEventListener("submit", run(async () => {
  const answer = await call("/auth/me/email", { email: $("email-address").value.trim() });
  if (answer.status === 401) throw new Error("You're signed out: sign in again, then save it");
  if (answer.sent) return "Look in your inbox (and spam) for a link to confirm your address.";
  if (answer.user?.emailConfirmed) return "That address is already confirmed.";
}, "Your email is removed.", false));
$("email-test").addEventListener("click", run(async () => {
  const answer = await call("/auth/me/email/test", {});
  if (answer.status !== 200) throw new Error(answer.error ?? "The test message couldn't be sent");
}, "A test message is on its way: look in your inbox (and spam).", false));
$("new-space").addEventListener("submit", run(() => call("/auth/spaces", { name: $("space-name").value.trim() }), "Your space is made.", false));
$("signout").addEventListener("click", run(() => call("/auth/signout", {}), "You're signed out.", false));

// Back from another site with a problem: say what it was, once.
const error = new URLSearchParams(location.search).get("error");
if (error) {
  say(error);
  history.replaceState(null, "", location.pathname);
}
// Back from the link mailed to an address: confirm it, once. It needs no sign-in: having the link is the proof.
const confirm = new URLSearchParams(location.search).get("confirm");
if (confirm) {
  history.replaceState(null, "", location.pathname);
  run(async () => {
    await call("/auth/me/email/confirm", { token: confirm });
  }, "Your email is confirmed.", false)();
}
providers();
show();
