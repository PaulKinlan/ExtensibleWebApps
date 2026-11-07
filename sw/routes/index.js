// The service worker's routes, tried in this order. Add a route as a new file
// in this folder and one line here.
//
// Reserved prefixes:
//   /user/   plugins a person added to an app, read from their data folder (sw/routes/user.js)

import apps from "./apps.js";
import headers from "./headers.js";
import plugins from "./plugins.js";

export default [
  headers,
  plugins,
  apps,
];
