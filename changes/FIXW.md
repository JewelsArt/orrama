# FIXW: the two red Windows checks
## Built
- `safe-regex.test.ts` judges linear time by growth between two text sizes, with a short-text check for exponential time, instead of one 200 ms limit (commit b2d34d0)
- `install-check.mjs` writes and reads its Credential Manager stand-in through CredWriteW/CredReadW (`scripts/windows-credential.mjs`), prints cmdkey's view, and waits for the hook, which runs after the data folder has gone (commit 42d2274)
## Audit tickets fixed
- none
## Changelog lines (user-facing, for [Unreleased] → Changed / Added / Fixed / Removed)
- none (CI and test code only)
## CLAUDE.md changes to apply (exact text, and where)
- none
## Board vs app: differences left on purpose
- none
## Not done (and why) / needs Jules
- The cause of cmdkey's silence is not established. The check now prints cmdkey's `/list:` output beside the API's answer, so the release run's log shows whether cmdkey's list sees an entry the API wrote.
- Tagged releases still need the updater secrets (going-public step 7).
## Files touched outside my ownership
- none (`scripts/install-check.mjs`, `scripts/windows-credential.mjs`, `apps/server/test/uninstall.test.ts`, `packages/core/test/safe-regex.test.ts`)
