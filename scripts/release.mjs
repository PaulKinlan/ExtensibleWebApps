#!/usr/bin/env node
// Gets the two npm packages ready to publish at one version. It only edits
// their package.json files in this checkout: it publishes nothing, and what
// it writes is never committed. The "Publish to npm" workflow
// (.github/workflows/publish-npm.yml) runs it, then `npm publish` for each;
// the project checks run it too, to install the packages as npm would serve them.
//
//   node scripts/release.mjs 0.1.0
//
// The platform (the root package.json, `extensible-web-apps`):
//   - gets the version, and loses `private`, which is there so nobody publishes
//     a checkout by accident. A copy without it knows it came from npm, so the
//     projects it makes depend on it by version (scripts/create-app.mjs).
//
// The create command (scripts/create-extensible-app/, `create-extensible-app`):
//   - gets the same version, and runs the platform's command from npm from
//     then on (`config.platform`), not from GitHub.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A version npm takes, without a leading v: 0.1.0, 1.2.3-beta.1. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * Writes the version into both packages, in `root`. Returns each package's name and folder, in the order to
 * publish them: the platform first, since the create command runs it.
 * @param {string} version @param {string} [root]
 */
export function prepare(version, root = ROOT) {
  if (!VERSION.test(version)) throw new Error(`"${version}" isn't a version: it looks like 0.1.0 or 1.2.3-beta.1, with no v in front`);
  const edit = (folder, change) => {
    const file = join(root, folder, "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    change(pkg);
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    return { name: pkg.name, version: pkg.version, folder: join(root, folder) };
  };
  const platform = edit(".", (pkg) => {
    pkg.version = version;
    delete pkg.private;
  });
  const create = edit("scripts/create-extensible-app", (pkg) => {
    pkg.version = version;
    pkg.config = { ...pkg.config, platform: `${platform.name}@latest` };
  });
  return [platform, create];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/release.mjs <version>");
    for (const { name, version, folder } of prepare(process.argv[2])) console.log(`${name}@${version} is ready to publish from ${folder}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
