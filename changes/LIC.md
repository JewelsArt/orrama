# LIC: Orrama's own licence replaces Apache 2.0

## Built
- `LICENSE` is a short proprietary notice now: copyright © 2026 Jules Timothy Sekelj, all rights reserved, use only under the Personal or Company licence, with links to both. `NOTICE` is rewritten too: Orrama, the copyright line, proprietary, and where both third-party notices files are. `docs/licence/PERSONAL.md` (free, one person's own use) and `docs/licence/COMPANY.md` (a named company and its Users, self-hosted, pilot clause, marked as a draft for a lawyer). Both are "not legal advice; drafted for review" (commit a46f80f)
- All nine `package.json` files are `"license": "UNLICENSED"` and `"private": true`. In `Cargo.toml` the licence line is gone and the crate is `publish = false`. `tauri.conf.json` has the bundle's `copyright`, and README's section is now "Licence" (commit a210c25)
- Every web build also writes `dist/THIRD_PARTY_NOTICES_SERVER.txt`: every production dependency of `apps/server` and `apps/mcp` (376 package versions), walked through `node_modules` (`productionPackages` in `apps/web/licenses.ts`). It is part of the existing vite plugin, so `pnpm ship`, the Docker image and CI all write it with no extra step. There is also a licence guard (`licenceProblem`, `ALLOWED_LICENCES`, `ALLOWED_BY_NAME`). `licenses.test.ts` walks every workspace's production dependencies (438 versions, the same count `pnpm licenses list --prod` gives) and fails on any licence outside the allowlist, naming the package. The same test checks that every package is private and UNLICENSED, and that LICENSE, NOTICE and Cargo.toml say what they should. To sabotage-check it I added a fake `fake-gpl@1.0.0` (GPL-3.0-only) to the server: red. sab.py L1–L8 were all red too (commit a361e7f)
- The header comment in `apps/server/src/chatgpt.ts` now says who may use the ChatGPT plan: OpenAI allows open-source projects, personal local projects and selected private apps. That covers Jules's own copy, and other people only once OpenAI accepts Orrama (commit 5e4b5d7)
- Outside the repo: `~/orrama-next/openai-application.md` (the application to OpenAI, for Jules to send through openai.com/form/sign-in-with-chatgpt-interest/) and `~/orrama-next/stanislas-message.md`

## Audit tickets fixed
- none

## Changelog lines (user-facing, for [Unreleased] → Changed / Added / Fixed / Removed)
- Changed: Orrama is no longer open source. It is proprietary (copyright Jules Timothy Sekelj, all rights reserved) and used under the free Personal licence or the Company licence (`docs/licence/`). The Apache 2.0 licence no longer applies.
- Added: the build writes `THIRD_PARTY_NOTICES_SERVER.txt` next to the web app's notices: every package the server and the MCP server run on, with its licence text.

## CLAUDE.md changes to apply (exact text, and where)
- **"The agent's model"**, replace the sentence `OpenAI offers this to open-source and locally run apps. Its rules shape the code:` with:
  > OpenAI offers ChatGPT plan usage to open-source projects, personal projects that run locally and selected private apps. Orrama is proprietary, so it covers Jules's own copy and nobody else's until OpenAI accepts Orrama's application (sent by Jules, 16 Oct 2026); other people paste a key. Its rules shape the code:
- **Same section**, replace the bullet `Tool calling is not in OpenAI's docs for this flow; the Ask agent's tools are sent and it is unverified until a real account signs in.` with:
  > OpenAI's preview limitations (developers.openai.com/siwc) list function and custom tools as supported, and `temperature`, `top_p`, `user`, `metadata` and `truncation` as refused. The Ask agent's tools are sent, still unverified until a real account signs in.
- **New section after "Releases"** (after its "Dependencies are audited" paragraph):
  > ## Licence
  >
  > Orrama is proprietary: copyright © 2026 Jules Timothy Sekelj, all rights reserved, not open source (since 16 October 2026). `LICENSE` is the notice, and people use the app under the free **Personal licence** (`docs/licence/PERSONAL.md`, one person's own use) or the **Company licence** (`docs/licence/COMPANY.md`, a named company and its Users, self-hosted, with a pilot clause; a draft until a lawyer has read it). Every `package.json` is `"license": "UNLICENSED"` and `"private": true`. Nothing written in the repo may call Orrama open source.
  >
  > **Never add a copyleft dependency** (GPL, AGPL, LGPL, SSPL, MPL, EUPL and the like, unless dual-licensed with an allowed licence). `apps/web/src/licenses.test.ts` walks every workspace package's production dependencies (`productionPackages`, `apps/web/licenses.ts`) and fails on any licence outside `ALLOWED_LICENCES` (MIT, ISC, Apache-2.0, BSD-2/3-Clause, BlueOak-1.0.0, 0BSD, MIT-0, Zlib, Unlicense, Python-2.0, CC0-1.0, or a dual licence with one of them). A package whose `package.json` states no readable licence is checked by hand and added to `ALLOWED_BY_NAME` by name and version, with the reason. Today that means `duck@0.1.12` ("BSD", whose file is 2-clause) and `buffers@0.1.1` (no licence stated, reached through exceljs). Every web build writes the third-party notices: `dist/THIRD_PARTY_NOTICES.txt` for the bundle and `dist/THIRD_PARTY_NOTICES_SERVER.txt` for the server's and the MCP server's `node_modules`.

## Board vs app: differences left on purpose
- none (no screens touched)

## Not done (and why) / needs Jules
- **Placeholders in both licences, for Jules:** governing law and courts (`[COUNTRY]`, `[CITY]`), a contact address, and the Company licence's liability cap during a free pilot (`€[AMOUNT]`). The Company licence should also be read by a lawyer before anyone pays (the plan says so too).
- **Personal licence scope, Jules's call:** as drafted, it covers "your own life and your own work". A freelancer working alone qualifies, and a company with several people needs the Company licence. If Personal should mean non-work use only, change §2.
- **`buffers@0.1.1` has no licence at all.** No field, no file, and its repository is deleted. It is allowed by name as MIT-in-practice: every sibling by the same author is MIT, and it is only reached through exceljs → unzipper@0.10 → binary. The clean fix is a follow-up: get rid of it (an exceljs release on unzipper ≥ 0.12, which dropped `binary`, or a pnpm override of unzipper, tested against the .xlsx statement and document readers).
- **Stage 2 (for the integrator to carry into its prompt):** (1) the first run hides "Sign in with ChatGPT" from everyone but Jules's existing install until OpenAI accepts Orrama. (2) Once the server's `node_modules` go inside the desktop app, ship `THIRD_PARTY_NOTICES_SERVER.txt` with it (it is already in `apps/web/dist`). (3) The Rust crates the Tauri shell compiles in need their notices too (e.g. `cargo about`), which nothing covers yet. (4) The installers should show the Personal licence (Tauri's `bundle.licenseFile`) once its placeholders are filled in.
- **Stanislas:** after the history rewrite the repository shows one commit by him (6ca7569, the audit on 2 October, `docs/audit/` only), not two. The message draft says so.
- **OpenAI:** Jules sends `~/orrama-next/openai-application.md` himself. It has two blanks (email, country).
- **CLAUDE.md:** besides the Licence section, the ChatGPT preview limitations list `temperature`, `top_p`, `user`, `metadata` and `truncation` as refused. I didn't check whether the AI SDK sends any of them for the chatgpt provider.

## Files touched outside my ownership
- `apps/web/src/licenses.test.ts` (the existing notices test, extended; the prompt's "the new notices script and its test")
- none else
