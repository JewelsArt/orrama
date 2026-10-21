# BR: the Bearer session path goes; the MCP SDK past its advisories (wave S1-prep)

## Built
- A session is the cookie only. `authenticate` (main.ts) no longer reads a session JWT from `Authorization: Bearer`, so every session write now passes the Origin check (`fromOwnSite`). `POST /api/auth/exchange` (routes/auth.ts) and `rekeySession` (sessions.ts) are removed, and so are `adoptStoredSession` and `LEGACY_TOKEN_KEY` (api.ts) and the boot trade in App.tsx. `migrateLegacyKeys` (storage.ts) now deletes a leftover `orrama-token` / `basalt-token` without moving or sending it. `bslt_` API tokens are unchanged. (commit e0d65dd)
- `@modelcontextprotocol/sdk` ^1.31.0 → ^1.32.1 in apps/mcp, past GHSA-22jm-h49p-29qw and GHSA-46jr-4wx8-v453 (high) and two moderate ones. No code change was needed. `pnpm audit --prod --audit-level=high` exits 0. (commit b9b2983)

## Verification
- `pnpm typecheck --force` clean at each commit. Full `pnpm test` green at the tip (mcp 40, core 528, sync 33, web 873, server 928). The 6 sabotages in e0d65dd were all RED.
- Each commit was also checked alone with verify.sh at load ~100. Typecheck was clean every time. 1–3 server tests timed out, and they differed per run: shutdown, cors-default, path-identity/STO-012 (WF's flake). The notes-only commit failed too, so this is load. Re-run alone at lower load: all pass.

## Audit tickets fixed
- None by id (follow-up to WEB-013, as W13's notes planned).

## Changelog lines (user-facing, for [Unreleased])
- Removed: The one-time move of an old sign-in into the secure cookie (from the 16 October release). A browser, window or phone not opened since then asks you to sign in again. A sign-in token left in its storage is deleted, never sent.
- Fixed: The MCP server is on a version of the MCP SDK with no known high advisories (CI's dependency audit is green again).
- Also, in the 16 Oct "Upgrading" note ("The next release stops accepting a session token sent as `Bearer` …"): this is that release. Keep the sentence under this version's Upgrading, or point to it.

## CLAUDE.md changes to apply (exact text, and where)

1. Conventions & gotchas, paragraph **"A session is a row, not just a signature"**: replace
   "For this release only, a session token sent as `Bearer` is still accepted and `POST /api/auth/exchange` trades one (kept in `orrama-token` by the app before the cookie) for the cookie once (`adoptStoredSession` at boot); both go in the next stage."
   with:

   A session is never read from `Authorization: Bearer`: that header carries
   API tokens only, and a session token sent that way is refused (401).

2. Conventions & gotchas, **"Storage"**: replace
   "the token the app kept before it is traded once at boot and deleted (`adoptStoredSession`)."
   with:

   the token the app kept before it (`orrama-token`, `basalt-token`) is
   deleted by `migrateLegacyKeys()`, never sent.

## Board vs app: differences left on purpose
- None. No screen changed.

## Not done (and why) / needs Jules
- **The vault's `.mcp.json` "invalid API token" (20 Oct) is not a bug in apps/mcp.** Its `ORRAMA_TOKEN` is the literal placeholder `bslt_your_api_token_here`. It was written by the boot writer that existed before AI-013 (0355c4f, 11 Oct: the server writes nothing into the vault now). On 15 Oct R13's switchover script (`~/.orrama-switchover-backup/R13-switchover.py --vault-mcp`) renamed its keys to ORRAMA_* but kept the placeholder value, and the backup copy there shows the same placeholder. apps/mcp never writes any file; it only reads `ORRAMA_URL`/`ORRAMA_TOKEN`. The working registration is local-scope in `~/.claude.json` for the project `/Users/jules/basalt` only. So a Claude session opened in `~/Orrama Vault` loads the vault's project-scope `orrama` server with the placeholder, and every call is a 401. Fix for Jules (vault, not done here): delete `~/Orrama Vault/.mcp.json`, as apps/mcp/README.md says, and register the server at user scope with a real token (`claude mcp add orrama --scope user …`), so it works from any folder. The file is git-ignored in the vault backup.
- The dev-server smoke test ran on **:4691**, not :4627: :4627 was held by the online-CV static server (`python3 -m http.server 4627 --directory ~/online-cv`).
- **Incident, 11:57:37:** `pkill -f "tsx src/main.ts --dev" -U jules` (stopping my scratch server). macOS pkill read `-U` and `jules` as extra patterns and sent SIGTERM to every process with "jules" in its command line. The live :4623 closed cleanly and launchd restarted it at 11:57:45 from the same checkout, on the same build. The online-CV server on :4627 is gone and was not restarted. Sibling test runs and scratch servers running then were killed; WF, RACE and agpl were told. Note in the side-session notes folder: `BR-pkill-incident.md`.
- After ship: a browser, desktop window or phone not opened since 16 Oct shows the sign-in screen once.

## Files touched outside my ownership
- `apps/web/src/door/app-door.dom.test.tsx`, `apps/web/src/storage.dom.test.tsx`, `apps/web/src/storage-migration.dom.test.tsx`, `apps/web/src/session-ended.test.ts`: only the tests of the removed trade (RACE works on web DOM tests, so expect small conflicts in app-door/storage DOM tests).
- `apps/server/test/contract.test.ts`: the exchange row is removed.
- `apps/web/src/App.tsx`: one hunk at boot (`api<Me>("GET", "/api/me")` directly).
