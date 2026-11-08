// A plugin's manifest names the services it calls that not every site runs
// (`services`, docs/layers.md). One that names a service this site doesn't run
// isn't started, and says which is missing: an app fails when it opens, not
// on its first call.

export default async function ({ a, check }) {
  const install = (src) => a.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => a.evaluate((id) => window.__host.command("uninstall", id), id).catch(() => {});

  const missing = await install(`export const manifest = { id: 'needs-mail', name: 'Needs mail', permissions: [], services: ['debug', 'carrier-pigeon'] };
export default () => {};`);
  check("a plugin that needs a service the site doesn't run is refused", missing.ok === false, JSON.stringify(missing));
  check("the refusal names the missing service and where to add it", /carrier-pigeon/.test(missing.error ?? "") && !/debug/.test(missing.error ?? "") && /kernel\.json/.test(missing.error ?? ""), missing.error);

  const bad = await install(`export const manifest = { id: 'bad-services', name: 'Bad services', permissions: [], services: 'debug' };
export default () => {};`);
  check("`services` must be a list of names", bad.ok === false && /services/.test(bad.error ?? ""), bad.error);

  try {
    const fine = await install(`export const manifest = { id: 'needs-debug', name: 'Needs debug', permissions: [], services: ['debug'] };
export default () => {};`);
    check("a plugin whose services the site runs is installed", fine.ok === true, JSON.stringify(fine));
  } finally {
    await uninstall("needs-debug");
  }
}
