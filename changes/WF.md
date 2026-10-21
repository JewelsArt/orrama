# WF: the watcher flake (STO-012 + new-folder-watch)

## Built
- Watcher reads the vault again after its folder set changes (`reconcileLater`/`reconcile`/`walkVault` in `apps/server/src/vaultStore.ts`), replacing `lookAgainLater`; raw handler also takes in a listed name the index lacks; new `test/watch-lost-events.test.ts` (the commit that adds this file)
- COR-017 test checks the `[[…]]` link, not the substring "jan" (commit 3315480)

## Root cause
The events were never late; they were lost. On macOS, Node's `fs.watch` (libuv) keeps **one FSEvents
stream per process** for every watched folder. Each time a folder watch is added or closed it destroys
the stream and starts a new one "since now", and whatever FSEvents had not yet delivered is dropped,
for every folder. chokidar watches each folder separately: it opens a watch per new folder (after
reading it) and closes one per folder that goes. The first stream also starts after chokidar's
`ready`. So:

- **path-identity (STO-012)**: the previous test's API write created `Personal/jules`; chokidar
  opened watches on `Personal` and `Personal/jules` at +1.107 s and +1.130 s, right as the test made
  `Notes` (system FSEvents log: +1.140 s). The test process never received `Notes`, nor the
  `brand new idea.md` rename from the same moment; the next root event was the next test's folder,
  27 s later. The 25 s wait then failed.
- **new-folder-watch**: `GapA` made 115 ms after `ready`, before libuv's stream existed; never delivered.
- Z's try (note on disk before boot) moved the same loss onto the rename right after boot.

How it was found: every `fs.watch` open/close/event in the test process was logged next to a separate
FSEvents logger (a small Swift program) during looped runs under load. Then it was reproduced alone.
At load ~40, opening and closing a watch on another folder 0 ms after a write lost 5 of 40 events
(20 ms: 1 of 40, 60 ms: 0). A fresh process lost what was written in the first 23–36 ms after its
first `fs.watch`. Not FSEvents coalescing, not `awaitWriteFinish` (unused), not fd limits (files use
kqueue, one fd each, limit 1,048,576), not shared watchers between test files (vitest forks).

**A user could hit it**: Orrama writing into a new folder (or Obsidian, or a sync, making or
removing one) while a note is created, renamed, moved or deleted elsewhere. The note stayed out of
the index, or under its old name, until something touched that folder again or the server restarted.

## The fix
- 1 s after `ready`, after any `addDir`/`unlinkDir`, and after it hands chokidar a folder, the store
  walks the vault (the boot walk, now `walkVault()`): listed notes the index lacks → settled as
  `add`; indexed notes no longer listed under that exact spelling → settled as `unlink`; folders
  chokidar doesn't know → `watcher.add`. All go through the existing 300 ms settle, which re-checks
  the disk. Debounced, at most 10 s late under a stream of folder changes. If any folder can't be
  read, nothing is dropped. A folder is handed to chokidar at most once until it reports it gone.
  Cost on the live vault (312 notes, 64 folders): 4–20 ms a walk.
- The raw-event handler also settles `add` for a name the folder lists exactly that the index lacks:
  after a repair chokidar's own picture of that folder is stale, and a case-only rename back reads to
  it as no change.
- `lookAgainLater` (the one-folder second look) is gone: the walk covers the same Linux gap.

## How verified
- Before/after, interleaved, 20 runs each of `path-identity.test.ts` + `new-folder-watch.test.ts`
  while the full server suite ran twice in parallel in a loop (plus other sessions' test runs;
  load 80–200 on 12 cores): **before: 4 of 20 failed (all STO-012's first step); after: 0 of 20**. In the load loops
  themselves (old code, full server suite, 22 runs) path-identity failed 6 times. Earlier
  baseline runs the same day: 3 of 12 (killed by another session's pkill), 3 of 14, and 6 of 11
  with tracing on.
- `watch-lost-events.test.ts` loses events on purpose (an `fs.watch` wrapper), on every platform.
  Sabotage, each red, restored byte-identically: no walk after ready; none on addDir/unlinkDir;
  removals despite an unreadable folder; no raw add; folders not handed to chokidar; walk takes
  nothing in; walk drops nothing. COR-017: Remove leaving a bare `[[Contacts/People/jan]]` turns
  line 147 red.
- `pnpm typecheck --force` and `pnpm test` green (one full run hit the pre-existing shutdown flake
  below; it passed 5 of 5 alone and the server suite then passed whole).

## Changelog lines (user-facing, for [Unreleased] → Fixed)
- A note created, renamed, moved or deleted outside Orrama at the moment a folder appeared or went
  anywhere in the vault (or just after the server started) could be missed until a restart. The
  vault is now read again a second after any such moment.

## CLAUDE.md changes to apply (exact text, and where)
- "The vault is a folder other editors share", after "…the chokidar watcher re-indexes them;": add
  "On macOS Node's fs.watch serves every folder from one FSEvents stream that it rebuilds, losing
  undelivered events, whenever a folder watch is added or closed — so 1 s after `ready` and after any
  folder appears or goes, `VaultStore.reconcileLater` walks the vault and settles what the events
  missed (`test/watch-lost-events.test.ts`). Never trust the watcher alone to have seen everything."

## Not done (and why) / needs Jules
- The handed-once guard (`handedDirs`) has no test: on macOS chokidar's `getWatched()` keys match
  `path.join`, so nothing triggers it without stubbing chokidar. It is a guard against a walk every
  second on a platform that spells paths differently; worth a look on the Windows CI run.
- The path-identity/new-folder-watch timeouts (25 s / 20 s) are unchanged; they could come down now,
  but a loaded runner still delivers real events slowly, and they cost nothing when green.
- A folder that becomes unreadable (chmod 000) still has its notes unlinked by chokidar itself
  (its failed re-read of the folder), as before this change.

## Seen under load, not mine, not fixed
In the old-code load loops (two full server suites in parallel in one checkout, load 100–180) these
also failed: `shutdown.test.ts` "SIGTERM to `pnpm start`" 4× (no "SIGTERM: closing" in its output in
time; once in my own `pnpm test` too), `ssrf.test.ts` "through the API" 4×, `cors-default.test.ts` 4×,
`webauthn-options.test.ts` "challenge rows" 1×. Not investigated; possibly the parallel runs sharing
a checkout. Worth their own look if CI ever shows them.

## Files touched outside my ownership
- `apps/server/test/project-sections.test.ts` (one assertion, COR-017, as the brief asked).
