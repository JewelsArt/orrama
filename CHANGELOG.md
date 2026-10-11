# Changelog

What changed in each release of Basalt, newest first. The commit messages carry
the detail — the why, how it was verified, what was left out; this file is the
map. Releases are git tags (`v0.1.0`) on the commit that was shipped; how to cut
one is in CLAUDE.md, "Releases".

## [Unreleased]

### Added

- `pnpm --dir apps/server export`: everything that lives only in the database
  — accounts, team grants, task descriptions and comments, project settings,
  mail drafts, AI settings, tokens, webhooks, feeds, history — as a restorable
  snapshot plus a readable JSON with every secret left out.
- Settings → AI: **ChatGPT plan** — Sign in with ChatGPT, so a Plus or Pro plan
  runs the agent instead of an API key (from a browser on the Mac that runs
  Basalt). Your other provider's key stays stored for switching back.
- **Orrama, the new look (wave A of the redesign).** The app is called Orrama
  on screen — window title, sign-in, lock, first run, home-screen icon — on
  warm paper by day and night blue after dark, with Figtree type served by the
  app itself. The screens themselves are redrawn in the next waves; until then
  they keep their old layouts on the new colours.
- Every place and thing has an address: reload keeps your place, Back and
  Forward work, and links can be shared.
- The vault can now be read as a knowledge graph: a `#vault-ontology` note
  defines types, relations and statuses, and Basalt derives typed facts from
  front matter, `key:: value` fields, the `## People` section and
  `project/<key>` tags. The MCP server and the in-app agent get five query
  tools — vault_schema, find_entities, get_relations, find_path,
  list_summaries — that answer from the graph in a fraction of the tokens a
  search-and-read takes; descriptions tell a model to query first and read
  last. On the map, typed relations draw heavier (dashed when only implied),
  are named when you point at a note, and are listed in its readout; a
  Relations switch in the map settings turns them off.
- Settings → Signed in: **Sign out everywhere** ends every session, API token
  and Touch ID device, and clears the passcode and the calendar feed link.

### Changed

- The rail holds the eight places (Today, Planning, Notes, Orrery, Projects,
  People, Mail, Money) with Find, Ask Orr and your Orr at the foot. Reload,
  Dark and Back left it: use ⌘R, Settings → Appearance and the browser's Back.
- On a phone: a top bar and five tabs (Today, Planning, Ask Orr, Notes, More).
  More holds the other places and Settings.
- Number keys follow the rail: 1 Today, 2 Planning, 3 Notes, 4 Orrery,
  5 Projects, 6 People, 7 Mail, 8 Money. Press ? to see every key.
- Your avatar is one of eight Orrs. If you had picked a rock face, you see its
  Orr until you pick again.
- Dates read "Fri 9 Oct" and times use the 24-hour clock everywhere.
- New note asks for its path in a dialog, and says under the field what was
  wrong.

### Removed

- Plus Jakarta Sans and JetBrains Mono (loaded from Google Fonts).
- Glyph icons (✕ × ‹ › ✎ ↵) and keycaps on screen.
- Basalt no longer creates `.mcp.json` and `CLAUDE.md` in your vault on every
  start. Register the MCP server with `claude mcp add` instead (see
  `apps/mcp/README.md`); an old placeholder `.mcp.json` in the vault can be
  deleted.

### Fixed

- A request the server cannot read — malformed or empty JSON, an unsupported
  content type, an upload over the size limit — is answered with its 400, 413
  or 415 and Fastify's reason, not `500 internal error`, and no longer logged
  as a server crash.
- A note created together with its new folder is indexed. chokidar reads a
  new folder before it watches it, and on Linux (the Docker image) a note
  landing in between was missed until something else in that folder changed —
  10 of 10 in a probe. The server now looks at each new folder again a second
  later. macOS was not affected in practice.
- Tags in any alphabet: `#réunion` was filed as `r` and `#été` as no tag at
  all. Front-matter tags now follow the same rules as inline ones (a tag with a
  space or a dot in it is dropped), except an `only/…` tag, which stays so the
  note stays restricted.
- The note map works from the keyboard: Tab to it, arrow keys move between
  notes (shown and read out like a hover), Enter opens, + and − zoom, Esc
  lets go.
- Copies of a note in one folder are told apart in the file tree: a copy
  made outside Basalt keeps the original's title, so rows sharing a title
  also show their filename.
- A copied calendar note no longer doubles the events typed into it by hand.
- Note titles in the file tree sit on the left, next to their dot, instead of
  floating mid-row.
- A note Basalt has just created and that is deleted outside it a moment
  later leaves the list, instead of staying there until a restart.
- A slow answer can no longer overwrite a newer one: opening one note and
  then another quickly, flipping weeks in Planning, switching documents,
  Finance months or mail messages, and typing in search each cancel the
  request they replace.
- Saved Claude conversations (`type: claude-session`) are their own kind of
  note: still searchable and linkable, but their text no longer adds links,
  tags or tasks, and the map hides them unless "Conversations" is on.
- Colours like `#d93025` are no longer read as tags (only colours starting
  with a digit were kept out).
