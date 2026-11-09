// The sign-in provider modules this site's servers build in, by the id
// AUTH_PROVIDERS turns each on with. Each host (src/server/serve.ts,
// src/server/cloudflare/worker.ts) passes this list to providersFrom, so the
// accounts never name a provider. A provider that speaks plain OAuth 2 needs
// no module: it is configuration alone (src/server/auth/providers.ts).
//
// To add one, put it beside these and list it here. To leave one out of a
// site, take it off this list: it isn't built in.

import type { ProviderModule } from "../providers.ts";
import { bluesky } from "./bluesky/index.ts";
import github from "./github.ts";

export const providerModules: Record<string, ProviderModule> = {
  bluesky: { flow: bluesky },
  github,
};
