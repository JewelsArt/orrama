# RACE: web tests that read what an effect renders before it has run

Prompt: `~/orrama-next/build/0D-effect-races.md`, wave S1-prep, branch `stage1/RACE-effect-races` from
`sep-2026-redesign` = 83c5506. Tests only plus two small app fixes. No browser, no server, no data.

## Built
- The account's appearance is applied in a layout effect, so a theme or look picked in the first
  moment is not undone (commit ca5d9fb). App race.
- Lock subscribes its keyboard listener in a layout effect, so digits typed as the keypad appears
  are not dropped (commit 37ce56a). App race.
- EntityPage.dom: tests find what they are about, and the fixed 8 ticks are gone (commit 8d17db0)
- Noticed.dom: `show()` waits for the page's Loading placeholders to go, not 6 ticks (commit cab1fc2)
- NameDialog.dom: the refusal test waits for the alert (commit b785795)
- Orrery.dom: one `laidOut()` helper with a 5 s timeout for the cold first layout (commit a688a15)
- `pnpm --dir apps/web test:slow`: the DOM tests with React's scheduler 30 ms late
  (`src/test/slow-scheduler.ts`, `vitest.slow.config.ts`), kept on Jules's say-so (the commit with this file)

## What the sweep found, and which side was wrong

WIN2 listed 13 tests. The sweep on 83c5506 found 20, because tests had been added since (Clay,
theme). One whole-suite run also found a load timeout in Orrery.

| Test | Sweep's failure | Wrong side | Commit |
|---|---|---|---|
| App · theme · the look is the account's: Clay … | expected 'paper' to be 'clay' (orrama-look) | **app**: hydration undid the click | ca5d9fb |
| App · theme · Paper: the rail's sun and moon … | expected [] to include 'command' (no PATCH) | **app**, same | ca5d9fb |
| App · theme · on a device matching its system, picking day or night … stops matching | expected 'command' to be 'light' (orrama-theme) | **app**, same | ca5d9fb |
| App · theme · Dark is the account's … | expected [] to include 'command' | **app**, same | ca5d9fb |
| App · shell · on the phone, More holds the other places … | no dialog "More" | **app**, same cause: Shell's mount effect `setMore(false)` was still pending and undid the click | ca5d9fb |
| App · shell · shows the update note after a ship … | no "Update ready" | **app**, same cause: the first health check ran after the ship | ca5d9fb |
| Lock · sends a passcode typed on the keyboard once … | no role=alert (nothing posted) | **app**: keys went to the stale listener (`methods` null) | 37ce56a |
| EntityPage · says who they are … | no "Last in touch" | test read too early | 8d17db0 |
| EntityPage · relates in words, both directions … | no "supervises" row | test | 8d17db0 |
| EntityPage · says how you know them … | no region "How you know Ines Vermaat" | test | 8d17db0 |
| EntityPage · lists what is going on with them … | no region "With Ines" | test | 8d17db0 |
| EntityPage · shows the note in the editor, below | no region "The note" | test | 8d17db0 |
| EntityPage · on a vault without an ontology · plain links … | no region "How Ines relates" | test | 8d17db0 |
| EntityPage · a conversation is its turns … | no region "The conversation" | test | 8d17db0 |
| EntityPage · a note that is a document … | no "part of" row | test | 8d17db0 |
| Noticed · says each warning as a sentence … | no list "What needs a look" | test | cab1fc2 |
| Noticed · a project with no status picks one of the seven words | same | test | cab1fc2 |
| Noticed · a tag naming a project with no note … | same | test | cab1fc2 |
| Noticed · on a vault without an ontology … | no "no ontology" text | test | cab1fc2 |
| Noticed · shows the graph at a glance … (WIN2's run) | same kind | test | cab1fc2 |
| NameDialog · a refusal is said under the field … | no role=alert | test: the refusal comes from onSubmit's promise | b785795 |
| Orrery · the whole vault · reads the notes … | no "16 files" after 1205 ms | test: not a race, the cold layout ran past findBy's 1 s | a688a15 |

Each app fix was reverted under the sweep, and its tests went red: App 6 failed, Lock 1 failed.
Each test fix was sabotage-checked at normal speed by breaking what the test is about, and every
one went red: 8 EntityPage sabotages, Noticed (warnings never answer), NameDialog (the error never
set), Orrery (never laid out).

The sweep's "ReferenceError: window is not defined" (WIN2 saw it from EntityPage, this sweep from
Noticed) is an artifact of the delay. The last unmount's scheduler task lands after happy-dom is
torn down. `slow-scheduler.ts` waits 100 ms after each file, which removes it. It is not a test bug.

