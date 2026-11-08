// router: moves this tab to another screen of its app, without loading the page (../router.ts).

import { go } from "../router";

export default () => ({
  go: (path: unknown, replace: unknown) => go(String(path), !!replace),
});
