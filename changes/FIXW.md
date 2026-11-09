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
- Why cmdkey failed: run 42653923826 shows `cmdkey /list:<target>` answering "The command line parameters are incorrect." with exit 0. Node quotes the whole argument because the target has a space, and cmdkey refuses that form. So the old check's list could never see the entry, and exit 0 hid it.
- That means the cmdkey line the check prints only shows the usage text. It is harmless and could be removed; left in because the scripts are what the release run proved.
- Release run 42653923826 (031fe3a, draft `v0.1.0-test.4`, never publish) printed the data folder gone, the entry gone, the notes kept and "Install check passed.". Later commits change only `uninstall.test.ts` and this file.
- Tagged releases still need the updater secrets (going-public step 7).
## Files touched outside my ownership
- none (`scripts/install-check.mjs`, `scripts/windows-credential.mjs`, `apps/server/test/uninstall.test.ts`, `packages/core/test/safe-regex.test.ts`)