- A project without a `04-Projects/<slug>.md` no longer flips between two of
  its tagged notes: decisions, captures and people used to land in whichever
  note was "first" at that moment, and the page showed only one of them.
- Changing an emoji next to another one (🔴 → 🟢, 🔼 → 🔽, 😀 → 😃) in the
  editor no longer writes `��` into the note.
- Basalt no longer deletes a note's opening `---` block when that block is
  prose, a list or only comments; such a note is left as written.
- A note whose front matter has a YAML error (an unquoted colon), or whose
  `id:` is a number, keeps the same note id across edits, Obsidian saves and
  restarts — task comments, descriptions and assignees no longer come loose.
- Windows line endings are kept when Basalt adds an id or sets a property,
  and no `"\r"` is written into the last value.
- Adding an id or setting one property no longer reformats the rest of the
  front matter (long values folded, lists re-spaced), and a byte-order mark
  stays at the start of the file.
- A note saved in a legacy encoding (Windows-1252, UTF-16) is no longer
  rewritten with its accents destroyed. Basalt reads and indexes it, never
  writes to it, and says so (in the server log, and with a 409 on save) until
  it is saved as UTF-8.
- When an Obsidian edit to a note's last line and a Basalt append (quick
  capture, the agent) meet, the two lines stay separate instead of being
  joined into one.
- The server refuses to start when `BASALT_SECRET_KEY` or `BASALT_JWT_SECRET`
  is set but empty (it used to start and encrypt credentials under an empty
  key).
- `rotate-secret-key` now also re-encrypts the Sign in with ChatGPT
  credentials and webhook secrets, so rotating the key no longer quietly signs
  you out of your ChatGPT plan.
- "Spent in <month>" on the Finance tab now counts rent paid by transfer and
  nets returned purchases, so it matches the month page and the Dashboard.
- A merchant's page nets refunds against the purchases they refund, and no
  longer counts a refund as money arriving.
- With a Savings pocket in the export, the balance trend, burn, runway and the
  savings plan follow the current account instead of whichever pocket moved
  last.
- The month a statement starts inside is no longer counted as a complete
  month; months between two exports are no longer averaged over; a covered
  month with nothing spent counts as €0.
- A category's "Monthly average" leaves out the month in progress, and its
  counts leave out salary, top-ups and fully refunded purchases.
- A subscription matched as `=ns` or without accents ("pathe" for "PATHÉ")
  shows its charges on its own card and is no longer offered under "Looks
  recurring".
- The savings page's money in no longer drops when one month has a large
  transfer; "Average month in/out" now add up to what is left over.
- With three months of history the savings plan can show headroom;
  "Committed" and "Discretionary" are the typical month's own figures.
- The Finance top cards and the Dashboard compare a month against the same
  typical as the month page they open.
