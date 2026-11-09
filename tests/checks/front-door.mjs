// The server's front door (src/server/front-door.ts, the architecture audit's
// finding 5): who may join a space, which origin may open its socket and when a
// space's routes answer is decided in one place, and both hosts (Node's
// serve.ts, Cloudflare's worker.ts) ask it rather than deciding themselves.
import { readFileSync } from "node:fs";
import { frontDoor, unrouted } from "../../src/server/front-door.ts";

const read = (path) => readFileSync(new globalThis.URL(`../../${path}`, import.meta.url), "utf8");

export default async function ({ check }) {
  const accounts = {
    exists: async (space) => space === "family",
    member: async (cookie, space) => (space === "family" && cookie === "session=ann" ? "ann" : null),
  };
  const knock = (path, more = {}) => frontDoor({ method: "GET", url: new URL(`https://site.example${path}`), origin: null, cookie: "", upgrade: false, ...more }, accounts);
  const door = async (path, more) => JSON.stringify(await knock(path, more));
  const socket = { upgrade: true, cookie: "session=ann", origin: "https://site.example" };

  check("front door: /auth/ goes to the accounts", (await door("/auth/me")) === '{"door":"auth"}');
  check("front door: a member's WebSocket from this site joins the space", (await door("/s/family/kernel", socket)) === '{"door":"join","space":"family","member":"ann"}');
  check("front door: a client that isn't a browser (no Origin) may join too", (await door("/s/family/kernel", { ...socket, origin: null })) === '{"door":"join","space":"family","member":"ann"}');
  const refused = (d) => JSON.parse(d).status;
  check("front door: another site's page can't open the space's socket", refused(await door("/s/family/kernel", { ...socket, origin: "https://evil.example" })) === 403);
  check("front door: only the space's members may join it", refused(await door("/s/family/kernel", { ...socket, cookie: "session=ben" })) === 403);
  check("front door: the kernel's address is a WebSocket only", refused(await door("/s/family/kernel", { ...socket, upgrade: false })) === 426);
  check("front door: a space's name is checked before anything is asked", refused(await door("/s/Not_A_Space/kernel", socket)) === 404);
  check("front door: an address in a space that exists may be a route", (await door("/s/family/demos/survey/answer", { method: "POST" })) === '{"door":"route","space":"family","path":"/demos/survey/answer"}');
  check("front door: an address in a space that doesn't exist is the site's file", (await door("/s/nobody/demos/survey/")) === '{"door":"asset"}');
  check("front door: the site's files answer GET and HEAD, nothing else", (await door("/demos/")) === '{"door":"asset"}' && refused(await door("/demos/", { method: "PUT" })) === 405);
  check("front door: a route nobody answered is a file for GET, and refused for a POST", unrouted("GET").door === "asset" && unrouted("POST").status === 405);

  for (const host of ["src/server/serve.ts", "src/server/cloudflare/worker.ts"]) {
    const source = read(host);
    // The rules live in the door: a host that compares origins, or finds a space's routes itself, decides on its own again.
    const own = [/sameOrigin/, /get\("origin"\) !==/, /new URL\(request\.url\)\.origin\)/, /spaceRoute\(/, /\.exists\(at\./].filter((p) => p.test(source.replace(/^\s*\/\/.*$/gm, "")));
    check(`front door: ${host} asks the front door and keeps no rules of its own`, source.includes("frontDoor(") && !own.length, own.map(String).join(", "));
  }
}
