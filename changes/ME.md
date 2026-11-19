# ME: the Me page (persona)

Brief: `~/orrama-next/build/ME-page.md` (mockup approved by Jules 5 Nov 2026). Branch
`feat/ME-page` from `3f735ab` (stage 2 done, schema 6). No schema change.

## Built
- Core reads the persona note (`packages/core/src/persona.ts`): every section by heading, lenient
  (missing section empty, unknown ignored, code skipped, bad rows named in `unread`, never throws),
  periods ("Jan–Jun 2025", "Jul 2026–now", "Spring 2026"), lists matched to the exact names of the
  other tables (commas inside names kept), proof points' sources, open questions with their
  `**or**` options and written answers; `answerQuestion`, `personaText`, `unsourcedNumbers`,
  `blankPersona`. The links and the timeline are pure in `personaGraph.ts` (`personaGraph`,
  `storyOf`), exported as `@orrama/core/persona-graph` so the web bundle doesn't carry the note
  parser and YAML. (commit 505e96d, plus the split in the web commit)
- Server (`routes/persona.ts`, `src/persona.ts`): `GET /api/persona` (the note read, or the empty
  page's counts), `GET /api/persona/text` (sections as Markdown), `POST /blank`, `/answer`,
  `/write` (Introduce me / Write as me from the persona alone; flags any number the note doesn't
  hold), Generate my persona as a job (`POST/GET/DELETE /api/persona/generate`, `/stop`,
  `/api/persona/accept`). (c493fed)
- Orr uses it: `get_persona` in the agent and MCP (29 tools now); `draft_email` in both answers its
  first call with the Voice and Rules for outside use when there is a persona, and stages the draft
  on a second call with `voiceRead: true`. A persona's Voice and Rules are standing instructions:
  `agentWrites.ts` refuses the agent and API tokens a change to them. (c493fed)
- The page: `/me`, `/me/story|work|skills|voice` (`Me.tsx`, `me/`, `styles/me.css`). Overview as the
  mockup: header (your Orr in an orange ring, Now as lane-coloured chips that open their place,
  Introduce me, Write as me, ⋯ Edit the note), the story (lanes Study/Work/Built in --c1/--c2/--c4,
  bars by date, years weighted by what happened, Now in --sun, labels inside → the place alone →
  beside → cut with a tooltip, measured after layout and on resize, sideways scroll opening on now
  under 820/760 px with lane names pinned), In short as Clay's hero (length × language, Copy, Use in
  an email), proof points as tiles (lane wash, CountUp), Check with you, Skills with orange bars,
  Who vouches, the footer link to the note. Click anything → the panel (trail, Back, Esc); point at
  anything → what it connects to lights, the rest fades. Story/Work/Skills/Voice tabs. Introduce me
  (Dialog) and Write as me (panel) → "Open in Mail" hands the draft to the composer (in memory,
  never in the address). Empty state: Generate my persona with source switches and real counts, the
  two requirement lines with their fixes, Start from a blank one, the steps with Stop, a toast when
  done if you left the page, Review the draft (the page on the draft, Keep it / Start again).
  (web commit)
- Entry points: the account at the rail's foot (Paper) and Clay's chip are a menu: Your page,
  Settings (⌘, still goes straight to Settings); "Your page" row in the phone's More; "You" as
  People's first row (hidden while searching). The page lights People in the rail. (web commit)
- Ask Orr can open with a question typed in (not sent): "Talk it over with Orr" on an open
  question. (web commit)

## Decisions (mine, inside the brief; none was taste enough to ask Jules)
- **Per account** (Control's answer): the persona is a `#persona` note the account can edit, never
  in another account's Personal folder, and not one another (non-owner) account could read unless
  it's in the account's own Personal folder — calendarNotes.ts's ACL-009 rule, ranked like the
  finance ledgers. On Jules's one-account install that is `01-Me/persona-data.md` (checked: his
  November calendar note is in `01-Me/Calendar`, which the same rule puts there). In the seed every
  team can read the top folder, so a seeded account's persona lives in `Personal/<name>/`.
- **Paper's entry** (Control's answer): the avatar at the rail's foot became a two-item menu.
- **"Never invent a number"** is enforced, not only asked: Write as me/Introduce me return
  `unsourced` and the page says "Check before sending: 8.7 isn't in your persona note"; Generate
  drops a proof point whose number no source holds and asks about it in Check with you.
- **draft_email reads the voice** by refusing its first call with the voice and rules (both the
  agent and MCP): the only way to know a model read them before writing. One extra model round trip
  per mail, only when a persona exists.
- **Check with you answers** go on the question's own line (`**Answer (2026-11-19):** …`), so the
  note keeps question, answer and date, and the page stops asking. Options come from `**or**`.
- **Generate's threshold**: 3 projects or 20 notes, counted over the switched-on sources.
- **Private notes**: a note whose path or tags say finance/money/bank/salary/income/health/
  medical/family/address (and the finance ledger tags) is never read by Generate.
- **Write as me** is a panel that drafts with AI, then hands the text to Mail's composer; the
  composer itself has no AI (none existed) and was not given one.
- A year-only period runs Jan–Dec ("2021–2022" overlaps "2022–2027" in 2022), so those bars sit
  in two rows; months, when the note gives them, are exact.

## Changelog lines
- Added: Your page (`/me`): who you are, from one note tagged #persona — your story on a timeline,
  your pitch at three lengths, proof points, skills, the people who vouch, and what Orr still needs
  to check with you. Everything opens beside the page and lights what it connects to.
- Added: Introduce me and Write as me: Orr writes from your persona only, in your voice, and says
  when a number isn't in your note. Open in Mail puts the draft in the composer.
