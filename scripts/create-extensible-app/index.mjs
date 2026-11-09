#!/usr/bin/env node
// `npm create extensible-app my-app`: the npm package for the create command.
//
// It holds no copy of the platform. It runs the repo's own create command,
// scripts/create-app.mjs, straight from GitHub, so a new project always starts
// from the platform as it is on main (as a dependency of the project, not a
// copy), and this package never needs a new version for it:
//
//   npm create extensible-app packing-list                    is the same as
//   npx github:PaulKinlan/ExtensibleWebApps packing-list
//
// Every argument is passed on (--name "Packing list", --no-install, --platform <dependency>).
// CREATE_EXTENSIBLE_APP_FROM names another source, such as a local folder or
// tarball, for trying a change before it is on GitHub.
//
// It runs npm's own script with Node, with the arguments as a list, so no
// shell reads them on any system. Publish from this folder: `npm publish`.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const FROM = process.env.CREATE_EXTENSIBLE_APP_FROM || "github:PaulKinlan/ExtensibleWebApps";
const args = process.argv.slice(2);
const exec = ["--yes", "--package", FROM, "--", "create-extensible-app", ...args];

// npm sets npm_execpath to its own script (npm-cli.js, or npx-cli.js under npx) for whatever it runs.
const cli = process.env.npm_execpath ?? "";
const result = /\.[cm]?js$/.test(cli)
  ? spawnSync(process.execPath, [cli, ...(basename(cli).startsWith("npx") ? [] : ["exec"]), ...exec], { stdio: "inherit" })
  : process.platform === "win32"
    ? spawnSync("npm.cmd", ["exec", ...exec].map((a) => (/[\s"&|<>^]/.test(a) ? JSON.stringify(a) : a)), { stdio: "inherit", shell: true })
    : spawnSync("npm", ["exec", ...exec], { stdio: "inherit" });

if (result.error) console.error(`Couldn't run npm: ${result.error.message}`);
process.exit(result.status ?? 1);
