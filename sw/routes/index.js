// The service worker's routes, tried in this order. Add a route as a new file
// in this folder and one line here.
//
// Reserved prefixes:
//   /user/   plugins a person added to an app, read from their data folder (sw/routes/user.js)
//   /apps/   apps a person made in the browser, read from their data folder (sw/routes/made.js)
//   /s/      an app opened in a space that people share (sw/routes/spaces.js)

import apps from "./apps.js";
import headers from "./headers.js";
import made from "./made.js";
import manifest from "./manifest.js";
import plugins from "./plugins.js";
import spaces from "./spaces.js";
import user from "./user.js";

export default [
  headers,
  // A plugin's route inside a space is answered before the space's files.
  plugins,
  // An app's manifest.webmanifest, made from its page when it has none of its own: before made, which has no such file.
  manifest,
  spaces,
  // Apps a person made in the browser, from their data folder: /apps/<name>/.
  made,
  apps,
  user,
];
