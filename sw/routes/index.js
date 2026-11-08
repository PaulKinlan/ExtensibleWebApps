// The service worker's routes, tried in this order. Add a route as a new file
// in this folder and one line here.
//
// Reserved prefixes:
//   /user/   plugins a person added to an app, read from their data folder (sw/routes/user.js)
//   /s/      an app opened in a space that people share (sw/routes/spaces.js)

import apps from "./apps.js";
import headers from "./headers.js";
import plugins from "./plugins.js";
import spaces from "./spaces.js";
import user from "./user.js";

export default [
  headers,
  // A plugin's route inside a space is answered before the space's files.
  plugins,
  spaces,
  apps,
  user,
];