Verified: `pnpm --dir apps/web test:slow` 470/470 with no unhandled errors, several runs.
`pnpm typecheck --force` and `pnpm lint` green. `pnpm test`: web 876/876 in three runs in a row.
The server failures in those runs were not this branch's: path-identity STO-012 (WF's flake, runs 1
and 2); plan-estimate-cache "answers without waiting for a slow model" (run 1, a fixed 200 ms
sleep, see below); and codebase-graph, which only saw a scratch file of mine that is gone now.

## Changelog lines (user-facing, for [Unreleased])
- Fixed: picking day or night, or Paper or Clay, right after the app opens is no longer undone.
  Before, the page showed your choice but your account and the next load kept the old one.
- Fixed: on the lock screen, digits typed on the keyboard the moment the keypad appears are no
  longer lost.
- Internal: DOM tests find what an effect renders instead of reading it at once.
  `pnpm --dir apps/web test:slow` runs them with React's scheduler late, as on a loaded runner.

## CLAUDE.md changes to apply (exact text, and where)
- Conventions & gotchas → "Web tests", replace its last sentence ("What an effect puts on screen (a
  toast, a request's answer) is found with `findBy…`, never read at once after the view appears.")
  with:
  "What an effect puts on screen (a toast, a request's answer, a refusal) is found with `findBy…`
  or `waitFor` on that thing, never read at once after the view appears and never after a fixed
  number of ticks; an absence is checked after a positive find from the same answer. Check a new
  DOM test with `pnpm --dir apps/web test:slow` (React's scheduler 30 ms late,
  `src/test/slow-scheduler.ts`; not in CI): it must pass there too. In the app, state the account
  hydrates and a window listener that must be current while what it serves is on screen go in a
  `useLayoutEffect` (App's appearance, Lock's keys): a passive effect can run after the first click."
- Dev loop code block, after the `pnpm test` line, add:
  `pnpm --dir apps/web test:slow     # DOM tests with React's scheduler late: run it on a new DOM test`

## Board vs app: differences left on purpose
- None. No screen changed.

## Not done (and why) / needs Jules
- Jules's answer on the sweep (21 Oct): **keep it in the repo**, as `test:slow`.
- Shell's `useEffect(() => setMore(false), [route])` ("going somewhere from More closes it") is
  the same effect-resets-state pattern. Its race is no longer reachable from sign-in, since the
  layout-effect hydration flushes it in the same commit, so it was left alone. A small follow-up
  could make More belong to the route it was opened on, with no effect.
- App · "shows the update note after a ship" still waits one fixed tick for the first health
  check. It passes under the sweep now, so it was left as it is.
- Server, not in my files: `apps/server/test/plan-estimate-cache.test.ts:133` sleeps a fixed 200 ms
  and failed once under load ("expected [] to have a length of 1"). Same kind of flake as WF's
  watcher tests, for a later chat.

## Files touched outside my ownership
- `apps/web/src/App.tsx` (the hydration effect only) and `apps/web/src/Lock.tsx` (the key
  listener only): the components the races were in.
- `apps/web/package.json` (the `test:slow` script) and `apps/web/tsconfig.json` (includes
  `vitest.slow.config.ts`).
- The integrator: add `RACE 0D-effect-races.md` to the wave's row in Z if it isn't there.
