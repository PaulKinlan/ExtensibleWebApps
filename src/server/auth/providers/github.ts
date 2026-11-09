// Sign in with GitHub: plain OAuth 2, with GitHub's URLs filled in. Turned on
// with { "id": "github", "clientId": "Iv1..." } in AUTH_PROVIDERS and the
// secret in GITHUB_CLIENT_SECRET (src/server/auth/providers.ts).

import type { ProviderModule } from "../providers.ts";

export default {
  preset: {
    name: "GitHub",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    // No scope: only the public profile, which is all sign-in needs.
    scope: "",
    id_: (p) => String(p.id),
    name_: (p) => String(p.name || p.login || "GitHub user"),
  },
} satisfies ProviderModule;
