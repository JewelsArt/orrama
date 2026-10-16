# WIN2 — Windows green again after the rename, and two flaky Mac/Linux tests

## Fixed
- Windows, `apps/server/test/entry.test.ts` EBUSY in afterAll: the test waits for the killed
  server to exit, and the folder delete retries (commit 5be60f2)
- Windows, `env.test.ts` "the server itself refuses to boot on it" and `renamed-env.test.ts`
  "the server and every script refuse to start on a half-done switch" timed out at 5 s: they
  get 30 s and 120 s (spawns capped at 20 s), and the MCP twin gets 30 s (commit 89ee332)
- macOS, unhandled happy-dom `NetworkError` on `/api/finance/month/2026-09`: every DOM test
  file unmounts before it un-stubs globals, held by `src/test/dom-hooks.test.ts` (commit 226c544)
- macOS, App.dom.test "toasts show in the app": expected '' to contain 'Moved to Friday'. The
  test now waits for the toast (commit 9fad8e6)
- macOS, server `path-identity` "a name stored decomposed (NFD) is reached by its composed
  (NFC) spelling" failed 2 of 5 full `pnpm test` runs here. It waited up to 25 s for the watcher
  to index a file it had just written. With every package's tests running at once, macOS
  delivered that event more than 25 s late, during the next test. The file is now on disk
  before boot, so the first index holds it. The test is about the write, not the watcher, and
  other tests cover the watcher (the last commit)

All four are test-only. No app code changed.

## Changelog lines (user-facing, for [Unreleased] → Internal)
- The test suite is green on Windows again after the rename. A test that starts the server
  waits for it to exit before deleting its folder, and tests that start processes through tsx
  have timeouts that fit them.
- Two flaky web tests on macOS fixed. DOM tests unmount the page before they un-stub fetch, so
  a late request can't reach the real network. The toast test waits for the toast.

## CLAUDE.md changes to apply (exact text, and where)
- Conventions & gotchas → "The suite runs on macOS, Linux and Windows", after "close every
  database handle before deleting its folder (…)": add
  "; a test that starts a process kills it and awaits its `exit` before the folder goes
  (Windows keeps a dying process's files open), and one that starts processes through tsx
  gets a timeout that fits them (a Windows runner takes 2–3 times as long as a Mac)".
- Conventions & gotchas → "Web tests", at the end: add
  "dom-setup's `cleanup()` runs after each file's own afterEach, so a file that un-stubs fetch
  or another global there calls `cleanup()` first (`src/test/dom-hooks.test.ts`). What an
  effect puts on screen (a toast, a request's answer) is found with `findBy…`, never read at
  once after the view appears."

## Not fixed (and why) / needs Jules
- **Windows CI not run yet.** It needs the branch pushed. After the integrator pushes, Jules
  dispatches `gh workflow run Windows --ref <branch> -R JewelsArt/Basalt-backup`. The EBUSY
  can't be reproduced on a Mac, so the entry-test fix is checked by its assertion and by
  reasoning only, until that run.
- **Latent races of the toast kind, in tests CI has not failed yet.** A scratch run of the DOM
  suite with React's scheduler slowed found 12 more tests that read synchronously what an effect
  renders. They pass at normal speed. The setup: a setup file loaded before dom-setup.ts that
  sets `globalThis.setImmediate = (fn, ...a) => setTimeout(fn, 30, ...a)` and
  `globalThis.MessageChannel = undefined`, in a config with environment happy-dom. The tests:
  - EntityPage.dom: "relates in words, both directions…", "says how you know them…", "lists
    what is going on with them…", "shows the note in the editor, below", "a conversation is its
    turns…", "a note that is a document…"
  - App.dom: "on the phone, More holds the other places…", "shows the update note after a
    ship…", "the theme (§9) … the rail's button stops matching…"
  - Lock: "sends a passcode typed on the keyboard once…"
  - Orr noticed: "a project with no status picks one of the seven words", "shows the graph at
    a glance…"
  - NameDialog: "a refusal is said under the field…"

  Some may only fail at that extreme delay. Each wants a look in its own change, so they were
  left alone here.
- Server `new-folder-watch` timing under load: not looked at, as the prompt allows. It did not
  fail in any of the runs here.

## Files touched outside my ownership
- W13 owns the tests of `ws.ts`, `storage.ts` and `door/`. I changed only the `afterEach`
  hook (and the `cleanup` import) in `ws.dom.test.tsx`, `storage.dom.test.tsx` and
  `door/door.dom.test.tsx`. If W13 rewrote those hooks, keep `cleanup()` first in them;
  `dom-hooks.test.ts` will say if it went missing.
- The rest are tests no stage-0 prompt claims: `apps/server/test/{entry,env,renamed-env}.test.ts`,
  `apps/mcp/test/env.test.ts`, the web DOM tests for App, Finance, Mail, Settings, Today,
  People and `ui/writes`, a comment in `apps/web/src/test/dom-setup.ts`, and the new
  `apps/web/src/test/dom-hooks.test.ts`.
