// router: moves this tab to another screen of its app, by its address's hash (services/router.ts).

export default () => ({
  go: (path: unknown, replace: unknown) => {
    const url = new URL(location.href);
    url.hash = String(path);
    if (replace) location.replace(url);
    else location.assign(url);
  },
});