- Ledger totals in different currencies are shown side by side ("€19.66 ·
  US$12.00") instead of added into one euro figure.
- A hand-typed `balance: 1.234,56` in the finance note reads as 1,234.56, not
  1.234.
- ⌘← and ⌘[ no longer pull you out of a note, or throw away a mail draft,
  while you type.
- One broken page no longer blanks the whole window, and ⌘R still reloads.
- Starting or reloading in the light theme no longer flashes dark first.
- ⌘K opened from Settings appears on top; Escape closes the top overlay and
  only that one; Find and capture are proper dialogs.
- After the server restarts, open pages catch up by themselves; reconnects
  back off; a session ended elsewhere stops retrying.
- The app no longer goes blank when the browser refuses storage.

### Security

- The 4-digit quick-unlock passcode can no longer be brute-forced by sending
  many guesses at once; at most ten are ever checked before the password is
  required.
- Sending many sign-in or sign-up attempts at once no longer slips past the
  "five wrong passwords, then wait" limit, and a refused attempt no longer
  costs a password hash. Sign-up is rate-limited too.
- Basalt only answers requests addressed to `localhost`, `127.0.0.1`, `[::1]`
  or a host in `BASALT_PUBLIC_ORIGINS`, so a web page you visit cannot reach
  it by re-pointing its own name at your machine (DNS rebinding).
- An API token can no longer turn itself into a full session or manage
  credentials. It is refused on passcode, Touch ID, sessions, tokens,
  webhooks, mail sending and the mail account, the calendar feed link, and all
  workspace/AI settings.
- Changing the openai-compatible base URL in Settings → AI now needs the API
  key typed again, so the stored key cannot be redirected to another server.
- The mail account's IMAP/SMTP server must be a public address (or listed in
  `BASALT_FETCH_ALLOW`), and a failed connection no longer reports the remote
  error text.
- Changing your password signs you out everywhere — every session, API token
  and Touch ID device — and clears the passcode and the calendar feed link.
- The Touch ID sign-in no longer reveals which email addresses have an
  account or a passkey, and the password sign-in takes as long for an unknown
  address as for a wrong password.
- Webhook signing secrets are now stored encrypted, like the other
  credentials.

### Internal

- Every answer the web app reads has one schema (`packages/schema/src/responses.ts`)
  and a contract test that checks the real server against it.
- Unauthenticated Touch ID challenges are cleaned up and capped; live-sync
  frames are capped at 16 KiB.
- Removed the unused `summary.avgSpend`, `summary.inPerMonth/outPerMonth` and
  `spending.fixed/variable/matched` from `/api/finance`, and `splitFixed` from
  core.
- The design system lives in `apps/web/src/ui` (components, 70 line icons,
  Orr, the overlay stack, router, keys, dates, theme; every piece on `/dev/ui`
  in the dev server); `app.css` is split into one file per area under
  `apps/web/src/styles/`, and 68 dead classes are gone.
- Web tests get a DOM: happy-dom with Testing Library (`*.dom.test.tsx`).

### Upgrading

- The first start of this version encrypts every stored webhook secret and
  stamps the database as schema 3; an older build then refuses to open it, so
  take a database backup before shipping.
- Reaching Basalt by a bare LAN or tailnet IP now needs that address in
  `BASALT_PUBLIC_ORIGINS`.
- A Touch ID passkey created as non-discoverable (unlikely on macOS) needs
  enrolling again.

## [0.1.0] — 2026-10-01

The first tagged release: 120 commits from 3 July to 1 October 2026, running
daily as Jules's assistant on `~/Obsidian Vault`. Everything below is in it.

### The app

- **Notes on plain Markdown, shared live with Obsidian.** The vault folder is
  the store; a watcher takes in outside edits, and Basalt's own saves merge
  with them instead of overwriting (Yjs history per note). Live-preview editor,
  backlinks, tags, ranked accent-insensitive search, and a d3-force map sized
  by degree with a local view.
- **Dashboard** of deadlines, the week ahead, projects and last month's money.
- **Planning**: a week/month calendar of time blocks, events, dated tasks,
  milestones and charges; "Plan my week" proposes blocks it never writes
  itself. Blocks and events live in monthly calendar notes
  (`01-Me/Calendar/YYYY-MM.md`), and a task's status is its checkbox
  (`[ ]`, `[/]`, `[b]`, `[x]`).
- **Projects** bound by `project/<slug>` tags: one page per project with an
  Overview, a week-column Timeline, a Documents board (JSON Canvas) and a to-do
  grouped by the note's sections. A document reader for PDF, images, .docx,
  .xlsx and .pptx.
- **Contacts**: people and companies side by side, from `#contact` notes.
- **Mail**: a Gmail inbox over IMAP with an app password; the agent can draft
  mail but never send it.
- **Finance**: Revolut statements, payslips, subscriptions, income and an
  own-accounts list read from the vault; spending by category and merchant,
  typical months, refunds netted against their purchase, a savings plan
  drawn from your own months.
- **Ask**: an agent over the vault with your own provider key (Anthropic,
  Gemini or OpenAI-compatible), set under Settings → AI.
- **MCP server** so Claude Code can read projects, log decisions and draft mail.
- **Integrations**: ICS feeds in and out, personal API tokens, signed webhooks.
- **Runs as** a launchd agent on macOS (`pnpm ship`), a Docker image, or the
  Tauri desktop window; installable on a phone.

### Since the September 2026 engineering audit

- **Data safety.** Malformed front matter is never rewritten; YAML comments
  survive a rewrite; vault writes are atomic (temp file, fsync, rename); an edit
  the watcher has not delivered yet is merged, not erased; nothing in the vault
  can stop the server booting; a note copied outside Basalt gets its own id
  instead of taking over the original's; deleting the database and
  re-indexing brings back task status, time blocks and events.
- **Security.** The server refuses to boot on the shipped secrets; CORS is
  closed; a Content-Security-Policy on every page; sign-in throttled; sessions
  are rows that sign-out and Settings can end; no tokens or search terms in the
  request log, which is owner-only and rotates at 5 MB; Finance follows the
  folder ACL; task, date and block changes need edit; a front-matter tag cannot
  become a filesystem path; calendar feeds and webhooks cannot reach the
  server's own network; SMTP never logs in without TLS; .docx HTML is rebuilt
  from an allowlist; Touch ID trusts only known origins; four real people
  removed from the repository.
- **Correctness.** One money parser (thousands separators no longer read
  1,000× too small), one `typicalMonth()`, one local-date module; the RRULE
  expander, the savings model, refund netting, subscription anchors and
  statement ordering corrected; first-run registration makes exactly one owner.
- **Operations.** CI on every push (Ubuntu and macOS); a schema version stamp
  and a test that the two schema definitions agree; environment validated at
  boot; graceful SIGTERM; the boot waits for the vault watcher; a bounded Y.Doc
  cache and a compacted, paginated history.

### Upgrading to 0.1.0

- The database moves to **schema 2** (a `sessions` table). Older builds refuse
  a schema-2 database: going back means restoring a backup taken before.
- **Every device signs in once** after the upgrade: tokens from before sessions
  existed are refused.
- AI settings moved from the old Admin screen, which is gone, to
  **Settings → AI**.

[Unreleased]: https://github.com/JewelsArt/Basalt-backup/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JewelsArt/Basalt-backup/releases/tag/v0.1.0
