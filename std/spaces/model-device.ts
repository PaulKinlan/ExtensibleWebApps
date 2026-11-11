// A member's side of the model key a space holds (model-key.ts, on the
// space's server): this device asks the site, signed in as the member, and
// the answer comes back with no key in it. The key never reaches here.
//
// Loaded the first time a plugin asks about the space's model.

const where = (space: string, rest = "") => `/auth/spaces/${encodeURIComponent(space)}/model${rest}`;

async function said(response: Response): Promise<Record<string, any>> {
  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (response.ok && body) return body;
  if (response.status === 401) throw new Error("You're signed out, so the space's model can't be asked. Sign in on your account page, then ask again.");
  throw new Error(typeof body?.error === "string" ? body.error : `The space's model couldn't be asked (${response.status}). Try again in a moment.`);
}

const reach = (work: Promise<Response>) =>
  work.catch(() => {
    throw new Error("This device can't reach the space right now, so its model can't be asked. Check your connection and ask again.");
  });

/** Whether the space has a model key, whose it is and for which model: never the key. */
export const modelState = async (space: string) => said(await reach(fetch(where(space), { credentials: "same-origin", cache: "no-store" })));

/** Asks the model on the space's key: a request as llm.complete takes it, or { models: true } for its list. */
export const askModel = async (space: string, body: Record<string, unknown>) =>
  said(await reach(fetch(where(space), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