- Added: Generate my persona (needs AI and something to read) and Start from a blank one.
- Added: MCP and Ask Orr read your persona (`get_persona`); a mail Orr or Claude drafts as you
  reads your Voice and Rules first. Agents and API tokens can't change those two sections.
- Changed: your Orr in the rail (and Clay's account chip) is a menu: Your page, Settings. People
  starts with you.

## CLAUDE.md changes to apply
- Layout table, `apps/server/src/routes/`: add "persona (the Me page: the note read, an answer,
  Introduce me / Write as me, Generate my persona; which note in `src/persona.ts`)".
- Layout table, `packages/core/src/`: a row "`persona.ts` / `personaGraph.ts` | The Me page's
  note read leniently by heading; its links and timeline (pure, `@orrama/core/persona-graph`)".
- Layout table, `apps/web/src/`: add "`Me` (Your page, `/me`, `/me/<tab>`: `Me.tsx` holds the state
  and every request; the pieces in `me/`)" to the screens list.
- "Standing instructions are the user's": add "and a `#persona` note's `## Voice` and `## Rules for
  outside use`".
- "The agent can draft mail, never send it": add "With a persona, `draft_email` (agent and MCP)
  answers its first call with the Voice and Rules instead of drafting; the draft is staged on a
  second call with `voiceRead: true`."
- New short section after "The project workspace is the note": "**Your page is a note too** (ME):
  `/me` reads the account's `#persona` note (`src/persona.ts` decides which); Edit opens it,
  answers are written onto their question's line, Generate's draft is written only when kept.
  Numbers Orr writes as you must be in the note (`unsourcedNumbers`)."
- `test/bundle.test.ts` and the README now say 29 MCP tools.

## Board vs app: differences left on purpose
- No photo: the account has none, so the header shows your Orr in the orange ring.
- No thesis progress bar under the name (the mockup's "47% · 74 days to 18 Jan"): nothing ties a
  persona row to a board project yet. Left out rather than invented.
- "Sent mail" is not among Generate's sources: the mail code reads the inbox only; reading Sent is
  its own job (IMAP special-use folder) and can't be tested without a live account.
- The mockup's "Mockup: show the page when" bar is not built (it was the mockup's switch).
- A bar too short for "Place · Role" shows the place alone (Jules's note gives full role names;
  the mockup used hand-written short labels).

## Not done (and why) / needs Jules
- **Refresh from Orrama** (the ⋯ item that reruns Generate as a line-by-line diff): marked "Later"
  in the brief; not built.
- **Not tried with a real AI**: Write as me, Introduce me and Generate are tested against the fake
  provider (server tests) and the scratch install has no key. Worth one real try on the live app.
- Proof points whose source the note doesn't name and no project matches (e.g. "8 · Internship
  defence grade") take no lane colour. A `Source` column in the note fixes it.
- `pnpm --dir apps/web test:slow` (one run, all DOM tests): 648/649; the one red was
  `entity/EntityPage.dom.test.tsx` "works-at picker", which passes alone under the slow config
  (20/20) and isn't touched here.
- The vault's project note (`04-Projects/persona.md`) wasn't updated from this chat (build chats
  don't write the vault): Control's sync should add the Log line.

## Files touched outside my ownership
- `CLAUDE.md`: one phrase, "persona (…)" in the Layout's route list (in 8177c1b), because
  `test/codebase-graph.test.ts` requires every route file named there (2F did the same for
  `backup`). The fuller CLAUDE.md text is above for the integrator. `codebase-graph.md` is
  regenerated in each commit.
- `apps/server/src/main.ts` (one route registered), `apps/server/src/routes/ai.ts` (get_persona,
  draft_email), `apps/server/src/agentWrites.ts`, `apps/server/src/mcpScope.ts`,
  `apps/mcp/src/tools.ts`, `apps/mcp/README.md`, `packages/schema/src/responses.ts`,
  `packages/core/package.json` (subpath export), `packages/core/src/index.ts`.
- `apps/web/src/App.tsx` (route, title, Ask seed), `AskPanel.tsx` (seed), `Mail.tsx` +
  `mail/compose.ts` (held draft), `people/People.tsx` (You row), `ui/router.ts` (`me` route),
  `ui/shell/Shell.tsx` (account menu, More row), `main.tsx` (stylesheet).
- Tests: `test/contract.test.ts`, `test/mcp-tools.test.ts`, `test/bundle.test.ts` (29),
  `apps/mcp/test/requests.test.ts`, `App.dom.test.tsx`, `ui/shell/clay.dom.test.tsx`,
  `AskPanel.dom.test.tsx`, `Mail.dom.test.tsx`, `people/People.dom.test.tsx`,
  `ui/router.test.ts`, `src/test/app-harness.tsx` (Me stub).

## How it was verified
- Tests: core persona 44, server persona 17, MCP requests 64 + server mcp-tools 59, contract 67,
  Me.dom 10, plus the touched web suites; one full typecheck + web lint + full suite at the end
  (numbers in the commit message).
- Sabotage: 23 sabotages over core, server, agent, MCP and web, each red, each file restored
  byte-identical (`sab.py`); S23 (bars by list order) was green at first and the story test was
  tightened to pin bars to their year's tick.
- Click-through on scratch (`~/basalt-scratch/ME`, Jules's note copied to
  `Personal/jules/persona-data.md`): hover lights and fades, bar → place → project → person (Open
  their page) → Back → Esc, an answer written into the scratch copy (the real vault untouched), the
  account menu in Paper and Clay, Work and Voice tabs, Write as me without AI, the empty state as
  Erin (who can't see Jules's persona).
- Screenshots in `~/basalt-scratch/ME-shots`: Overview Clay day/night and Paper day/night at
  1440 × 900, the phone (390 × 844, Paper), the empty state.
- Only checked in Chrome (the browser pane); not in WebKit.
