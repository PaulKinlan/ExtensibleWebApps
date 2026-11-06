// The same runtime, served with a content security policy that allows
// network access, for plugins whose manifest asks for `network`. The policy
// is set per file by the server: vite.config.ts in development, public/_headers on Cloudflare.
import "./runtime";
