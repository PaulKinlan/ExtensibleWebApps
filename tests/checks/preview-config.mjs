// A branch's preview on Cloudflare (`npx wrangler preview`) inherits none of
// the site's bindings or variables: it has only what wrangler.jsonc lists
// under `previews`. With a binding missing there, the preview's front page
// still loads (it is a file) and everything that reaches for the binding
// answers "error code: 1101", which is how /auth/ was broken on every preview.
// So: each binding the Worker reads from `env` is under `previews` too, and a
// preview asks for no sign-in provider that needs a secret it doesn't have.
//
// .github/workflows/preview-sign-in.yml asks a real preview for /auth/providers.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jsonc = (text) => JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

// The site's bindings a preview goes without on purpose (wrangler.jsonc says why beside `previews`).
const LEFT_OUT = new Set(["EMAIL"]);

/** Every binding a block of the config declares, by the name the Worker reads from `env`. */
const bindings = (block) => {
  const names = new Map();
  for (const [kind, value] of Object.entries(block ?? {})) {
    const list = kind === "durable_objects" ? value?.bindings : value;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const name = entry?.binding ?? entry?.name;
      if (typeof name === "string" && kind !== "migrations") names.set(name, JSON.stringify(entry));
    }
  }
  return names;
};

export default async function ({ check }) {
  const config = jsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
  const site = bindings(config);
  const preview = bindings(config.previews);

  const missing = [...site.keys()].filter((name) => !LEFT_OUT.has(name) && !preview.has(name));
  check("a branch preview has every binding the site's Worker reads (wrangler.jsonc `previews`)", site.size >= 3 && missing.length === 0, `missing under previews: ${missing.join(", ") || "none"}`);

  const changed = [...preview.keys()].filter((name) => site.has(name) && site.get(name) !== preview.get(name));
  const extra = [...preview.keys()].filter((name) => !site.has(name));
  check("a preview's bindings are the site's own, none changed and none added", changed.length === 0 && extra.length === 0, `changed: ${changed.join(", ") || "none"}; only in previews: ${extra.join(", ") || "none"}`);

  // A provider with a client id needs <ID>_CLIENT_SECRET, which previews haven't got: the accounts would refuse to start.
  let providers;
  try {
    providers = JSON.parse(config.previews?.vars?.AUTH_PROVIDERS ?? "null");
  } catch {
    providers = null;
  }
  const needSecret = Array.isArray(providers) ? providers.filter((p) => "clientId" in p).map((p) => p.id) : [];
  check("a preview lists its sign-in providers, and none that needs a secret", Array.isArray(providers) && needSecret.length === 0, `AUTH_PROVIDERS under previews: ${JSON.stringify(providers)}`);

  // The site's own list is untouched by this: it still names GitHub, whose secret is the Worker's.
  check("the site's own sign-in providers aren't the preview's", JSON.parse(config.vars.AUTH_PROVIDERS).some((p) => p.id === "github"));
}
